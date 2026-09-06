import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { z } from "zod";
import { APICallError, NoObjectGeneratedError } from "ai";
import type { AiProgressEvent, AiRequestLogData, LLMProviderConfig } from "../../../src/shared/types";
import {
  LLMRouter,
  extractJsonObjectText,
  isStructuredOutputShapeError,
  truncateTrailingToolResults,
} from "../../../src/main/ai/llm-router";
import type { MCPToolInfo } from "../../../src/main/mcp/mcp-manager";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

// @ai-sdk/provider 不是直接依赖，模型层类型统一从 ai/test 的 Mock 类推导
type DoStream = NonNullable<MockLanguageModelV4["doStream"]>;
type LanguageModelV4CallOptions = Parameters<DoStream>[0];
type LanguageModelV4StreamPart = Awaited<ReturnType<DoStream>>["stream"] extends ReadableStream<infer T> ? T : never;

const baseConfig: LLMProviderConfig = {
  name: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-test-1234567890abcdef",
  model: "gpt-4o",
  maxTokens: 4096,
};

const usage = (input: number, output: number, cacheRead = 0) => ({
  inputTokens: { total: input, noCache: input - cacheRead, cacheRead, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

function textStream(
  text: string,
  opts: { input?: number; output?: number; reasoning?: string; cacheRead?: number } = {},
): LanguageModelV4StreamPart[] {
  const parts: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];
  if (opts.reasoning) {
    parts.push({ type: "reasoning-start", id: "r1" });
    parts.push({ type: "reasoning-delta", id: "r1", delta: opts.reasoning });
    parts.push({ type: "reasoning-end", id: "r1" });
  }
  if (text) {
    parts.push({ type: "text-start", id: "t1" });
    for (const chunk of text.match(/.{1,4}/gs) ?? []) {
      parts.push({ type: "text-delta", id: "t1", delta: chunk });
    }
    parts.push({ type: "text-end", id: "t1" });
  }
  parts.push({
    type: "finish",
    finishReason: { unified: "stop", raw: "stop" },
    usage: usage(opts.input ?? 10, opts.output ?? 5, opts.cacheRead ?? 0),
  });
  return parts;
}

function toolCallStream(
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  opts: { input?: number; output?: number } = {},
): LanguageModelV4StreamPart[] {
  return [
    { type: "stream-start", warnings: [] },
    ...calls.map((call): LanguageModelV4StreamPart => ({
      type: "tool-call",
      toolCallId: call.id,
      toolName: call.name,
      input: JSON.stringify(call.input),
    })),
    {
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool_calls" },
      usage: usage(opts.input ?? 20, opts.output ?? 3),
    },
  ];
}

function mockModel(steps: LanguageModelV4StreamPart[][]): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doStream: steps.map((chunks) => ({ stream: simulateReadableStream({ chunks }) })),
  });
}

function collectEvents(): { events: AiProgressEvent[]; onEvent: (e: AiProgressEvent) => void } {
  const events: AiProgressEvent[] = [];
  return { events, onEvent: (e) => events.push(e) };
}

function joinText(events: AiProgressEvent[], kind: "text" | "reasoning" | "status"): string {
  return events
    .flatMap((e) => (e.kind === kind ? [e.text] : []))
    .join("");
}

const detailTool: MCPToolInfo = {
  serverName: "builtin",
  name: "get_request_detail",
  description: "Read one captured request",
  inputSchema: { type: "object", properties: { seq: { type: "number" } }, required: ["seq"] },
};

function promptOf(call: LanguageModelV4CallOptions): Array<{ role: string; content: unknown }> {
  return call.prompt as Array<{ role: string; content: unknown }>;
}

