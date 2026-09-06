import type { CapturedRequest } from "./types";

/**
 * HAR 1.2 导出（纯函数）。自定义字段按规范以 `_` 前缀标注：
 * `_seq`（请求序号，与报告引用一致）、`_streaming`、`_websocket`、`_source`。
 */

export interface HarNameValue {
  name: string;
  value: string;
}

export interface HarCookie extends HarNameValue {
  path?: string;
  domain?: string;
  httpOnly?: boolean;
  secure?: boolean;
}

export interface HarEntry {
  startedDateTime: string;
  time: number;
  request: {
    method: string;
    url: string;
    httpVersion: string;
    cookies: HarCookie[];
    headers: HarNameValue[];
    queryString: HarNameValue[];
    postData?: { mimeType: string; text: string };
    headersSize: number;
    bodySize: number;
  };
  response: {
    status: number;
    statusText: string;
    httpVersion: string;
    cookies: HarCookie[];
    headers: HarNameValue[];
    content: { size: number; mimeType: string; text?: string };
    redirectURL: string;
    headersSize: number;
    bodySize: number;
  };
  cache: Record<string, never>;
  timings: { send: number; wait: number; receive: number };
  comment?: string;
  _seq: number;
  _streaming: boolean;
  _websocket: boolean;
  _source?: string;
}

export interface HarLog {
  log: {
    version: "1.2";
    creator: { name: string; version: string };
    comment?: string;
    entries: HarEntry[];
  };
}

export interface HarSessionMeta {
  name?: string;
  targetUrl?: string;
  appVersion?: string;
}

function parseHeaderRecord(json: string | null | undefined): Record<string, string> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const record: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === undefined || value === null) continue;
      record[key] = Array.isArray(value) ? value.map(String).join("\n") : String(value);
    }
    return record;
  } catch {
    return {};
  }
}

function toNameValues(record: Record<string, string>): HarNameValue[] {
  return Object.entries(record).map(([name, value]) => ({ name, value }));
}

function findHeader(record: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function parseRequestCookies(cookieHeader: string | undefined): HarCookie[] {
  if (!cookieHeader) return [];
  return cookieHeader
    .split(";")
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const eq = pair.indexOf("=");
      return eq < 0 ? { name: pair, value: "" } : { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() };
    });
}

function parseSetCookies(setCookieHeader: string | undefined): HarCookie[] {
  if (!setCookieHeader) return [];
  // 多个 Set-Cookie 在抓包时可能被拼成一行（\n 分隔）；单条内部再按 ; 拆属性
  return setCookieHeader
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pair, ...attrs] = line.split(";").map((part) => part.trim());
      const eq = pair.indexOf("=");
      const cookie: HarCookie = eq < 0
        ? { name: pair, value: "" }
        : { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() };
      for (const attr of attrs) {
        const [rawKey, ...rest] = attr.split("=");
        const key = rawKey.trim().toLowerCase();
        const val = rest.join("=").trim();
        if (key === "path") cookie.path = val;
        else if (key === "domain") cookie.domain = val;
        else if (key === "httponly") cookie.httpOnly = true;
        else if (key === "secure") cookie.secure = true;
      }
      return cookie;
    });
}

function parseQueryString(url: string): HarNameValue[] {
  try {
    return [...new URL(url).searchParams.entries()].map(([name, value]) => ({ name, value }));
  } catch {
    return [];
  }
}

function byteLength(text: string | null | undefined): number {
  if (!text) return 0;
  return new TextEncoder().encode(text).byteLength;
}

function toBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1";
}

/** 非法时间戳不能让整份 HAR 导出失败，退回 epoch */
function toIsoDate(timestamp: unknown): string {
  const value = typeof timestamp === "number" ? timestamp : Number(timestamp);
  const date = new Date(Number.isFinite(value) ? value : 0);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function mimeTypeOf(headers: Record<string, string>, fallback: string | null | undefined): string {
  return findHeader(headers, "content-type") ?? fallback ?? "";
}

export function toHarEntry(request: CapturedRequest): HarEntry {
  const requestHeaders = parseHeaderRecord(request.request_headers);
  const responseHeaders = parseHeaderRecord(request.response_headers);
  const time = typeof request.duration_ms === "number" && request.duration_ms >= 0 ? request.duration_ms : -1;
  const requestBody = request.request_body ?? null;
  const responseBody = request.response_body ?? null;

  const entry: HarEntry = {
    startedDateTime: toIsoDate(request.timestamp),
    time,
    request: {
      method: request.method,
      url: request.url,
      httpVersion: "HTTP/1.1",
      cookies: parseRequestCookies(findHeader(requestHeaders, "cookie")),
      headers: toNameValues(requestHeaders),
      queryString: parseQueryString(request.url),
      headersSize: -1,
      bodySize: byteLength(requestBody),
    },
    response: {
      status: request.status_code ?? 0,
      statusText: "",
      httpVersion: "HTTP/1.1",
      cookies: parseSetCookies(findHeader(responseHeaders, "set-cookie")),
      headers: toNameValues(responseHeaders),
      content: {
        size: byteLength(responseBody),
        mimeType: mimeTypeOf(responseHeaders, request.content_type),
        ...(responseBody !== null ? { text: responseBody } : {}),
      },
      redirectURL: findHeader(responseHeaders, "location") ?? "",
      headersSize: -1,
      bodySize: byteLength(responseBody),
    },
    cache: {},
    timings: { send: 0, wait: time, receive: 0 },
    comment: `seq=#${request.sequence}`,
    _seq: request.sequence,
    _streaming: toBoolean(request.is_streaming),
    _websocket: toBoolean(request.is_websocket),
  };

  if (requestBody !== null && requestBody.length > 0) {
    entry.request.postData = {
      mimeType: mimeTypeOf(requestHeaders, null),
      text: requestBody,
    };
  }
  if (request.source) entry._source = request.source;
  return entry;
}

export function buildHar(requests: CapturedRequest[], meta: HarSessionMeta = {}): HarLog {
  const sorted = [...requests].sort((left, right) => left.sequence - right.sequence);
  const commentParts = [meta.name ? `session=${meta.name}` : null, meta.targetUrl ? `target=${meta.targetUrl}` : null].filter(Boolean);
  return {
    log: {
      version: "1.2",
      creator: { name: "Anything Analyzer", version: meta.appVersion ?? "unknown" },
      ...(commentParts.length > 0 ? { comment: commentParts.join("; ") } : {}),
      entries: sorted.map(toHarEntry),
    },
  };
}
