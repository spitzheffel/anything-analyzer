/**
 * 报告与 Spec 的「有据可查」机械校验。
 *
 * 只做能机械判断的三件事，不做 LLM 二次校验（不可靠且贵）：
 * 1. 报告正文引用了不存在的请求序号；
 * 2. Spec 条目一条证据序号都没有——sanitizeSpecReferences 会丢掉编造的序号但保留条目本身，
 *    所以「证据为空」正是「说不出依据」的状态；
 * 3. 端点的 urlTemplate 对不上任何抓到的请求。
 *
 * 结论是提示而不是判决：模板写法差异也可能造成 3，所以界面上按"存疑"呈现。
 */
import type { ProtocolSpec } from "./protocol-spec";
import { validateCitations } from "./citations";

export interface EvidenceGapEntry {
  kind: "authChain" | "storage" | "crypto";
  label: string;
}

export interface ReportEvidence {
  /** 报告正文引用了请求索引里不存在的序号 */
  unknownCitations: number[];
  /** 一条证据序号都没有的端点 id */
  endpointsWithoutEvidence: string[];
  /** urlTemplate 匹配不上任何抓到的请求的端点 id */
  endpointsNotInCapture: string[];
  /** 鉴权链 / 存储 / 加密里证据为空的条目 */
  entriesWithoutEvidence: EvidenceGapEntry[];
}

export interface EvidenceCheckRequest {
  seq: number;
  method: string;
  url: string;
}

export const EMPTY_REPORT_EVIDENCE: ReportEvidence = {
  unknownCitations: [],
  endpointsWithoutEvidence: [],
  endpointsNotInCapture: [],
  entriesWithoutEvidence: [],
};

export function countEvidenceGaps(evidence: ReportEvidence | null | undefined): number {
  if (!evidence) return 0;
  return (
    evidence.unknownCitations.length
    + evidence.endpointsWithoutEvidence.length
    + evidence.endpointsNotInCapture.length
    + evidence.entriesWithoutEvidence.length
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 去掉 query / hash 和结尾斜杠：模板和实际 URL 的查询串几乎不会一致，不该因此判定对不上 */
function pathKey(url: string): string {
  const withoutHash = url.split("#")[0];
  const withoutQuery = withoutHash.split("?")[0];
  return withoutQuery.replace(/\/+$/, "") || withoutQuery;
}

/** `https://h/v1/users/{id}` → 能匹配 `https://h/v1/users/42` 的正则 */
export function urlTemplateToRegExp(urlTemplate: string): RegExp | null {
  const key = pathKey(urlTemplate.trim());
  if (!key) return null;
  const literals = key.split(/\{[^}]*\}/g).map(escapeRegExp);
  try {
    return new RegExp(`^${literals.join("[^/?#]+")}$`, "i");
  } catch {
    return null;
  }
}

export function endpointMatchesCapture(
  endpoint: Pick<ProtocolSpec["endpoints"][number], "method" | "urlTemplate">,
  requests: EvidenceCheckRequest[],
): boolean {
  const pattern = urlTemplateToRegExp(endpoint.urlTemplate);
  // 模板本身不可用时不做判断，宁可漏报也不要误报
  if (!pattern) return true;
  const method = endpoint.method.trim().toUpperCase();
  return requests.some((request) => {
    if (method && request.method.trim().toUpperCase() !== method) return false;
    const full = pathKey(request.url);
    if (pattern.test(full)) return true;
    try {
      return pattern.test(pathKey(new URL(request.url).pathname));
    } catch {
      return false;
    }
  });
}

export function checkReportEvidence(input: {
  reportContent: string;
  spec: ProtocolSpec | null;
  requests: EvidenceCheckRequest[];
}): ReportEvidence {
  const { unknown } = validateCitations(input.reportContent, input.requests.map((request) => request.seq));
  const evidence: ReportEvidence = {
    unknownCitations: unknown,
    endpointsWithoutEvidence: [],
    endpointsNotInCapture: [],
    entriesWithoutEvidence: [],
  };
  if (!input.spec) return evidence;

  for (const endpoint of input.spec.endpoints) {
    const id = endpoint.id || endpoint.urlTemplate;
    if (endpoint.exampleSeqs.length === 0) evidence.endpointsWithoutEvidence.push(id);
    if (!endpointMatchesCapture(endpoint, input.requests)) evidence.endpointsNotInCapture.push(id);
  }
  for (const entry of input.spec.authChain) {
    if (entry.evidenceSeqs.length === 0) {
      evidence.entriesWithoutEvidence.push({ kind: "authChain", label: entry.credentialType });
    }
  }
  for (const entry of input.spec.storage) {
    if (entry.evidenceSeqs.length === 0) {
      evidence.entriesWithoutEvidence.push({ kind: "storage", label: `${entry.type}:${entry.key}` });
    }
  }
  for (const entry of input.spec.crypto) {
    if (entry.evidenceSeqs.length === 0) {
      evidence.entriesWithoutEvidence.push({ kind: "crypto", label: entry.algorithm });
    }
  }
  return evidence;
}

export function parseReportEvidenceJson(json: string | null | undefined): ReportEvidence | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<ReportEvidence>;
    if (!parsed || typeof parsed !== "object") return null;
    const numbers = (value: unknown): number[] =>
      Array.isArray(value) ? value.filter((item): item is number => typeof item === "number") : [];
    const strings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    return {
      unknownCitations: numbers(parsed.unknownCitations),
      endpointsWithoutEvidence: strings(parsed.endpointsWithoutEvidence),
      endpointsNotInCapture: strings(parsed.endpointsNotInCapture),
      entriesWithoutEvidence: Array.isArray(parsed.entriesWithoutEvidence)
        ? parsed.entriesWithoutEvidence.filter(
            (item): item is EvidenceGapEntry =>
              !!item && typeof item === "object"
              && typeof (item as EvidenceGapEntry).label === "string"
              && ["authChain", "storage", "crypto"].includes((item as EvidenceGapEntry).kind),
          )
        : [],
    };
  } catch {
    return null;
  }
}