function sseResponse(lines: string[]): Response {
  const body = lines.join("\n") + "\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function openAIChatSse(text: string, opts: { reasoning?: string; promptTokens?: number; completionTokens?: number } = {}): Response {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-4o",
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}`;
  const lines: string[] = [];
  if (opts.reasoning) lines.push(chunk({ reasoning_content: opts.reasoning }), "");
  lines.push(chunk({ role: "assistant", content: text }), "");
  lines.push(chunk({}, "stop"), "");
  lines.push(
    `data: ${JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion.chunk",
      created: 1,
      model: "gpt-4o",
      choices: [],
      usage: {
        prompt_tokens: opts.promptTokens ?? 11,
        completion_tokens: opts.completionTokens ?? 7,
        total_tokens: (opts.promptTokens ?? 11) + (opts.completionTokens ?? 7),
      },
    })}`,
    "",
    "data: [DONE]",
  );
  return sseResponse(lines);
}

function anthropicSse(text: string, opts: { inputTokens?: number; cacheRead?: number; outputTokens?: number } = {}): Response {
  const ev = (event: string, data: Record<string, unknown>) => [`event: ${event}`, `data: ${JSON.stringify(data)}`, ""];
  return sseResponse([
    ...ev("message_start", {
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [],
        model: "MiniMax-M2",
        stop_reason: null,
        stop_sequence: null,
          usage: {
          input_tokens: opts.inputTokens ?? 12,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: opts.cacheRead ?? 0,
        },
          },
        }),
    ...ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    ...ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    ...ev("content_block_stop", { type: "content_block_stop", index: 0 }),
    ...ev("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: opts.outputTokens ?? 5 },
    }),
    ...ev("message_stop", { type: "message_stop" }),
  ]);
}

async function readBody(init: RequestInit | undefined): Promise<Record<string, unknown>> {
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

function headerOf(init: RequestInit | undefined, name: string): string | undefined {
  const headers = init?.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const entries = Array.isArray(headers) ? headers : Object.entries(headers);
  const hit = entries.find(([key]) => key.toLowerCase() === name.toLowerCase());
  return hit ? String(hit[1]) : undefined;
}

// ---------------------------------------------------------------------------
// behaviour (mock model)
// ---------------------------------------------------------------------------

describe("LLMRouter (behaviour via mock model)", () => {
  it("streams text deltas and returns aggregated content + usage", async () => {
    const model = mockModel([textStream("Hello, world!", { input: 30, output: 8 })]);
    const router = new LLMRouter(baseConfig, undefined, undefined, undefined, { model });
    const { events, onEvent } = collectEvents();

    const result = await router.complete([{ role: "user", content: "hi" }], onEvent);

    expect(result.content).toBe("Hello, world!");
    expect(result.promptTokens).toBe(30);
    expect(result.completionTokens).toBe(8);
    expect(joinText(events, "text")).toBe("Hello, world!");
    expect(events.some((e) => e.kind === "reasoning")).toBe(false);
  });

  it("forwards reasoning deltas as reasoning events and keeps them out of content", async () => {
    const model = mockModel([textStream("Answer", { reasoning: "Let me think." })]);
    const router = new LLMRouter(baseConfig, undefined, undefined, undefined, { model });
    const { events, onEvent } = collectEvents();

    const result = await router.complete([{ role: "user", content: "hi" }], onEvent);

    expect(result.content).toBe("Answer");
    expect(result.reasoning).toBe("Let me think.");
    expect(joinText(events, "reasoning")).toBe("Let me think.");
    expect(joinText(events, "text")).toBe("Answer");
  });

  it("passes system message as system and maps generation settings onto the call", async () => {
    const model = mockModel([textStream("ok")]);
      const config: LLMProviderConfig = {
        ...baseConfig,
      generation: { reasoningEffort: "high", temperature: 0.3 },
    };
    const router = new LLMRouter(config, undefined, undefined, undefined, { model });

      await router.complete([
      { role: "system", content: "You are a tester." },
      { role: "user", content: "hi" },
    ]);

    const call = model.doStreamCalls[0];
    expect(call.reasoning).toBe("high");
    expect(call.temperature).toBe(0.3);
    expect(call.maxOutputTokens).toBe(4096);
    const prompt = promptOf(call);
    expect(prompt[0].role).toBe("system");
    expect(prompt[0].content).toBe("You are a tester.");
    expect(prompt[1].role).toBe("user");
  });

  it("does not send reasoning when effort is none / unset", async () => {
    const model = mockModel([textStream("ok")]);
    const router = new LLMRouter(
      { ...baseConfig, generation: { reasoningEffort: "none" } },
      undefined,
      undefined,
      undefined,
      { model },
    );
    await router.complete([{ role: "user", content: "hi" }]);
    expect(model.doStreamCalls[0].reasoning).toBeUndefined();
    expect(model.doStreamCalls[0].temperature).toBeUndefined();
  });

  it("rejects when the model returns no text", async () => {
    const model = mockModel([textStream("")]);
    const router = new LLMRouter(baseConfig, undefined, undefined, undefined, { model });
    await expect(router.complete([{ role: "user", content: "hi" }])).rejects.toThrow("未返回正文内容");
  });

  it("rejects when the stream emits an error part", async () => {
    const model = mockModel([[
      { type: "stream-start", warnings: [] },
      { type: "error", error: new Error("upstream exploded") },
    ]]);
    const router = new LLMRouter(baseConfig, undefined, undefined, undefined, { model });
    await expect(router.complete([{ role: "user", content: "hi" }])).rejects.toThrow("upstream exploded");
  });

  it("rejects with a cancellation error when the signal is already aborted", async () => {
    const model = mockModel([textStream("late")]);
    const router = new LLMRouter(baseConfig, undefined, undefined, undefined, { model });
    const controller = new AbortController();
    controller.abort();
      await expect(
      router.complete([{ role: "user", content: "hi" }], undefined, controller.signal),
    ).rejects.toThrow();
    expect(model.doStreamCalls.length).toBe(0);
  });
});

describe("LLMRouter.completeWithTools (behaviour via mock model)", () => {
  it("runs the tool loop: executes tools by their real name, streams status, returns final text and summed usage", async () => {
    const model = mockModel([
      toolCallStream([{ id: "call_1", name: "get_request_detail", input: { seq: 7 } }], { input: 100, output: 4 }),
      textStream("Report done", { input: 150, output: 20 }),
    ]);
    const router = new LLMRouter(baseConfig, undefined, undefined, undefined, { model });
    const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => `detail for ${name}#${String(args.seq)}`);
    const { events, onEvent } = collectEvents();

    const result = await router.completeWithTools(
      [{ role: "system", content: "sys" }, { role: "user", content: "analyze" }],
      [detailTool],
      callTool,
      onEvent,
    );

    expect(callTool).toHaveBeenCalledWith("get_request_detail", { seq: 7 });
    expect(result.content).toBe("Report done");
    expect(result.promptTokens).toBe(250);
    expect(result.completionTokens).toBe(24);
    expect(joinText(events, "status")).toBe("🔧 调用工具: get_request_detail");

    // second step must contain the tool result as a tool message
    const second = promptOf(model.doStreamCalls[1]);
    const toolMsg = second.find((m) => m.role === "tool") as { content: Array<{ type: string; output: { type: string; value: unknown } }> };
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content[0].output.value).toBe("detail for get_request_detail#7");
  });

  it("normalizes tool names for the provider and maps them back when executing", async () => {
    const weird: MCPToolInfo = { ...detailTool, name: "server.tool/with:odd chars" };
    const model = mockModel([
      toolCallStream([{ id: "c1", name: "server_tool_with_odd_chars", input: {} }]),
      textStream("done"),
    ]);
    const router = new LLMRouter(baseConfig, undefined, undefined, undefined, { model });
    const callTool = vi.fn(async () => "ok");

    await router.completeWithTools([{ role: "user", content: "go" }], [weird], callTool);

    const exposed = Object.keys((model.doStreamCalls[0].tools ?? []).reduce<Record<string, true>>((acc, t) => {
      acc[(t as { name: string }).name] = true;
      return acc;
    }, {}));
    expect(exposed).toEqual(["server_tool_with_odd_chars"]);
    expect(callTool).toHaveBeenCalledWith("server.tool/with:odd chars", {});
  });

  it("feeds tool execution errors back to the model as text instead of failing", async () => {
    const model = mockModel([
      toolCallStream([{ id: "c1", name: "get_request_detail", input: { seq: 1 } }]),
      textStream("recovered"),
    ]);
    const router = new LLMRouter(baseConfig, undefined, undefined, undefined, { model });
    const callTool = vi.fn(async () => {
      throw new Error("boom");
    });

    const result = await router.completeWithTools([{ role: "user", content: "go" }], [detailTool], callTool);

    expect(result.content).toBe("recovered");
    const second = promptOf(model.doStreamCalls[1]);
    const toolMsg = second.find((m) => m.role === "tool") as { content: Array<{ output: { value: unknown } }> };
    expect(String(toolMsg.content[0].output.value)).toContain("Error: boom");
  });

  it("forces a final answer once maxRounds is reached: tools stay defined but toolChoice becomes none", async () => {
    const model = mockModel([
      toolCallStream([{ id: "c1", name: "get_request_detail", input: { seq: 1 } }]),
      textStream("final"),
    ]);
    const router = new LLMRouter(baseConfig, undefined, undefined, undefined, { model });

      const result = await router.completeWithTools(
      [{ role: "user", content: "go" }],
      [detailTool],
      async () => "r",
        undefined,
        1,
      );

    expect(result.content).toBe("final");
    expect(model.doStreamCalls[0].tools?.length).toBe(1);
    expect(model.doStreamCalls[0].toolChoice?.type ?? "auto").toBe("auto");
    const last = model.doStreamCalls[1];
    // Anthropic 要求历史含 tool_use 时 tools 必须仍然存在，所以只能靠 toolChoice 禁止调用
    expect(last.tools?.length).toBe(1);
    expect(last.toolChoice?.type).toBe("none");
  });

  it("keeps the text the model wrote before calling tools and joins it with the final step", async () => {
    const model = mockModel([
      [
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "t0" },
        { type: "text-delta", id: "t0", delta: "先看一下 #7。" },
        { type: "text-end", id: "t0" },
        { type: "tool-call", toolCallId: "c1", toolName: "get_request_detail", input: JSON.stringify({ seq: 7 }) },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: usage(5, 5) },
      ],
      textStream("结论：登录接口。"),
    ]);
    const router = new LLMRouter(baseConfig, undefined, undefined, undefined, { model });
    const { events, onEvent } = collectEvents();

    const result = await router.completeWithTools([{ role: "user", content: "go" }], [detailTool], async () => "r", onEvent);

    expect(result.content).toBe("先看一下 #7。\n\n结论：登录接口。");
    expect(joinText(events, "text")).toBe("先看一下 #7。结论：登录接口。");
  });

  it("truncates oversized tool results to the context budget before the next step", async () => {
    const huge = "x".repeat(200_000);
    const model = mockModel([
      toolCallStream([{ id: "c1", name: "get_request_detail", input: { seq: 1 } }]),
      textStream("done"),
    ]);
      const config: LLMProviderConfig = {
      ...baseConfig,
      contextBudget: { maxContextTokens: 16_000, compressionPeak: 0.85, compressionTarget: 0.55 },
    };
    const router = new LLMRouter(config, undefined, undefined, undefined, { model });

    await router.completeWithTools([{ role: "user", content: "go" }], [detailTool], async () => huge);

    const second = promptOf(model.doStreamCalls[1]);
    const toolMsg = second.find((m) => m.role === "tool") as { content: Array<{ output: { value: string } }> };
    const value = toolMsg.content[0].output.value;
    expect(value.length).toBeLessThan(huge.length);
    expect(value).toContain("tool result truncated");
  });
});

