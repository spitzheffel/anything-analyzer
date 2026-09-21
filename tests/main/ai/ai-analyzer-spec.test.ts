/**
 * AiAnalyzer 的产物落库行为：purpose / enrichment 持久化、引用校验提示、
 * Spec 自动抽取成功 / 失败都不阻断报告、ensureSpec 补抽、初始对话消息。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import type { AiProgressEvent, AnalysisReport, CapturedRequest, LLMProviderConfig } from "../../../src/shared/types";
import { sampleSpec } from "../../shared/fixtures/protocol-spec.fixture";

vi.mock("electron", () => ({ app: { getPath: () => tmpdir() } }));

const routerBehaviour = {
  analysisText: "# 报告\n登录接口 [#1]，资料接口 [#2]，还有一个不存在的 [#99]。",
  structured: null as null | (() => Promise<unknown>),
  /** true 时工具循环一直挂着，只有 abort 能结束它 */
  hangUntilAborted: false,
  toolCalls: 0,
  lastToolSignal: undefined as AbortSignal | undefined,
  /** 非空时 complete() 返回它：analyze 流程里只有预过滤走 complete */
  completeText: null as string | null,
  lastToolMessages: undefined as Array<{ role: string; content: string }> | undefined,
};

vi.mock("../../../src/main/ai/llm-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/main/ai/llm-router")>();
  class FakeRouter {
    async complete() {
      return {
        content: routerBehaviour.completeText ?? routerBehaviour.analysisText,
        promptTokens: 10,
        completionTokens: 5,
      };
    }
    async completeWithTools(
      messages: Array<{ role: string; content: string }>,
      _tools: unknown,
      _callTool: unknown,
      _onEvent: unknown,
      _maxRounds: unknown,
      signal?: AbortSignal,
    ) {
      routerBehaviour.toolCalls += 1;
      routerBehaviour.lastToolMessages = messages;
      routerBehaviour.lastToolSignal = signal;
      if (routerBehaviour.hangUntilAborted) {
        return new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("LLM 请求已取消")), { once: true });
        });
      }
      return { content: routerBehaviour.analysisText, promptTokens: 10, completionTokens: 5 };
    }
    async completeStructured() {
      if (!routerBehaviour.structured) throw new Error("structured not configured");
      const output = await routerBehaviour.structured();
      return { output, promptTokens: 3, completionTokens: 2, degraded: false };
    }
  }
  return { ...actual, LLMRouter: FakeRouter };
});

import { AiAnalyzer } from "../../../src/main/ai/ai-analyzer";
import { clearToolSessionState, recordToolSessionActivity } from "../../../src/main/ai/tool-session-state";

const config: LLMProviderConfig = {
  name: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-test",
  model: "gpt-4o",
  maxTokens: 4096,
  contextBudget: { subagentEnabled: false },
};

function request(sequence: number, url: string): CapturedRequest {
  return {
    id: `req-${sequence}`,
    session_id: "s1",
    sequence,
    timestamp: 1_000 + sequence,
    method: "POST",
    url,
    request_headers: JSON.stringify({ "content-type": "application/json" }),
    request_body: '{"a":1}',
    status_code: 200,
    response_headers: JSON.stringify({ "content-type": "application/json" }),
    response_body: '{"access_token":"tok"}',
    content_type: "application/json",
    initiator: null,
    duration_ms: 10,
    is_streaming: false,
    is_websocket: false,
  };
}

function makeAnalyzer(requestCount?: number, extra: CapturedRequest[] = []) {
  const reports = new Map<string, AnalysisReport>();
  const requests = [
    ...(requestCount
      ? Array.from({ length: requestCount }, (_, i) => request(i + 1, `https://api.example.com/v1/r/${i + 1}`))
      : [request(1, "https://api.example.com/v1/login"), request(2, "https://api.example.com/v1/me")]),
    ...extra,
  ];
  const repos = {
    sessionsRepo: { findById: () => ({ id: "s1", name: "demo", target_url: "https://example.com" }) },
    requestsRepo: {
      findBySession: vi.fn(() => requests),
      countBySession: () => requests.length,
      findRefsBySession: () => requests.map((r) => ({ seq: r.sequence, method: r.method, url: r.url })),
    },
    jsHooksRepo: { findBySession: () => [] },
    storageSnapshotsRepo: { findBySession: () => [] },
    reportsRepo: {
      insert: (report: AnalysisReport) => { reports.set(report.id, { ...report }); },
      findById: (id: string) => reports.get(id),
      findBySession: () => [...reports.values()],
      updateSpec: (id: string, specJson: string | null, specError: string | null, evidenceJson: string | null = null) => {
        const existing = reports.get(id);
        if (existing) reports.set(id, { ...existing, spec_json: specJson, spec_error: specError, evidence_json: evidenceJson });
      },
    },
    aiRequestLogRepo: { insert: () => 1, updateTokensById: () => {}, updateResponseBodyById: () => {} },
    interactionEventsRepo: { findBySession: () => [] },
  };
  const analyzer = new AiAnalyzer(
    repos.sessionsRepo as never,
    repos.requestsRepo as never,
    repos.jsHooksRepo as never,
    repos.storageSnapshotsRepo as never,
    repos.reportsRepo as never,
    repos.aiRequestLogRepo as never,
    repos.interactionEventsRepo as never,
  );
  return { analyzer, reports, requests, repos };
}

