import { describe, expect, it } from "vitest";
import { buildHar, toHarEntry } from "../../src/shared/har-export";
import type { CapturedRequest } from "../../src/shared/types";

function request(overrides: Partial<CapturedRequest> = {}): CapturedRequest {
  return {
    id: "req-1",
    session_id: "s1",
    sequence: 12,
    timestamp: Date.UTC(2026, 8, 6, 10, 0, 0),
    method: "POST",
    url: "https://api.example.com/v1/login?next=%2Fhome&x=1",
    request_headers: JSON.stringify({ "Content-Type": "application/json", Cookie: "a=1; b=2", Authorization: "Bearer t" }),
    request_body: '{"u":"a"}',
    status_code: 200,
    response_headers: JSON.stringify({ "content-type": "application/json; charset=utf-8", "set-cookie": "sid=abc; Path=/; HttpOnly; Secure\nother=1; Domain=example.com" }),
    response_body: '{"ok":true}',
    content_type: "application/json",
    initiator: null,
    duration_ms: 123,
    is_streaming: 0 as unknown as boolean,
    is_websocket: 1 as unknown as boolean,
    source: "cdp",
    ...overrides,
  };
}

describe("toHarEntry", () => {
  it("maps a captured request to a HAR entry", () => {
    const entry = toHarEntry(request());
    expect(entry.startedDateTime).toBe("2026-09-06T10:00:00.000Z");
    expect(entry.time).toBe(123);
    expect(entry.timings).toEqual({ send: 0, wait: 123, receive: 0 });
    expect(entry.request.method).toBe("POST");
    expect(entry.request.queryString).toEqual([{ name: "next", value: "/home" }, { name: "x", value: "1" }]);
    expect(entry.request.cookies).toEqual([{ name: "a", value: "1" }, { name: "b", value: "2" }]);
    expect(entry.request.headers).toContainEqual({ name: "Authorization", value: "Bearer t" });
    expect(entry.request.postData).toEqual({ mimeType: "application/json", text: '{"u":"a"}' });
    expect(entry.request.bodySize).toBe(9);
    expect(entry.response.status).toBe(200);
    expect(entry.response.content).toEqual({ size: 11, mimeType: "application/json; charset=utf-8", text: '{"ok":true}' });
    expect(entry.response.cookies).toEqual([
      { name: "sid", value: "abc", path: "/", httpOnly: true, secure: true },
      { name: "other", value: "1", domain: "example.com" },
    ]);
    expect(entry._seq).toBe(12);
    expect(entry._streaming).toBe(false);
    expect(entry._websocket).toBe(true);
    expect(entry._source).toBe("cdp");
    expect(entry.comment).toBe("seq=#12");
  });

  it("degrades gracefully for pending requests with broken header JSON", () => {
    const entry = toHarEntry(request({
      request_headers: "not json",
      response_headers: null,
      response_body: null,
      request_body: null,
      status_code: null,
      duration_ms: null,
      content_type: null,
      source: undefined,
    }));
    expect(entry.time).toBe(-1);
    expect(entry.request.headers).toEqual([]);
    expect(toHarEntry(request({ timestamp: Number.NaN })).startedDateTime).toBe("1970-01-01T00:00:00.000Z");
    expect(entry.request.postData).toBeUndefined();
    expect(entry.response.status).toBe(0);
    expect(entry.response.content).toEqual({ size: 0, mimeType: "" });
    expect(entry._source).toBeUndefined();
  });
});

describe("buildHar", () => {
  it("emits a HAR 1.2 log sorted by sequence with creator and session comment", () => {
    const har = buildHar([request({ sequence: 5, id: "b" }), request({ sequence: 2, id: "a" })], {
      name: "demo",
      targetUrl: "https://example.com",
      appVersion: "3.6.63",
    });
    expect(har.log.version).toBe("1.2");
    expect(har.log.creator).toEqual({ name: "Anything Analyzer", version: "3.6.63" });
    expect(har.log.comment).toBe("session=demo; target=https://example.com");
    expect(har.log.entries.map((entry) => entry._seq)).toEqual([2, 5]);
  });
});
