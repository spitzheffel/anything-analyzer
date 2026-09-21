/**
 * 跨轮 tool 侧态：只记录“已拉取过哪些请求”，不把正文永久写入 chat history。
 */

export interface ToolSessionSnapshot {
  fetchedSeqs: number[];
  recentRefs: string[];
  updatedAt: number;
}

const store = new Map<string, ToolSessionSnapshot>();
const MAX_RECENT_REFS = 12;
/** 侧态说明里最多列这么多序号：这段会进每一轮追问的提示词，不能跟着会话一起涨 */
export const MAX_NOTE_SEQS = 60;

export function toolSessionKey(sessionId: string, reportId?: string | null): string {
  return `${sessionId}::${reportId ?? "default"}`;
}

export function getToolSessionState(sessionId: string, reportId?: string | null): ToolSessionSnapshot {
  const key = toolSessionKey(sessionId, reportId);
  const existing = store.get(key);
  if (existing) return { ...existing, fetchedSeqs: [...existing.fetchedSeqs], recentRefs: [...existing.recentRefs] };
  return { fetchedSeqs: [], recentRefs: [], updatedAt: 0 };
}

export function recordToolSessionActivity(
  sessionId: string,
  reportId: string | null | undefined,
  fetchedSeqs: number[],
  refLine: string,
): ToolSessionSnapshot {
  const key = toolSessionKey(sessionId, reportId);
  const prev = store.get(key) ?? { fetchedSeqs: [], recentRefs: [], updatedAt: 0 };
  const seqSet = new Set(prev.fetchedSeqs);
  for (const seq of fetchedSeqs) {
    if (Number.isFinite(seq)) seqSet.add(seq);
  }
  const recentRefs = (refLine.trim()
    ? [...prev.recentRefs, refLine]
    : [...prev.recentRefs]
  ).slice(-MAX_RECENT_REFS);
  const next: ToolSessionSnapshot = {
    fetchedSeqs: [...seqSet].sort((a, b) => a - b),
    recentRefs,
    updatedAt: Date.now(),
  };
  store.set(key, next);
  return next;
}

export function clearToolSessionState(sessionId: string, reportId?: string | null): void {
  store.delete(toolSessionKey(sessionId, reportId));
}

/** 会话的抓包数据被清空时，它名下所有报告的侧态都过期了（序号指向的请求已经不在了） */
export function clearToolSessionsForSession(sessionId: string): void {
  const prefix = `${sessionId}::`;
  for (const key of [...store.keys()]) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

/** 注入到 messages 的紧凑侧态说明（无正文） */
export function buildToolStateNote(snapshot: ToolSessionSnapshot): string | null {
  if (snapshot.fetchedSeqs.length === 0 && snapshot.recentRefs.length === 0) return null;
  const lines = ["## 工具侧态（正文不在历史中；需要时重新 get_request_detail）"];
  if (snapshot.fetchedSeqs.length > 0) {
    // 只列尾部若干条并标注总数：漏掉的顶多让模型多调一次 get_request_detail
    const shown = snapshot.fetchedSeqs.slice(-MAX_NOTE_SEQS);
    const omitted = snapshot.fetchedSeqs.length - shown.length;
    const suffix = omitted > 0 ? `（共 ${snapshot.fetchedSeqs.length} 条，此处列出最后 ${shown.length} 条）` : "";
    lines.push(`已拉取详情的请求${suffix}: ${shown.map((s) => `#${s}`).join(", ")}`);
  }
  if (snapshot.recentRefs.length > 0) {
    lines.push("最近工具调用:");
    for (const ref of snapshot.recentRefs.slice(-6)) lines.push(`- ${ref}`);
  }
  return lines.join("\n");
}

/**
 * 从历史消息中恢复侧态（兼容旧 <tool_context> / 新 <tool_state>）。
 *
 * 传 knownSeqs 时只保留现在还取得到的序号。历史里的 <tool_state> 标记会把
 * 清掉的侧态重新带回来，而那些序号指向的请求可能已经被 data:clear 删了；
 * 侧态说的是"这些你已经拉过"，不该指向工具拿不到的东西。
 */
export function hydrateToolSessionFromHistory(
  sessionId: string,
  reportId: string | null | undefined,
  history: Array<{ role: string; content: string }>,
  knownSeqs?: ReadonlySet<number>,
): ToolSessionSnapshot {
  const seqs = new Set<number>(getToolSessionState(sessionId, reportId).fetchedSeqs);
  const refs: string[] = [...getToolSessionState(sessionId, reportId).recentRefs];

  for (const message of history) {
    if (message.role !== "assistant") continue;
    const stateMatch = message.content.match(/<tool_state>([\s\S]*?)<\/tool_state>/);
    if (stateMatch) {
      try {
        const parsed = JSON.parse(stateMatch[1]) as { fetchedSeqs?: number[]; recentRefs?: string[] };
        for (const seq of parsed.fetchedSeqs ?? []) {
          if (Number.isFinite(seq)) seqs.add(seq);
        }
        for (const ref of parsed.recentRefs ?? []) {
          if (ref) refs.push(ref);
        }
      } catch {
        /* ignore bad state */
      }
    }
    const ctxMatch = message.content.match(/<tool_context>([\s\S]*?)<\/tool_context>/);
    if (ctxMatch) {
      const body = ctxMatch[1];
      for (const line of body.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("[")) refs.push(trimmed.split("\n")[0]);
        const seqHits = trimmed.matchAll(/#(\d+)/g);
        for (const hit of seqHits) seqs.add(Number(hit[1]));
        const seqsArg = trimmed.match(/seqs?=([0-9,\s]+)/);
        if (seqsArg) {
          for (const part of seqsArg[1].split(",")) {
            const n = Number(part.trim());
            if (Number.isFinite(n)) seqs.add(n);
          }
        }
      }
    }
  }

  const next: ToolSessionSnapshot = {
    fetchedSeqs: [...seqs]
      .filter((seq) => knownSeqs === undefined || knownSeqs.has(seq))
      .sort((a, b) => a - b),
    recentRefs: refs.slice(-MAX_RECENT_REFS),
    updatedAt: Date.now(),
  };
  store.set(toolSessionKey(sessionId, reportId), next);
  return next;
}

/** 写入 assistant 回复的极简侧态（无正文） */
export function appendToolStateMarker(content: string, snapshot: ToolSessionSnapshot): string {
  if (snapshot.fetchedSeqs.length === 0 && snapshot.recentRefs.length === 0) return content;
  const payload = JSON.stringify({
    fetchedSeqs: snapshot.fetchedSeqs,
    recentRefs: snapshot.recentRefs.slice(-6),
  });
  // 去掉旧 marker，避免叠加膨胀
  const cleaned = content
    .replace(/\n*<tool_state>[\s\S]*?<\/tool_state>\s*$/g, "")
    .replace(/\n*<tool_context>[\s\S]*?<\/tool_context>\s*$/g, "");
  return `${cleaned}\n\n<tool_state>${payload}</tool_state>`;
}