const DEFAULT_ANALYSIS_TEXT = routerBehaviour.analysisText;

beforeEach(() => {
  routerBehaviour.structured = null;
  routerBehaviour.analysisText = DEFAULT_ANALYSIS_TEXT;
  routerBehaviour.hangUntilAborted = false;
  routerBehaviour.toolCalls = 0;
  routerBehaviour.lastToolSignal = undefined;
  routerBehaviour.completeText = null;
  routerBehaviour.lastToolMessages = undefined;
  // 失败路径会打一条预期内的 warn，别让它污染测试输出
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AiAnalyzer artifacts", () => {
  it("persists purpose + enrichment, extracts the spec and warns about unknown citations", async () => {
    routerBehaviour.structured = async () => sampleSpec;
    const { analyzer, reports } = makeAnalyzer();
    const events: AiProgressEvent[] = [];

    const report = await analyzer.analyze("s1", config, (e) => events.push(e), "reverse-api", {
      id: "reverse-api", name: "逆向", description: "", systemPrompt: "sys", requirements: "req", isBuiltin: true, isModified: false,
    });

    expect(report.purpose).toBe("reverse-api");
    expect(report.spec_error).toBeNull();
    expect(report.spec_json).not.toBeNull();
    expect(JSON.parse(report.spec_json!).scene).toBe("login");
    const enrichment = JSON.parse(report.enrichment_json!);
    expect(enrichment.requestCount).toBe(2);
    expect(enrichment.totalRequests).toBe(2);
    expect(Array.isArray(enrichment.authChain)).toBe(true);

    const stored = reports.get(report.id)!;
    expect(stored.spec_json).toBe(report.spec_json);

    const statusTexts = events.flatMap((e) => (e.kind === "status" ? [e.text] : []));
    expect(statusTexts.some((t) => t.includes("不存在的请求序号") && t.includes("#99"))).toBe(true);
    expect(statusTexts.some((t) => t.includes("正在抽取结构化数据"))).toBe(true);
  });

  it("keeps the report when spec extraction fails and records the error", async () => {
    routerBehaviour.structured = async () => { throw new Error("relay does not support json schema"); };
    const { analyzer, reports } = makeAnalyzer();

    const report = await analyzer.analyze("s1", config, undefined, undefined, undefined);

    expect(report.report_content).toContain("# 报告");
    expect(report.purpose).toBeNull();
    expect(report.spec_json).toBeNull();
    expect(report.spec_error).toContain("relay does not support");
    expect(reports.get(report.id)?.spec_error).toContain("relay does not support");
  });

  it("ensureSpec re-extracts a report that has no spec and returns the existing one otherwise", async () => {
    routerBehaviour.structured = async () => { throw new Error("first attempt fails"); };
    const { analyzer } = makeAnalyzer();
    const failed = await analyzer.analyze("s1", config);
    expect(failed.spec_json).toBeNull();

    routerBehaviour.structured = async () => sampleSpec;
    const fixed = await analyzer.ensureSpec(failed.id, config);
    expect(fixed.spec_json).not.toBeNull();
    expect(fixed.spec_error).toBeNull();

    routerBehaviour.structured = async () => { throw new Error("should not be called"); };
    const again = await analyzer.ensureSpec(failed.id, config);
    expect(again.spec_json).toBe(fixed.spec_json);
  });

  it("treats a cancel during extraction as 'spec not extracted' instead of failing the analysis", async () => {
    const controller = new AbortController();
    routerBehaviour.structured = async () => {
      controller.abort();
      throw new Error("aborted");
    };
    const { analyzer, reports } = makeAnalyzer();

    const report = await analyzer.analyze("s1", config, undefined, undefined, undefined, undefined, controller.signal);

    expect(report.report_content).toContain("# 报告");
    expect(report.spec_json).toBeNull();
    expect(report.spec_error).toBe("抽取已取消");
    expect(reports.get(report.id)?.spec_error).toBe("抽取已取消");
  });

  it("reuses the cached enrichment while the request count is unchanged and recomputes otherwise", async () => {
    routerBehaviour.structured = async () => sampleSpec;
    const { analyzer, requests, repos } = makeAnalyzer();
    await analyzer.analyze("s1", config);
    const findBySession = repos.requestsRepo.findBySession as ReturnType<typeof vi.fn>;
    findBySession.mockClear();

    const cached = analyzer.getSessionEnrichment("s1");
    expect(cached.totalRequests).toBe(2);
    // 命中缓存：不需要重新读取请求正文来组装
    expect(findBySession).not.toHaveBeenCalled();

    requests.push(request(3, "https://api.example.com/v1/logout"));
    const fresh = analyzer.getSessionEnrichment("s1");
    expect(fresh.totalRequests).toBe(3);
    expect(findBySession).toHaveBeenCalled();
  });

  it("builds the initial chat messages from the shared prompt with citation rule and request summary", () => {
    const { analyzer } = makeAnalyzer();
    const messages = analyzer.buildInitialChatMessages({ session_id: "s1", report_content: "# 报告" });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("引用规则");
    expect(messages[0].content).toContain("#1 POST /v1/login");
    expect(messages[1]).toEqual({ role: "assistant", content: "# 报告" });
  });
});