describe("LLMRouter.completeStructured (behaviour via mock model)", () => {
  const schema = z.object({ name: z.string(), tags: z.array(z.string()).default([]) });
  const generateResult = (text: string) => ({
    content: [{ type: "text" as const, text }],
    finishReason: { unified: "stop" as const, raw: "stop" },
    usage: usage(9, 4),
    warnings: [],
  });

  it("uses native structured output and reports usage", async () => {
    const model = new MockLanguageModelV4({ doGenerate: generateResult('{"name":"login","tags":["auth"]}') as never });
    const router = new LLMRouter(baseConfig, undefined, undefined, undefined, { model });

    const result = await router.completeStructured([{ role: "user", content: "extract" }], schema);

    expect(result.output).toEqual({ name: "login", tags: ["auth"] });
    expect(result.degraded).toBe(false);
    expect(result.promptTokens).toBe(9);
    expect(result.completionTokens).toBe(4);
    expect(model.doGenerateCalls[0].responseFormat?.type).toBe("json");
    // strict schema 在这一路被关掉，default/nullable 字段才能过
    expect((model.doGenerateCalls[0].providerOptions?.openai as Record<string, unknown> | undefined)?.strictJsonSchema).toBe(false);
  });

  it("falls back to a plain completion and applies schema defaults", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: generateResult("sorry, no json") as never,
      doStream: { stream: simulateReadableStream({ chunks: textStream('前言 {"name":"x"} 后记', { input: 5, output: 2 }) }) },
    });
    const router = new LLMRouter(baseConfig, undefined, undefined, undefined, { model });

    const result = await router.completeStructured([{ role: "user", content: "extract" }], schema);

    expect(result.output).toEqual({ name: "x", tags: [] });
    expect(result.degraded).toBe(true);
    // 两次调用的 usage 都算进去
    expect(result.promptTokens).toBe(9 + 5);
    expect(result.completionTokens).toBe(4 + 2);
  });

  it("rejects with a clear message when no JSON can be recovered", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: generateResult("nope") as never,
      doStream: { stream: simulateReadableStream({ chunks: textStream("still nothing") }) },
    });
    const router = new LLMRouter(baseConfig, undefined, undefined, undefined, { model });
    await expect(router.completeStructured([{ role: "user", content: "extract" }], schema)).rejects.toThrow("没有 JSON 对象");
  });

  it("does not waste a fallback call on auth / network failures", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({ message: "Unauthorized", url: "https://api.openai.com/v1/chat/completions", requestBodyValues: {}, statusCode: 401, responseBody: '{"error":"bad key"}' });
      },
      doStream: { stream: simulateReadableStream({ chunks: textStream('{"name":"x"}') }) },
    });
    const router = new LLMRouter(baseConfig, undefined, undefined, undefined, { model });

    await expect(router.completeStructured([{ role: "user", content: "extract" }], schema))
      .rejects.toThrow(/LLM 请求失败 \(api\.openai\.com\): 401/);
    expect(model.doStreamCalls.length).toBe(0);
  });

  it("does fall back when the provider rejects the response_format with 400", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({ message: "response_format not supported", url: "https://relay/v1/chat/completions", requestBodyValues: {}, statusCode: 400, responseBody: "{}" });
      },
      doStream: { stream: simulateReadableStream({ chunks: textStream('{"name":"y"}') }) },
    });
    const router = new LLMRouter(baseConfig, undefined, undefined, undefined, { model });

    const result = await router.completeStructured([{ role: "user", content: "extract" }], schema);
    expect(result.output).toEqual({ name: "y", tags: [] });
    expect(result.degraded).toBe(true);
  });
});

