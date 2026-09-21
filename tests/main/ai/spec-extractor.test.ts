import { describe, expect, it } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { LLMProviderConfig, RequestSummary } from "../../../src/shared/types";
import { LLMRouter } from "../../../src/main/ai/llm-router";
import {
  buildSpecExtractionMessages,
  extractProtocolSpec,
  INDEX_MIN_LIMIT,
  INDEX_TOTAL_LIMIT,
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

  it("caps the index no matter how many seqs the report cites", () => {
    const many: RequestSummary[] = Array.from({ length: 1_000 }, (_, i) => ({ ...summaries[0], seq: i + 1, url: `https://api.example.com/r/${i + 1}` }));
    // 报告引用了 400 条：不设上限时索引会涨到 460 行，把 PROMPT_OVERHEAD_TOKENS 的预留撑爆
    const cited = Array.from({ length: 400 }, (_, i) => (i + 1) * 2);
    const reportContent = `# 报告\n${cited.map((seq) => `见 [#${seq}]`).join("\n")}`;

    const messages = buildSpecExtractionMessages({ reportContent, summaries: many, enrichment: null });
    const indexLines = messages[1].content.split("\n").filter((line) => /^#\d+ POST /.test(line));

    expect(indexLines).toHaveLength(INDEX_TOTAL_LIMIT);
    // 被引用的优先占位；挤不下时宁可丢头部，也不能丢报告真正引用到的行
    expect(messages[1].content).toContain("#2 POST");
    expect(messages[1].content).not.toContain("#1 POST ");
  });
});

describe("report budget is measured, not guessed", () => {
  const many: RequestSummary[] = Array.from({ length: 300 }, (_, i) => ({
    ...summaries[0], seq: i + 1, url: `https://api.example.com/v1/resource/${i + 1}?trace=${"x".repeat(40)}`,
  }));
  // 引用 200 条，索引会填到 INDEX_TOTAL_LIMIT；实测提示词骨架约 10k token
  const report = Array.from({ length: 200 }, (_, i) => `见 [#${i + 1}]`).join("\n")
    + "\n" + "登录接口返回的令牌会写入本地存储，随后每个请求都在头部携带。".repeat(2_000);

  function build(maxContextTokens: number, maxTokens: number) {
    return buildSpecExtractionMessages({
      reportContent: report, summaries: many, enrichment: null,
      extractConfig: { ...config, maxTokens, contextBudget: { maxContextTokens, autoContextWindow: false } },
    });
  }
  function indexLinesOf(messages: { content: string }[]): string[] {
    return messages[1].content.split("\n").filter((line) => /^#\d+ POST /.test(line));
  }
  function reportTokensOf(messages: { content: string }[]): number {
    return estimateTextTokens(messages[1].content.split("## 分析报告")[1] ?? "");
  }

  it("gives the report whatever the real window has left over, instead of a fixed reservation", () => {
    const big = build(400_000, 8_192);
    const tight = build(34_000, 8_192);

    // 大窗口够到 MAX_REPORT_TOKENS 的天花板；窗口小了报告就该跟着缩，而不是照常要 20k
    expect(reportTokensOf(big)).toBeGreaterThan(reportTokensOf(tight));
    expect(reportTokensOf(big)).toBeLessThanOrEqual(MAX_REPORT_TOKENS + 50);
    // 两边都必须真的装得进各自的窗口
    expect(estimateTextTokens(big[0].content + big[1].content)).toBeLessThan(400_000 - 8_192);
    expect(estimateTextTokens(tight[0].content + tight[1].content)).toBeLessThan(34_000 - 8_192);
    expect(indexLinesOf(tight)).toHaveLength(INDEX_TOTAL_LIMIT);
  });

  it("shrinks the index before giving up on a tight window", () => {
    const messages = build(14_000, 2_048);

    expect(indexLinesOf(messages).length).toBeLessThanOrEqual(INDEX_MIN_LIMIT);
    expect(reportTokensOf(messages)).toBeGreaterThanOrEqual(MIN_REPORT_TOKENS);
    expect(estimateTextTokens(messages[0].content + messages[1].content)).toBeLessThan(14_000 - 2_048);
  });

  it("says what to change when the window cannot fit the prompt at all", () => {
    // 以前这里会静默返回 3000，然后被服务端以 400 拒掉
    expect(() => build(8_000, 2_048)).toThrow(/抽取模型上下文窗口不足[\s\S]*lightweightModel/);
  });
});

describe("truncateReportToTokenBudget", () => {
  it("keeps short reports untouched", () => {
    expect(truncateReportToTokenBudget("短报告", 100)).toBe("短报告");
  });

  it("keeps the tail as well as the head — that is where the reproduction code lives", () => {
    const body = "登录接口返回的令牌会写入本地存储，随后每个请求都在头部携带。".repeat(400);
    const chinese = `开头标记${body}结尾标记`;

    const truncated = truncateReportToTokenBudget(chinese, 1_000);

    expect(truncated).toContain("开头标记");
    expect(truncated).toContain("结尾标记");
    expect(truncated).toContain("...[报告中段已省略，原文共");
    expect(estimateTextTokens(truncated)).toBeLessThanOrEqual(1_000);
    // 中文按字符折算会保留得多得多；按 token 裁后剩下的字符数明显少于 1000 * 2
    expect(truncated.length).toBeLessThan(2_000);
  });

  it("is applied when building the extraction prompt", () => {
    const messages = buildSpecExtractionMessages({
      reportContent: `HEAD-MARK${"x".repeat(40_000)}TAIL-MARK`,
      summaries,
      enrichment: null,
      maxReportTokens: MIN_REPORT_TOKENS,
    });
    expect(messages[1].content).toContain("...[报告中段已省略，原文共");
    expect(messages[1].content).toContain("HEAD-MARK");
    expect(messages[1].content).toContain("TAIL-MARK");
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
