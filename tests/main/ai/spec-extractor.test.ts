import { describe, expect, it } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { LLMProviderConfig, RequestSummary } from "../../../src/shared/types";
import { LLMRouter } from "../../../src/main/ai/llm-router";
import {
  buildSpecExtractionMessages,
  computeReportTokenBudget,
  extractProtocolSpec,
  MAX_REPORT_TOKENS,
  MIN_REPORT_TOKENS,
  truncateReportToTokenBudget,
} from "../../../src/main/ai/spec-extractor";
import { estimateTextTokens } from "../../../src/shared/token-estimate";
import { sampleSpec } from "../../shared/fixtures/protocol-spec.fixture";

type DoGenerate = NonNullable<MockLanguageModelV4["doGenerate"]>;
type GenerateResult = Awaited<ReturnType<DoGenerate>>;
type DoStream = NonNullable<MockLanguageModelV4["doStream"]>;
type StreamPart = Awaited<ReturnType<DoStream>>["stream"] extends ReadableStream<infer T> ? T : never;

const config: LLMProviderConfig = {
  name: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-test",
  model: "gpt-4o-mini",
  maxTokens: 8192,
};

const usage = {
  inputTokens: { total: 20, noCache: 20, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

function generateResult(text: string): GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage,
    warnings: [],
  } as unknown as GenerateResult;
}

function streamOf(text: string): StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: text },
    { type: "text-end", id: "t" },
    { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
  ] as StreamPart[];
}

const summaries: RequestSummary[] = [
  { seq: 3, method: "POST", url: "https://api.example.com/v1/login", status: 200, contentType: "application/json", timestamp: 1, bodyBytes: 40, responseBytes: 80, hasAuthHeader: false, isStreaming: false, hookCount: 0 },
  { seq: 7, method: "GET", url: "https://api.example.com/v1/users/1", status: 200, contentType: "application/json", timestamp: 2, bodyBytes: 0, responseBytes: 120, hasAuthHeader: true, isStreaming: false, hookCount: 0 },
];

describe("buildSpecExtractionMessages", () => {
  it("includes the report, the request index and rule-derived hints", () => {
    const messages = buildSpecExtractionMessages({
      reportContent: "# 报告\n登录 [#3]，资料 [#7]。",
      summaries,
      enrichment: {
        generatedAt: 0,
        requestCount: 2,
        sceneHints: [{ scene: "login", confidence: "high", evidence: "POST /login", relatedRequestIds: ["#3"] }],
        authChain: [{ source: "POST /v1/login 响应", credentialType: "Bearer Token", credential: "a...b", consumers: ["/v1/users/1"] }],
        storageDiff: { cookies: { added: {}, changed: {}, removed: [] }, localStorage: { added: {}, changed: {}, removed: [] }, sessionStorage: { added: {}, changed: {}, removed: [] } },
        streamingSeqs: [],
      },
      purpose: "reverse-api",
    });
    expect(messages[0].role).toBe("system");
    expect(messages[1].content).toContain("#3 POST https://api.example.com/v1/login");
    expect(messages[1].content).toContain("#7 GET https://api.example.com/v1/users/1");
    expect(messages[1].content).toContain("login [high]");
    expect(messages[1].content).toContain("Bearer Token");
    expect(messages[1].content).toContain("reverse-api");
    expect(messages[1].content).toContain("# 报告");
  });

  it("keeps cited seqs when the index is too long to inline", () => {
    const many: RequestSummary[] = Array.from({ length: 300 }, (_, i) => ({ ...summaries[0], seq: i + 1, url: `https://api.example.com/r/${i + 1}` }));
    const messages = buildSpecExtractionMessages({ reportContent: "见 [#250]", summaries: many, enrichment: null });
    expect(messages[1].content).toContain("#250 POST");
    expect(messages[1].content).toContain("#1 POST");
    expect(messages[1].content).not.toContain("#200 POST");
  });
});

