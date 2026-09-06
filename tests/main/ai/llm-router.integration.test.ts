/**
 * 端到端：起一个本地 HTTP 服务模拟 OpenAI 兼容中转与 Anthropic 端点，
 * 走真实 fetch / SSE / tee / 工具循环，验证流式正文、思考块与日志回填。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AiProgressEvent, AiRequestLogData, LLMProviderConfig } from "../../../src/shared/types";
import { LLMRouter } from "../../../src/main/ai/llm-router";
import type { MCPToolInfo } from "../../../src/main/mcp/mcp-manager";

interface Captured {
  url: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

const captured: Captured[] = [];
let server: Server;
let baseUrl: string;

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function sse(res: ServerResponse, frames: Array<{ event?: string; data: unknown }>): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const frame of frames) {
    if (frame.event) res.write(`event: ${frame.event}\n`);
    res.write(`data: ${typeof frame.data === "string" ? frame.data : JSON.stringify(frame.data)}\n\n`);
  }
  res.end();
}

function chatChunk(delta: Record<string, unknown>, finish: string | null = null, usage?: Record<string, number>) {
  return {
    id: "chatcmpl-it",
    object: "chat.completion.chunk",
    created: 1,
    model: "relay-model",
    choices: usage ? [] : [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  };
}

function handleChatCompletions(body: Record<string, unknown>, res: ServerResponse): void {
  const messages = body.messages as Array<{ role: string }>;
  // 结构化输出：非流式 JSON 响应，正文就是 schema 要求的对象
  if (body.response_format && body.stream !== true) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "chatcmpl-json",
      object: "chat.completion",
      created: 1,
      model: "relay-model",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ name: "login", tags: ["auth"] }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 33, completion_tokens: 8, total_tokens: 41 },
    }));
    return;
  }
  const hasToolResult = messages.some((m) => m.role === "tool");
  if (!hasToolResult && body.tools) {
    sse(res, [
      { data: chatChunk({ role: "assistant", reasoning_content: "先看一下 #7 的详情。" }) },
      { data: chatChunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_request_detail", arguments: "" } }] }) },
      { data: chatChunk({ tool_calls: [{ index: 0, function: { arguments: '{"seq":' } }] }) },
      { data: chatChunk({ tool_calls: [{ index: 0, function: { arguments: "7}" } }] }) },
      { data: chatChunk({}, "tool_calls") },
      { data: chatChunk({}, null, { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 }) },
      { data: "[DONE]" },
    ]);
    return;
  }
  sse(res, [
    { data: chatChunk({ role: "assistant", reasoning_content: "拿到了，开始写报告。" }) },
    { data: chatChunk({ content: "# 报告\n\n" }) },
    { data: chatChunk({ content: "请求 #7 是登录接口。" }) },
    { data: chatChunk({}, "stop") },
    { data: chatChunk({}, null, { prompt_tokens: 180, completion_tokens: 30, total_tokens: 210 }) },
    { data: "[DONE]" },
  ]);
}

function handleAnthropicMessages(_body: Record<string, unknown>, res: ServerResponse): void {
  sse(res, [
    { event: "message_start", data: { type: "message_start", message: { id: "msg_it", type: "message", role: "assistant", content: [], model: "claude-it", stop_reason: null, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 8 } } } },
    { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "考虑一下……" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    { event: "content_block_start", data: { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Anthropic " } } },
    { event: "content_block_delta", data: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "回复" } } },
    { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
    { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 9 } } },
    { event: "message_stop", data: { type: "message_stop" } },
  ]);
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const body = await readJson(req);
    captured.push({ url: req.url ?? "", headers: req.headers, body });
    if (req.url?.endsWith("/chat/completions")) return handleChatCompletions(body, res);
    if (req.url?.endsWith("/messages")) return handleAnthropicMessages(body, res);
    res.writeHead(404).end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

const detailTool: MCPToolInfo = {
  serverName: "builtin",
  name: "get_request_detail",
  description: "Read one captured request",
  inputSchema: { type: "object", properties: { seq: { type: "number" } }, required: ["seq"] },
};

describe("LLMRouter against a local OpenAI-compatible relay", () => {
  it("streams reasoning + text across a tool round and backfills logs", async () => {
    captured.length = 0;
    const config: LLMProviderConfig = {
      name: "custom",
      baseUrl,
      apiKey: "relay-key-abcdefgh12345678",
      model: "relay-model",
      maxTokens: 2048,
      generation: { reasoningEffort: "medium", extraBody: { top_k: 8 } },
    };
    const logs: AiRequestLogData[] = [];
    const usages: Array<[number, number, number]> = [];
    const bodies: Array<[number, string]> = [];
    let nextLogId = 1;
    const router = new LLMRouter(
      config,
      (log) => { logs.push(log); return nextLogId++; },
      (id, p, c) => usages.push([id, p, c]),
      (id, body) => bodies.push([id, body]),
    );
    const events: AiProgressEvent[] = [];

    const result = await router.completeWithTools(
      [{ role: "system", content: "你是分析器" }, { role: "user", content: "分析" }],
      [detailTool],
      async (name, args) => `tool:${name}:${JSON.stringify(args)}`,
      (e) => events.push(e),
    );

    expect(result.content).toBe("# 报告\n\n请求 #7 是登录接口。");
    expect(result.reasoning).toBe("先看一下 #7 的详情。拿到了，开始写报告。");
    expect(result.promptTokens).toBe(280);
    expect(result.completionTokens).toBe(42);

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("reasoning");
    expect(kinds).toContain("status");
    expect(kinds).toContain("text");
    expect(events.filter((e) => e.kind === "text").map((e) => e.text).join("")).toBe(result.content);
    expect(events.find((e) => e.kind === "status")?.text).toContain("get_request_detail");

    // two HTTP requests: tool round + final
    expect(captured).toHaveLength(2);
    expect(captured[0].url).toBe("/v1/chat/completions");
    expect(captured[0].headers.authorization).toBe(`Bearer ${config.apiKey}`);
    expect(captured[0].body.reasoning_effort).toBe("medium");
    expect(captured[0].body.top_k).toBe(8);
    expect(captured[0].body.stream).toBe(true);
    expect(Array.isArray(captured[0].body.tools)).toBe(true);
    const secondMessages = captured[1].body.messages as Array<{ role: string; content: string; tool_call_id?: string }>;
    const toolMsg = secondMessages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toBe('tool:get_request_detail:{"seq":7}');
    expect(toolMsg?.tool_call_id).toBe("call_1");

    // logs: one row per HTTP call, usage aligned, streaming body backfilled
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => l.response_body === "[streaming]")).toBe(true);
    expect(JSON.parse(logs[0].request_headers).authorization ?? JSON.parse(logs[0].request_headers).Authorization).not.toContain("abcdefgh12345678");
    expect(usages).toEqual([[1, 100, 12], [2, 180, 30]]);
    await vi.waitFor(() => expect(bodies).toHaveLength(2));
    expect(bodies.map(([id]) => id).sort()).toEqual([1, 2]);
    expect(bodies.find(([id]) => id === 2)?.[1]).toContain("登录接口");
  });
});

describe("LLMRouter.completeStructured against a local OpenAI-compatible relay", () => {
  it("asks a generic relay for json_object output with the schema in the prompt, and parses the object", async () => {
    captured.length = 0;
    const router = new LLMRouter({
      name: "custom",
      baseUrl,
      apiKey: "relay-key",
      model: "relay-model",
      maxTokens: 1024,
    });
    const schema = z.object({ name: z.string(), tags: z.array(z.string()).default([]) });

    const result = await router.completeStructured([{ role: "user", content: "抽取" }], schema);

    expect(result.output).toEqual({ name: "login", tags: ["auth"] });
    expect(result.degraded).toBe(false);
    expect(result.promptTokens).toBe(33);
    expect(result.completionTokens).toBe(8);
    expect(captured).toHaveLength(1);
    // 未知中转不假定支持 json_schema：SDK 退到更通用的 json_object，并把 schema 写进提示词
    const format = captured[0].body.response_format as { type: string };
    expect(format.type).toBe("json_object");
    const messages = captured[0].body.messages as Array<{ role: string; content: string }>;
    expect(messages.some((m) => /schema/i.test(m.content))).toBe(true);
    expect(captured[0].body.stream).not.toBe(true);
  });
});

describe("LLMRouter against a local Anthropic-style endpoint", () => {
  it("sends x-api-key + anthropic-version, streams thinking as reasoning and text as content", async () => {
    captured.length = 0;
    const config: LLMProviderConfig = {
      name: "minimax",
      baseUrl,
      apiKey: "mm-key-abcdefgh12345678",
      model: "MiniMax-M2.7",
      maxTokens: 1024,
      generation: { reasoningEffort: "low", fastMode: true },
    };
    const events: AiProgressEvent[] = [];
    const router = new LLMRouter(config);

    const result = await router.complete(
      [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
      (e) => events.push(e),
    );

    expect(result.content).toBe("Anthropic 回复");
    expect(result.reasoning).toBe("考虑一下……");
    expect(result.promptTokens).toBe(48); // input + cache read
    expect(result.completionTokens).toBe(9);
    expect(events.filter((e) => e.kind === "reasoning").map((e) => e.text).join("")).toBe("考虑一下……");

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("/v1/messages");
    expect(captured[0].headers["x-api-key"]).toBe(config.apiKey);
    expect(captured[0].headers["anthropic-version"]).toBeTruthy();
    // SDK 以 content block 数组形式发送 system（Anthropic 两种格式都接受）
    const system = captured[0].body.system as string | Array<{ type: string; text: string }>;
    expect(typeof system === "string" ? system : system.map((b) => b.text).join("")).toBe("sys");
    expect(captured[0].body.speed).toBe("fast");
    // 非 adaptive 模型上 reasoning 会被 SDK 换算成 budget thinking，并把 max_tokens 抬高到能容纳预算
    expect(captured[0].body.thinking).toMatchObject({ type: "enabled" });
    expect(captured[0].body.max_tokens as number).toBeGreaterThanOrEqual(1024);
    expect(captured[0].body.stream).toBe(true);
  });

  it("sends plain max_tokens and no thinking block when reasoning is off", async () => {
    captured.length = 0;
    const router = new LLMRouter({
      name: "anthropic",
      baseUrl,
      apiKey: "ant-key",
      model: "claude-sonnet-4-5",
      maxTokens: 1024,
    });

    await router.complete([{ role: "user", content: "hi" }]);

    expect(captured[0].body.max_tokens).toBe(1024);
    expect(captured[0].body.thinking).toBeUndefined();
    expect(captured[0].body.speed).toBeUndefined();
  });
});