describe("AiAnalyzer.chat tool state", () => {
  it("does not tell the model it already fetched requests that no longer exist", async () => {
    const { analyzer } = makeAnalyzer();
    clearToolSessionState("s1", "r1");
    // #1 #2 还在；#77 是抓包数据被清掉之前留下的
    recordToolSessionActivity("s1", "r1", [1, 2, 77], "[get_request_detail](seqs=1,2,77)");

    await analyzer.chat("s1", config, [], "问题", undefined, "r1");

    const note = (routerBehaviour.lastToolMessages ?? []).map((m) => m.content).join("\n");
    expect(note).toContain("#1");
    expect(note).toContain("#2");
    expect(note).not.toContain("#77");
  });
});

describe("AiAnalyzer.chat cancellation", () => {
  it("aborts an in-flight follow-up through the caller's signal", async () => {
    routerBehaviour.hangUntilAborted = true;
    const { analyzer } = makeAnalyzer();
    const controller = new AbortController();

    const pending = analyzer.chat("s1", config, [], "问题", undefined, "r1", controller.signal);
    const settled = pending.then(() => null, (error: unknown) => error);
    await vi.waitFor(() => expect(routerBehaviour.lastToolSignal).toBeInstanceOf(AbortSignal));

    controller.abort();
    const error = await settled;

    expect(error).toBeInstanceOf(Error);
    // 取消要原样冒上去，不能被包装成"追问工具调用失败"
    expect((error as Error).message).toBe("LLM 请求已取消");
  });

  it("refuses a follow-up whose signal is already aborted, before spending a call", async () => {
    const { analyzer } = makeAnalyzer();
    const controller = new AbortController();
    controller.abort();

    await expect(
      analyzer.chat("s1", config, [], "问题", undefined, "r1", controller.signal),
    ).rejects.toThrow();
    expect(routerBehaviour.toolCalls).toBe(0);
  });
});

describe("AiAnalyzer pre-filter", () => {
  // legacy_inline 才走预过滤；250 条请求分成 3 批
  const inlineConfig = {
    ...config,
    contextBudget: { subagentEnabled: false, contextMode: "legacy_inline" as const },
  };

  it("accepts a filter reply that wraps its JSON array in prose", async () => {
    routerBehaviour.structured = async () => sampleSpec;
    routerBehaviour.completeText = "好的，相关请求如下：\n[1, 2, 3, 4, 5]\n\n这些是登录链路。";
    const { analyzer } = makeAnalyzer(250);
    const events: AiProgressEvent[] = [];

    await analyzer.analyze("s1", inlineConfig, (e) => events.push(e));
    const statuses = events.flatMap((e) => (e.kind === "status" ? [e.text] : []));

    expect(statuses.some((t) => t.includes("过滤完成") && t.includes("选出 5 条"))).toBe(true);
    expect(statuses.some((t) => t.includes("无法解析"))).toBe(false);
  });

  it("says so and keeps every request when the filter replies cannot be parsed", async () => {
    routerBehaviour.structured = async () => sampleSpec;
    routerBehaviour.completeText = "相关序号：1、2、3";
    const { analyzer } = makeAnalyzer(250);
    const events: AiProgressEvent[] = [];

    await analyzer.analyze("s1", inlineConfig, (e) => events.push(e));
    const statuses = events.flatMap((e) => (e.kind === "status" ? [e.text] : []));

    expect(statuses.some((t) => t.includes("3/3 批的回复无法解析"))).toBe(true);
    expect(statuses.some((t) => t.includes("过滤结果不可信"))).toBe(true);
    expect(statuses.some((t) => t.includes("过滤完成"))).toBe(false);
  });
});

