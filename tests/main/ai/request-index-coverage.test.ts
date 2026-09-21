/**
 * 索引只含通过相关性筛选的请求。以前提示词声称那就是全部，工具也确实取不到其余的。
 * 现在表头要如实说明差额，工具要能按序号把差额里的请求取出来。
 */
import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import type { AiProgressEvent, AnalysisReport, CapturedRequest, LLMProviderConfig } from "../../../src/shared/types";
import { PromptBuilder } from "../../../src/main/ai/prompt-builder";
import { handleGetRequestDetail } from "../../../src/main/ai/request-tools";
import { DataAssembler, toFilteredRequest } from "../../../src/main/ai/data-assembler";

vi.mock("electron", () => ({ app: { getPath: () => tmpdir() } }));

function row(sequence: number, overrides: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    id: `s1-${sequence}`,
    session_id: "s1",
    sequence,
    timestamp: 1_000 + sequence,
    method: "GET",
    url: `https://api.example.com/v1/item/${sequence}`,
    request_headers: "{}",
    request_body: null,
    status_code: 200,
    response_headers: '{"content-type":"application/json"}',
    response_body: '{"ok":true}',
    content_type: "application/json",
    initiator: null,
    duration_ms: 5,
    is_streaming: false,
    is_websocket: false,
    ...overrides,
  };
}

describe("index coverage is stated honestly", () => {
  const builder = new PromptBuilder();
  const summaries = [1, 2].map((seq) => ({
    seq, method: "GET", url: `https://api.example.com/v1/item/${seq}`,
    status: 200, contentType: "application/json", timestamp: 1_000 + seq,
    bodyBytes: 0, responseBytes: 11, hasAuthHeader: false, isStreaming: false, hookCount: 0,
  }));
  const data = { requests: [], storageDiff: {}, estimatedTokens: 0, sceneHints: [], streamingRequests: [], authChain: [], cryptoScripts: [] } as never;

  it("names the captured total and the excluded count in index-first mode", () => {
    const { user } = builder.build(data, "example.com", undefined, undefined, summaries, "index_first", 57);

    expect(user).toContain("共 2 条");
    expect(user).toContain("本次会话实际抓到 57 条");
    expect(user).toContain("另 55 条为静态资源或无正文 GET，未纳入索引");
    expect(user).toContain("get_request_detail 按序号点取");
  });

  it("stops claiming the legacy index holds every captured request", () => {
    const { user } = builder.build(data, "example.com", undefined, undefined, summaries, "legacy_inline", 57);

    // 旧表头这两句都是假的
    expect(user).not.toContain("包含被过滤的请求");
    expect(user).not.toContain("所有 2 条请求");
    expect(user).toContain("本次会话实际抓到 57 条");
  });

  it("says nothing about exclusions when there are none", () => {
    const { user } = builder.build(data, "example.com", undefined, undefined, summaries, "index_first", 2);
    expect(user).not.toContain("未纳入索引");
  });
});

describe("get_request_detail reaches requests the index excludes", () => {
  it("falls back to the capture data by seq, and marks what it served", () => {
    // #2 是 .js，相关性筛选会丢掉它；模型仍应能按序号看到它
    const rows = [row(1), row(2, { url: "https://cdn.example.com/app.js", content_type: "application/javascript", response_body: "var sign=1" })];
    const assembler = new DataAssembler(
      { findBySession: () => rows } as never,
      { findBySession: () => [] } as never,
      { findBySession: () => [] } as never,
    );
    const data = assembler.assemble("s1");
    expect(data.requests.map((r) => r.seq)).toEqual([1]);

    const requestMap = new Map(data.requests.map((r) => [r.seq, r]));
    const lookup = (seq: number) => {
      const found = rows.find((candidate) => candidate.sequence === seq);
      return found ? toFilteredRequest(found, []) : null;
    };

    const indexed = handleGetRequestDetail({ seq: 1 }, requestMap, lookup);
    expect(indexed.result).toContain("# 请求 #1");
    expect(indexed.result).not.toContain("未纳入分析索引");

    const excluded = handleGetRequestDetail({ seq: 2 }, requestMap, lookup);
    expect(excluded.result).toContain("var sign=1");
    expect(excluded.result).toContain("未纳入分析索引");
    expect(excluded.fetchedSeqs).toEqual([2]);

    const missing = handleGetRequestDetail({ seq: 99 }, requestMap, lookup);
    expect(missing.result).toContain("未找到序号为 99 的请求");
  });

  it("still reports not-found when no lookup is wired", () => {
    const result = handleGetRequestDetail({ seq: 2 }, new Map());
    expect(result.result).toContain("未找到序号为 2 的请求");
  });
});

describe("AiAnalyzer wires the lookup", () => {
  const rows = [row(1), row(2, { url: "https://cdn.example.com/app.js", content_type: "application/javascript", response_body: "var sign=1" })];

  async function makeRouter() {
    const { AiAnalyzer } = await import("../../../src/main/ai/ai-analyzer");
    let hookReads = 0;
    const analyzer = new AiAnalyzer(
      { findById: () => ({ id: "s1", name: "d", target_url: "https://example.com" }) } as never,
      {
        findBySession: () => rows,
        countBySession: () => rows.length,
        // id 由 capture-engine 生成为 `${sessionId}-${sequence}`
        findById: (id: string) => rows.find((candidate) => candidate.id === id),
      } as never,
      {
        findBySession: () => {
          hookReads += 1;
          return [];
        },
      } as never,
      { findBySession: () => [] } as never,
      { insert: () => {}, findById: () => undefined, findBySession: () => [], updateSpec: () => {} } as never,
      { insert: () => 1, updateTokensById: () => {}, updateResponseBodyById: () => {} } as never,
      { findBySession: () => [] } as never,
    );
    const callTool = (analyzer as unknown as {
      createBuiltinToolRouter: (
        sessionId: string,
        reportId: string | null,
        requestMap: Map<number, unknown>,
        summaries: unknown[],
      ) => (name: string, args: Record<string, unknown>) => Promise<string>;
    }).createBuiltinToolRouter("s1", null, new Map(), []);
    return { callTool, reads: () => hookReads };
  }

  it("resolves an unindexed seq through the deterministic row id", async () => {
    const { callTool } = await makeRouter();

    const found = await callTool("get_request_detail", { seq: 2 });
    expect(found).toContain("var sign=1");
    expect(found).toContain("未纳入分析索引");

    expect(await callTool("get_request_detail", { seq: 99 })).toContain("未找到序号为 99 的请求");
  });

  it("reads the hook table once per analysis, however many tools run", async () => {
    // js_hooks 的查询没有 LIMIT，一次调用最多补取 5 条请求，每条都重读整张表是不行的
    const { callTool, reads } = await makeRouter();

    await callTool("get_request_detail", { seqs: [1, 2] });
    await callTool("get_request_detail", { seq: 2 });
    await callTool("read_session_hooks", {});

    expect(reads()).toBe(1);
  });
});

// 让 TS 知道这些 import 被用到了
void ({} as AnalysisReport | AiProgressEvent | LLMProviderConfig | undefined);
