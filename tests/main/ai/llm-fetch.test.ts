import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiRequestLogData } from "../../../src/shared/types";
import {
  createLoggingFetch,
  diagnoseNetworkError,
  maskSensitiveHeaders,
  sanitizeForJson,
} from "../../../src/main/ai/llm-fetch";

afterEach(() => {
  vi.useRealTimers();
});

describe("sanitizeForJson", () => {
  it("strips control characters but keeps newlines and tabs", () => {
    expect(sanitizeForJson("a\u0000b\u0007c\nd\te\uFFFD")).toBe("abc\nd\te");
    expect(sanitizeForJson({ x: ["\u0001y"], n: 1 })).toEqual({ x: ["y"], n: 1 });
  });
});

describe("maskSensitiveHeaders", () => {
  it("masks bearer tokens and api keys, leaves other headers alone", () => {
    const masked = maskSensitiveHeaders({
      Authorization: "Bearer sk-1234567890abcdef",
      "x-api-key": "sk-ant-abcdefghijklmnop",
      "Content-Type": "application/json",
    });
    expect(masked.Authorization).not.toContain("1234567890");
    expect(masked.Authorization).toMatch(/\*\*\*\*/);
    expect(masked["x-api-key"]).toMatch(/\*\*\*\*/);
    expect(masked["Content-Type"]).toBe("application/json");
  });
});

describe("diagnoseNetworkError", () => {
  it("maps common failures to Chinese diagnostics", () => {
    const url = "https://relay.example.com/v1/chat/completions";
    expect(diagnoseNetworkError(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }), url)).toContain("连接被拒绝");
    expect(diagnoseNetworkError(Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }), url)).toContain("DNS 解析失败");
    expect(diagnoseNetworkError(Object.assign(new Error("fetch failed"), { cause: { message: "socket hang up" } }), url)).toContain("连接被重置");
    expect(diagnoseNetworkError(Object.assign(new Error("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } }), url)).toContain("SSL 证书错误");
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(diagnoseNetworkError(abort, url, 1000)).toContain("1 秒内未响应");
    expect(diagnoseNetworkError(new Error("weird"), url)).toBe("LLM 请求失败 (relay.example.com): weird");
  });
});

describe("createLoggingFetch", () => {
  it("merges extraBody, sanitizes the body and logs a masked non-streaming request", async () => {
    const inner = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const logs: AiRequestLogData[] = [];
    const logged: Array<number | undefined> = [];
    const fetchImpl = createLoggingFetch({
      fetchImpl: inner,
      extraBody: { top_k: 5 },
      onRequestComplete: (log) => {
        logs.push(log);
        return 9;
      },
      onRequestLogged: (id) => logged.push(id),
    });

    const response = await fetchImpl("https://api.test/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer sk-1234567890abcdef", "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi\u0000there" }] }),
    });

    expect(await response.json()).toEqual({ ok: true });
    const sent = JSON.parse(String((inner.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(sent.top_k).toBe(5);
    expect(sent.messages[0].content).toBe("hithere");
    expect(logs).toHaveLength(1);
    expect(logs[0].status_code).toBe(200);
    expect(logs[0].response_body).toBe('{"ok":true}');
    expect(JSON.parse(logs[0].request_headers).Authorization).not.toContain("1234567890");
    expect(logged).toEqual([9]);
  });

  it("never lets extraBody override stream / stream_options", async () => {
    const inner = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    const fetchImpl = createLoggingFetch({
      fetchImpl: inner,
      extraBody: { stream: false, stream_options: null, top_k: 1 },
    });

    await fetchImpl("https://api.test/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "m", stream: true, stream_options: { include_usage: true } }),
    });

    const sent = JSON.parse(String((inner.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(sent.stream).toBe(true);
    expect(sent.stream_options).toEqual({ include_usage: true });
    expect(sent.top_k).toBe(1);
  });

  it("returns the error body untouched for HTTP failures and logs the failure", async () => {
    const inner = vi.fn(async () => new Response("nope", { status: 500 }));
    const logs: AiRequestLogData[] = [];
    const fetchImpl = createLoggingFetch({ fetchImpl: inner, onRequestComplete: (log) => void logs.push(log) });

    const response = await fetchImpl("https://api.test/v1/x", { method: "POST", body: "{}" });

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("nope");
    expect(logs[0].error).toBe("500 nope");
  });

  it("tees streaming responses: consumer gets the full stream, log gets the body afterwards", async () => {
    const chunks = ["data: a\n\n", "data: b\n\n", "data: [DONE]\n\n"];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    const inner = vi.fn(async () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    const bodies: Array<[number, string]> = [];
    const fetchImpl = createLoggingFetch({
      fetchImpl: inner,
      onRequestComplete: () => 3,
      onResponseBody: (id, body) => bodies.push([id, body]),
    });

    const response = await fetchImpl("https://api.test/v1/x", { method: "POST", body: '{"stream":true}' });
    expect(await response.text()).toBe(chunks.join(""));
    await vi.waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual([3, chunks.join("")]);
  });

  it("aborts on timeout with a readable diagnosis", async () => {
    vi.useFakeTimers();
    const inner = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    }));
    const logs: AiRequestLogData[] = [];
    const fetchImpl = createLoggingFetch({
      fetchImpl: inner as unknown as typeof fetch,
      timeoutMs: 50,
      onRequestComplete: (log) => void logs.push(log),
    });

    const pending = fetchImpl("https://api.test/v1/x", { method: "POST", body: "{}" });
    const assertion = expect(pending).rejects.toThrow("连接超时");
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    expect(logs[0].error).toContain("连接超时");
  });
});
