import type { AiRequestLogData } from "@shared/types";

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** 10 分钟：中转服务可能很慢，用户可手动取消 */
export const DEFAULT_LLM_TIMEOUT_MS = 600_000;
const RESPONSE_BODY_LOG_LIMIT = 100_000;
const ERROR_BODY_LOG_LIMIT = 10_000;

export interface LLMRequestLogSink {
  /** 拿到响应头（或请求失败）时写入一条日志，返回日志 id */
  onRequestComplete?: (log: AiRequestLogData) => number | void;
  /** 流式响应 body 读完后回填正文与总耗时 */
  onResponseBody?: (logId: number, body: string, durationMs: number) => void;
  /** 每次 HTTP 请求按发起顺序回调一次，用于把 step usage 对齐到日志行 */
  onRequestLogged?: (logId: number | undefined, log: AiRequestLogData) => void;
}

export interface LoggingFetchOptions extends LLMRequestLogSink {
  /** 合并进 JSON 请求体的透传参数（浅合并，覆盖同名字段） */
  extraBody?: Record<string, unknown>;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

/**
 * 去掉会让中间代理 JSON 解析失败的控制字符（保留 \n \r \t）。
 */
export function sanitizeForJson(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\uFFFD]/g, "");
  }
  if (Array.isArray(obj)) return obj.map(sanitizeForJson);
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = sanitizeForJson(value);
    }
    return result;
  }
  return obj;
}

/**
 * "Bearer sk-1234567890abcdef" → "Bearer sk-****cdef"
 */
export function maskSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const masked = { ...headers };
  for (const key of Object.keys(masked)) {
    const lower = key.toLowerCase();
    if (lower === "authorization" || lower === "x-api-key" || lower === "api-key") {
      masked[key] = masked[key].replace(/(\w{2,4})\w{4,}(\w{4})/, "$1****$2");
    }
  }
  return masked;
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  if (!headers) return record;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      record[key] = value;
    });
    return record;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) record[key] = value;
    return record;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) record[key] = String(value);
  }
  return record;
}

function resolveUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export function hostOf(url: string | undefined): string {
  if (!url) return "unknown";
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** extraBody 不允许覆盖的字段：改了它们 SDK 就解析不了响应 */
const PROTECTED_BODY_KEYS: ReadonlySet<string> = new Set(["stream", "stream_options"]);

function prepareBody(body: BodyInit | null | undefined, extraBody?: Record<string, unknown>): BodyInit | null | undefined {
  if (typeof body !== "string") return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return body;
  const original = parsed as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...original };
  if (extraBody) {
    for (const [key, value] of Object.entries(extraBody)) {
      if (PROTECTED_BODY_KEYS.has(key)) continue;
      merged[key] = value;
    }
  }
  return JSON.stringify(sanitizeForJson(merged));
}

function isEventStream(response: Response, requestBody: string): boolean {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) return true;
  return /"stream"\s*:\s*true/.test(requestBody);
}

/**
 * 将底层网络错误转换为用户可理解的诊断信息。
 */
export function diagnoseNetworkError(err: Error, url: string, timeoutMs = DEFAULT_LLM_TIMEOUT_MS): string {
  const cause = (err as Error & { cause?: { message?: string; code?: string } }).cause;
  const msg = [err.message, cause?.message, cause?.code].filter(Boolean).join(" | ");
  const host = hostOf(url);

  if (err.name === "AbortError" || err.name === "TimeoutError" || msg.includes("aborted")) {
    return `连接超时：${host} 在 ${timeoutMs / 1000} 秒内未响应。请检查 API 地址是否正确，以及网络是否可达。`;
  }
  if (msg.includes("ENOTFOUND") || msg.includes("getaddrinfo")) {
    return `DNS 解析失败：无法解析 ${host}。请检查 API 地址拼写是否正确。`;
  }
  if (msg.includes("ECONNREFUSED")) {
    return `连接被拒绝：${host} 未在监听。如果使用本地中转服务，请确认该服务已启动。`;
  }
  if (msg.includes("ECONNRESET") || msg.includes("socket hang up")) {
    return `连接被重置：${host} 中断了连接。可能是代理服务器不稳定或 API 服务限流。`;
  }
  if (msg.includes("UNABLE_TO_VERIFY") || msg.includes("CERT_") || msg.includes("certificate") || msg.includes("SSL")) {
    return `SSL 证书错误：无法与 ${host} 建立安全连接。如果使用自签证书的中转服务，需配置 NODE_TLS_REJECT_UNAUTHORIZED=0 环境变量（不推荐用于生产环境）。`;
  }
  if (msg.includes("ENETUNREACH") || msg.includes("EHOSTUNREACH")) {
    return `网络不可达：无法连接到 ${host}。请检查网络连接。`;
  }
  if (msg.includes("fetch failed")) {
    const causeDetail = cause ? ` (${cause.code || cause.message || String(cause)})` : "";
    return `网络请求失败：无法连接到 ${host}${causeDetail}。常见原因：1) API 地址配置错误 2) 网络无法访问该地址（如需科学上网） 3) 本地中转服务未启动。`;
  }
  return `LLM 请求失败 (${host}): ${msg}`;
}