describe("computeReportTokenBudget", () => {
  it("shrinks the report allowance for small context windows and caps it for large ones", () => {
    const small = computeReportTokenBudget({ ...config, maxTokens: 8192, contextBudget: { maxContextTokens: 32_000, autoContextWindow: false } });
    // 32000 - 8192 - 12000
    expect(small).toBe(11_808);
    const tiny = computeReportTokenBudget({ ...config, maxTokens: 8192, contextBudget: { maxContextTokens: 16_000, autoContextWindow: false } });
    expect(tiny).toBe(MIN_REPORT_TOKENS);
    const large = computeReportTokenBudget({ ...config, maxTokens: 8192, contextBudget: { maxContextTokens: 400_000, autoContextWindow: false } });
    expect(large).toBe(MAX_REPORT_TOKENS);
  });
});

describe("truncateReportToTokenBudget", () => {
  it("keeps short reports untouched", () => {
    expect(truncateReportToTokenBudget("短报告", 100)).toBe("短报告");
  });

  it("cuts Chinese-heavy reports by estimated tokens, not by a fixed char ratio", () => {
    const chinese = "登录接口返回的令牌会写入本地存储，随后每个请求都在头部携带。".repeat(400);
    const truncated = truncateReportToTokenBudget(chinese, 1_000);
    expect(truncated.endsWith("...[报告过长，已截断]")).toBe(true);
    expect(estimateTextTokens(truncated)).toBeLessThanOrEqual(1_000);
    // 中文按字符折算会保留得多得多；按 token 截后剩下的字符数明显少于 1000 * 2
    expect(truncated.length).toBeLessThan(2_000);
  });

  it("is applied when building the extraction prompt", () => {
    const messages = buildSpecExtractionMessages({
      reportContent: "x".repeat(40_000),
      summaries,
      enrichment: null,
      maxReportTokens: MIN_REPORT_TOKENS,
    });
    expect(messages[1].content).toContain("...[报告过长，已截断]");
    expect(messages[1].content.length).toBeLessThan(40_000);
  });
});

describe("extractProtocolSpec", () => {
  it("returns a validated spec via native structured output and drops unknown seqs", async () => {
    const model = new MockLanguageModelV4({ doGenerate: generateResult(JSON.stringify(sampleSpec)) });
    const router = new LLMRouter(config, undefined, undefined, undefined, { model });

    const result = await extractProtocolSpec(router, { reportContent: "报告", summaries, enrichment: null });

    expect(result.degraded).toBe(false);
    expect(result.spec.scene).toBe("login");
    // 999 不在索引里，应被过滤掉
    expect(result.spec.endpoints[1].exampleSeqs).toEqual([7]);
    expect(result.promptTokens).toBe(20);
    expect(result.completionTokens).toBe(10);
    expect(model.doGenerateCalls.length).toBe(1);
    // 结构化输出走的是 response format / json schema
    expect(model.doGenerateCalls[0].responseFormat?.type).toBe("json");
  });

  it("falls back to plain completion + manual JSON parsing when native structured output fails", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: generateResult("这不是 JSON"),
      doStream: { stream: simulateReadableStream({ chunks: streamOf("好的，结果如下：\n```json\n" + JSON.stringify(sampleSpec) + "\n```") }) },
    });
    const router = new LLMRouter(config, undefined, undefined, undefined, { model });

    const result = await extractProtocolSpec(router, { reportContent: "报告", summaries, enrichment: null });

    expect(result.degraded).toBe(true);
    expect(result.spec.endpoints.map((e) => e.id)).toEqual(["login", "get-profile"]);
    expect(model.doStreamCalls.length).toBe(1);
    const lastMessage = model.doStreamCalls[0].prompt.at(-1) as { role: string; content: Array<{ text: string }> };
    expect(lastMessage.role).toBe("user");
    expect(lastMessage.content[0].text).toContain("只输出一个 JSON 对象");
    // 降级路径必须把 schema 告诉模型，否则它不知道字段
    expect(lastMessage.content[0].text).toContain("JSON Schema");
    expect(lastMessage.content[0].text).toContain('"specVersion"');
  });

  it("throws a readable error when even the fallback is not valid against the schema", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: generateResult("nope"),
      doStream: { stream: simulateReadableStream({ chunks: streamOf('{"specVersion": 1, "scene": 5}') }) },
    });
    const router = new LLMRouter(config, undefined, undefined, undefined, { model });

    await expect(extractProtocolSpec(router, { reportContent: "报告", summaries, enrichment: null }))
      .rejects.toThrow(/结构化输出不符合 schema/);
  });
});