describe("isStructuredOutputShapeError", () => {
  it("classifies output-shape failures vs. everything else", () => {
    const api = (statusCode: number) => new APICallError({ message: "x", url: "https://h/", requestBodyValues: {}, statusCode, responseBody: "" });
    expect(isStructuredOutputShapeError(api(400))).toBe(true);
    expect(isStructuredOutputShapeError(api(422))).toBe(true);
    expect(isStructuredOutputShapeError(api(401))).toBe(false);
    expect(isStructuredOutputShapeError(api(429))).toBe(false);
    expect(isStructuredOutputShapeError(api(500))).toBe(false);
    expect(isStructuredOutputShapeError(new Error("网络请求失败"))).toBe(false);
    expect(isStructuredOutputShapeError(new NoObjectGeneratedError({ message: "no object", text: "x", response: { id: "r", timestamp: new Date(), modelId: "m" }, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, outputTokenDetails: { textTokens: 0, reasoningTokens: 0 } } as never, finishReason: "stop" as never }))).toBe(true);
  });
});

describe("extractJsonObjectText", () => {
  it("strips fences and surrounding prose", () => {
    expect(extractJsonObjectText("```json\n{\"a\":1}\n```")).toBe('{"a":1}');
    expect(extractJsonObjectText("看这里 {\"a\":{\"b\":2}} 结束")).toBe('{"a":{"b":2}}');
    expect(extractJsonObjectText("no braces")).toBeNull();
  });
});