export class LLMRequestCancelledError extends Error {
  constructor() {
    super("LLM 请求已取消");
    this.name = "LLMRequestCancelledError";
  }
}

/**
 * 包装 fetch：请求体清洗 / extraBody 合并、首包超时、请求日志（含流式 body 回填）、网络错误诊断。
 * 传给 AI SDK provider 的 `fetch` 选项。
 */
export function createLoggingFetch(options: LoggingFetchOptions = {}): FetchLike {
  const {
    extraBody,
    timeoutMs = DEFAULT_LLM_TIMEOUT_MS,
    fetchImpl = fetch,
    onRequestComplete,
    onResponseBody,
    onRequestLogged,
  } = options;

  const logRequest = (log: AiRequestLogData): number | undefined => {
    const logId = onRequestComplete?.(log);
    const normalized = typeof logId === "number" ? logId : undefined;
    onRequestLogged?.(normalized, log);
    return normalized;
  };

  return async (input, init = {}) => {
    const url = resolveUrl(input);
    const method = (init.method ?? "POST").toUpperCase();
    const rawHeaders = headersToRecord(init.headers);
    const maskedHeaders = JSON.stringify(maskSensitiveHeaders(rawHeaders));
    const body = prepareBody(init.body, extraBody);
    const bodyText = typeof body === "string" ? body : "";
    const startTime = Date.now();

    const outerSignal = init.signal ?? undefined;
    const controller = new AbortController();
    let abortedByCaller = false;
    const abortFromCaller = (): void => {
      abortedByCaller = true;
      controller.abort(outerSignal?.reason);
    };
    if (outerSignal?.aborted) abortFromCaller();
    outerSignal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const detachCallerListener = (): void => outerSignal?.removeEventListener("abort", abortFromCaller);

    let response: Response;
    try {
      if (abortedByCaller) throw outerSignal?.reason ?? new LLMRequestCancelledError();
      response = await fetchImpl(url, { ...init, body, signal: controller.signal });
      if (!response || typeof response.ok !== "boolean") {
        throw new Error("fetch 未返回有效的 Response 对象");
      }
    } catch (err) {
      clearTimeout(timeout);
      detachCallerListener();
      const error = err instanceof Error ? err : new Error(String(err));
      const diagnosis = abortedByCaller ? new LLMRequestCancelledError().message : diagnoseNetworkError(error, url, timeoutMs);
      logRequest({
        request_url: url,
        request_method: method,
        request_headers: maskedHeaders,
        request_body: bodyText,
        status_code: null,
        response_headers: null,
        response_body: null,
        duration_ms: Date.now() - startTime,
        error: diagnosis,
      });
      if (abortedByCaller) throw outerSignal?.reason ?? new LLMRequestCancelledError();
      throw new Error(diagnosis);
    }
    clearTimeout(timeout);

    const responseHeaders = JSON.stringify(Object.fromEntries(response.headers.entries()));

    if (!response.ok) {
      detachCallerListener();
      const errorBody = await response.text().catch(() => "");
      logRequest({
        request_url: url,
        request_method: method,
        request_headers: maskedHeaders,
        request_body: bodyText,
        status_code: response.status,
        response_headers: responseHeaders,
        response_body: errorBody.slice(0, ERROR_BODY_LOG_LIMIT),
        duration_ms: Date.now() - startTime,
        error: `${response.status} ${errorBody.slice(0, 200)}`,
      });
      return new Response(errorBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    if (!response.body || !isEventStream(response, bodyText)) {
      detachCallerListener();
      const text = await response.text();
      logRequest({
        request_url: url,
        request_method: method,
        request_headers: maskedHeaders,
        request_body: bodyText,
        status_code: response.status,
        response_headers: responseHeaders,
        response_body: text.slice(0, RESPONSE_BODY_LOG_LIMIT),
        duration_ms: Date.now() - startTime,
        error: null,
      });
      return new Response(text, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    const logId = logRequest({
      request_url: url,
      request_method: method,
      request_headers: maskedHeaders,
      request_body: bodyText,
      status_code: response.status,
      response_headers: responseHeaders,
      response_body: "[streaming]",
      duration_ms: Date.now() - startTime,
      error: null,
    });

    const [forConsumer, forLog] = response.body.tee();
    void collectStreamForLog(forLog, RESPONSE_BODY_LOG_LIMIT)
      .then((collected) => {
        if (logId !== undefined) onResponseBody?.(logId, collected, Date.now() - startTime);
      })
      .catch(() => {
        /* 日志分支读取失败不影响主流程 */
      })
      .finally(detachCallerListener);

    return new Response(forConsumer, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

async function collectStreamForLog(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let collected = "";
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (truncated) continue;
      collected += decoder.decode(value, { stream: true });
      if (collected.length > limit) {
        collected = collected.slice(0, limit);
        truncated = true;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return truncated ? `${collected}\n...[truncated]` : collected;
}