describe("AiAnalyzer evidence check", () => {
  it("records claims it cannot back up, alongside the spec", async () => {
    // 报告引用了不存在的 #99（fixture 里只有 #1 #2）
    routerBehaviour.structured = async () => ({
      ...sampleSpec,
      endpoints: [
        { ...sampleSpec.endpoints[0], id: "ghost", method: "POST", urlTemplate: "https://api.example.com/v1/admin/wipe", exampleSeqs: [] },
      ],
    });
    const { analyzer, reports } = makeAnalyzer();

    const report = await analyzer.analyze("s1", config);

    const evidence = JSON.parse(report.evidence_json!);
    expect(evidence.unknownCitations).toEqual([99]);
    expect(evidence.endpointsWithoutEvidence).toEqual(["ghost"]);
    expect(evidence.endpointsNotInCapture).toEqual(["ghost"]);
    // 落库的那份要和返回的一致
    expect(reports.get(report.id)!.evidence_json).toBe(report.evidence_json);
  });

  it("still checks the report's citations when extraction failed", async () => {
    routerBehaviour.structured = async () => { throw new Error("relay refused"); };
    const { analyzer } = makeAnalyzer();

    const report = await analyzer.analyze("s1", config);

    expect(report.spec_error).toContain("relay refused");
    expect(JSON.parse(report.evidence_json!).unknownCitations).toEqual([99]);
  });

  it("stores nothing when every claim checks out", async () => {
    routerBehaviour.analysisText = "# 报告\n登录接口 [#1]，资料接口 [#2]。";
    routerBehaviour.structured = async () => ({ ...sampleSpec, endpoints: [], authChain: [], storage: [], crypto: [] });
    const { analyzer } = makeAnalyzer();

    const report = await analyzer.analyze("s1", config);

    expect(report.evidence_json).toBeNull();
  });
});

describe("requests the index excludes still count as evidence", () => {
  // #3 是 .js：相关性筛选把它挡在索引外，但它确实抓到了，模型也能用 get_request_detail 按序号点取。
  // 拿索引当全集去核对，就会在模型做了该做的事时误报，还会把真实的证据序号当编造的抹掉。
  const asset = (): CapturedRequest => ({
    ...request(3, "https://cdn.example.com/app.js"),
    method: "GET",
    request_body: null,
    content_type: "application/javascript",
    request_headers: "{}",
    response_headers: JSON.stringify({ "content-type": "application/javascript" }),
    response_body: "function sign(){}",
  });

  const assetEndpoint = {
    ...sampleSpec.endpoints[0],
    id: "sign-script",
    method: "GET",
    urlTemplate: "https://cdn.example.com/app.js",
    exampleSeqs: [3],
  };

  beforeEach(() => {
    routerBehaviour.analysisText = "# 报告\n签名逻辑见 [#3]。";
    routerBehaviour.structured = async () => ({
      ...sampleSpec,
      endpoints: [assetEndpoint],
      authChain: [],
      storage: [],
      crypto: [],
    });
  });

  it("keeps an unindexed seq as the endpoint's evidence instead of stripping it", async () => {
    const { analyzer } = makeAnalyzer(undefined, [asset()]);

    const report = await analyzer.analyze("s1", config);

    const spec = JSON.parse(report.spec_json!);
    expect(spec.endpoints[0].exampleSeqs).toEqual([3]);
  });

  it("does not accuse the report of citing a request that was captured", async () => {
    const { analyzer } = makeAnalyzer(undefined, [asset()]);
    const events: AiProgressEvent[] = [];

    const report = await analyzer.analyze("s1", config, (e) => events.push(e));

    expect(report.evidence_json).toBeNull();
    // 生成过程里那条瞬时提示同样不该冤枉 #3
    const statusTexts = events.flatMap((e) => (e.kind === "status" ? [e.text] : []));
    expect(statusTexts.some((t) => t.includes("不存在的请求序号"))).toBe(false);
  });

  it("still flags a seq that really was never captured", async () => {
    routerBehaviour.analysisText = "# 报告\n签名逻辑见 [#3]，另见 [#404]。";
    const { analyzer } = makeAnalyzer(undefined, [asset()]);

    const report = await analyzer.analyze("s1", config);

    expect(JSON.parse(report.evidence_json!).unknownCitations).toEqual([404]);
  });
});