describe("truncateTrailingToolResults", () => {
  it("returns undefined when there are no trailing tool messages", () => {
    expect(truncateTrailingToolResults([{ role: "user", content: "hi" }], (r) => r)).toBeUndefined();
  });

  it("rewrites only the trailing tool messages and keeps earlier ones intact", () => {
    const messages = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: [{ type: "tool-call" as const, toolCallId: "1", toolName: "t", input: {} }] },
      {
        role: "tool" as const,
        content: [
          { type: "tool-result" as const, toolCallId: "1", toolName: "t", output: { type: "text" as const, value: "long text" } },
          { type: "tool-result" as const, toolCallId: "2", toolName: "t", output: { type: "json" as const, value: { a: 1 } } },
        ],
      },
    ];
    const result = truncateTrailingToolResults(messages, (r) => r.map((s) => s.slice(0, 4)));
    expect(result).toBeDefined();
    const tool = result![2] as { content: Array<{ output: { type: string; value: string } }> };
    expect(tool.content[0].output).toEqual({ type: "text", value: "long" });
    expect(tool.content[1].output).toEqual({ type: "text", value: '{"a"' });
    expect(result![0]).toEqual(messages[0]);
  });
});

// ---------------------------------------------------------------------------
// wire level (real providers, spy fetch)
// ---------------------------------------------------------------------------

