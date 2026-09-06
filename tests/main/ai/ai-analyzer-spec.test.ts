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
};

vi.mock("../../../src/main/ai/llm-router", () => {
  class FakeRouter {
    async complete() {
      return { content: routerBehaviour.analysisText, promptTokens: 10, completionTokens: 5 };
    }
    async completeWithTools() {
      return { content: routerBehaviour.analysisText, promptTokens: 10, completionTokens: 5 };
    }
    async completeStructured() {
      if (!routerBehaviour.structured) throw new Error("structured not configured");
      const output = await routerBehaviour.structured();
      return { output, promptTokens: 3, completionTokens: 2, degraded: false };
    }
  }
  return { LLMRouter: FakeRouter, DEFAULT_MAX_TOOL_ROUNDS: 64 };
});

import { AiAnalyzer } from "../../../src/main/ai/ai-analyzer";

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

function makeAnalyzer() {
  const reports = new Map<string, AnalysisReport>();
  const requests = [request(1, "https://api.example.com/v1/login"), request(2, "https://api.example.com/v1/me")];
  const repos = {
    sessionsRepo: { findById: () => ({ id: "s1", name: "demo", target_url: "https://example.com" }) },
    requestsRepo: {
      findBySession: vi.fn(() => requests),
      countBySession: () => requests.length,
    },
    jsHooksRepo: { findBySession: () => [] },
    storageSnapshotsRepo: { findBySession: () => [] },
    reportsRepo: {
      insert: (report: AnalysisReport) => { reports.set(report.id, { ...report }); },
      findById: (id: string) => reports.get(id),
      findBySession: () => [...reports.values()],
      updateSpec: (id: string, specJson: string | null, specError: string | null) => {
        const existing = reports.get(id);
        if (existing) reports.set(id, { ...existing, spec_json: specJson, spec_error: specError });
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

beforeEach(() => {
  routerBehaviour.structured = null;
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