describe("LLMRouter (wire level via fetch spy)", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function routerWith(
    config: LLMProviderConfig,
    hooks: {
      onRequestComplete?: (log: AiRequestLogData) => number | void;
      onRequestUsage?: (logId: number, prompt: number, completion: number) => void;
      onResponseBody?: (logId: number, body: string, durationMs: number) => void;
    } = {},
  ): LLMRouter {
    return new LLMRouter(config, hooks.onRequestComplete, hooks.onRequestUsage, hooks.onResponseBody, {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
  }

  it("routes minimax to the Anthropic messages endpoint with x-api-key and parses the stream", async () => {
    fetchSpy.mockResolvedValueOnce(anthropicSse("Hi from MiniMax", { inputTokens: 40, cacheRead: 10, outputTokens: 6 }));
    const logs: AiRequestLogData[] = [];
    const usages: Array<[number, number, number]> = [];
    const router = routerWith(
      { ...baseConfig, name: "minimax", baseUrl: "https://api.minimax.io/anthropic/v1", model: "MiniMax-M2" },
      {
        onRequestComplete: (log) => {
          logs.push(log);
          return 42;
        },
        onRequestUsage: (id, p, c) => usages.push([id, p, c]),
      },
    );

    const result = await router.complete([{ role: "user", content: "hi" }]);

    expect(result.content).toBe("Hi from MiniMax");
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.minimax.io/anthropic/v1/messages");
    expect(headerOf(init, "x-api-key")).toBe(baseConfig.apiKey);
    const body = await readBody(init);
    expect(body.model).toBe("MiniMax-M2");
    expect(body.stream).toBe(true);
    // cache-read tokens are included in prompt tokens
    expect(result.promptTokens).toBe(50);
    expect(result.completionTokens).toBe(6);
    expect(usages).toEqual([[42, 50, 6]]);
    expect(logs[0].request_url).toBe(url);
    expect(logs[0].response_body).toBe("[streaming]");
    expect(JSON.parse(logs[0].request_headers)["x-api-key"]).not.toBe(baseConfig.apiKey);
  });

  it("routes openai apiType=responses to /responses", async () => {
    fetchSpy.mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    const router = routerWith({ ...baseConfig, apiType: "responses" });
    await expect(router.complete([{ role: "user", content: "hi" }])).rejects.toThrow("连接被拒绝");
    expect((fetchSpy.mock.calls[0] as [string])[0]).toBe("https://api.openai.com/v1/responses");
  });

  it("sends reasoning_effort, temperature and extraBody for OpenAI-compatible custom providers", async () => {
    fetchSpy.mockResolvedValueOnce(openAIChatSse("done"));
    const router = routerWith({
      ...baseConfig,
      name: "custom",
      baseUrl: "https://relay.example.com/v1/",
      model: "deepseek-reasoner",
      generation: { reasoningEffort: "high", temperature: 0.2, extraBody: { top_k: 40, model: "override-me" } },
    });

    await router.complete([{ role: "system", content: "sys" }, { role: "user", content: "hi" }]);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://relay.example.com/v1/chat/completions");
    const body = await readBody(init);
    expect(body.reasoning_effort).toBe("high");
    expect(body.temperature).toBe(0.2);
    expect(body.top_k).toBe(40);
    expect(body.model).toBe("override-me");
    expect(body.stream).toBe(true);
    expect((body.stream_options as Record<string, unknown>).include_usage).toBe(true);
    expect(headerOf(init, "authorization")).toBe(`Bearer ${baseConfig.apiKey}`);
  });

  it("surfaces reasoning_content from OpenAI-compatible streams as reasoning events", async () => {
    fetchSpy.mockResolvedValueOnce(openAIChatSse("final", { reasoning: "thinking hard" }));
    const router = routerWith({ ...baseConfig, name: "custom", baseUrl: "https://relay.example.com/v1" });
    const { events, onEvent } = collectEvents();

    const result = await router.complete([{ role: "user", content: "hi" }], onEvent);

    expect(result.content).toBe("final");
    expect(joinText(events, "reasoning")).toBe("thinking hard");
    expect(result.reasoning).toBe("thinking hard");
  });

  it("maps fastMode to anthropic speed and openai serviceTier", async () => {
    fetchSpy.mockResolvedValueOnce(anthropicSse("a"));
    await routerWith({ ...baseConfig, name: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-opus-4-6", generation: { fastMode: true } })
      .complete([{ role: "user", content: "hi" }]);
    expect((await readBody((fetchSpy.mock.calls[0] as [string, RequestInit])[1])).speed).toBe("fast");

    fetchSpy.mockResolvedValueOnce(openAIChatSse("b"));
    await routerWith({ ...baseConfig, generation: { fastMode: true } }).complete([{ role: "user", content: "hi" }]);
    expect((await readBody((fetchSpy.mock.calls[1] as [string, RequestInit])[1])).service_tier).toBe("fast");
  });

  it("uses anthropic budget thinking when thinkingBudgetTokens is set", async () => {
    fetchSpy.mockResolvedValueOnce(anthropicSse("a"));
    await routerWith({
      ...baseConfig,
        name: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
      model: "claude-sonnet-4-5",
      maxTokens: 16000,
      generation: { reasoningEffort: "high", thinkingBudgetTokens: 4096 },
    }).complete([{ role: "user", content: "hi" }]);
    const body = await readBody((fetchSpy.mock.calls[0] as [string, RequestInit])[1]);
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });

  it("logs HTTP failures and rejects with a readable message", async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Invalid API key" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    }));
    const logs: AiRequestLogData[] = [];
    const router = routerWith(baseConfig, { onRequestComplete: (log) => void logs.push(log) });

    await expect(router.complete([{ role: "user", content: "hi" }])).rejects.toThrow(/LLM 请求失败 \(api\.openai\.com\): 401/);
    expect(logs).toHaveLength(1);
    expect(logs[0].status_code).toBe(401);
    expect(logs[0].error).toContain("401");
  });

  it("logs network failures with a diagnosis", async () => {
    fetchSpy.mockRejectedValueOnce(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }));
    const logs: AiRequestLogData[] = [];
    const router = routerWith(baseConfig, { onRequestComplete: (log) => void logs.push(log) });

    await expect(router.complete([{ role: "user", content: "hi" }])).rejects.toThrow("DNS 解析失败");
    expect(logs[0].status_code).toBeNull();
    expect(logs[0].error).toContain("DNS 解析失败");
  });

  it("backfills the streamed response body into the log", async () => {
    fetchSpy.mockResolvedValueOnce(openAIChatSse("streamed"));
    const bodies: Array<[number, string]> = [];
    const router = routerWith(baseConfig, {
      onRequestComplete: () => 7,
      onResponseBody: (id, body) => bodies.push([id, body]),
    });

    await router.complete([{ role: "user", content: "hi" }]);
    await vi.waitFor(() => expect(bodies.length).toBe(1));

    expect(bodies[0][0]).toBe(7);
    expect(bodies[0][1]).toContain("streamed");
    expect(bodies[0][1]).toContain("[DONE]");
  });

  it("propagates caller aborts as a cancellation error", async () => {
    const controller = new AbortController();
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
    fetchSpy.mockImplementationOnce((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const fail = (): void => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      };
      if (init.signal?.aborted) return fail();
      init.signal?.addEventListener("abort", fail, { once: true });
      fetchStarted();
    }));
    const router = routerWith(baseConfig);

    const pending = router.complete([{ role: "user", content: "hi" }], undefined, controller.signal);
    await started;
    controller.abort();

    await expect(pending).rejects.toThrow("LLM 请求已取消");
  });

  it("rejects immediately when aborted before the request is sent", async () => {
    const controller = new AbortController();
    fetchSpy.mockImplementation(() => new Promise<Response>(() => { /* never resolves */ }));
    const router = routerWith(baseConfig);

    const pending = router.complete([{ role: "user", content: "hi" }], undefined, controller.signal);
    controller.abort();

    await expect(pending).rejects.toThrow("LLM 请求已取消");
  });
});
