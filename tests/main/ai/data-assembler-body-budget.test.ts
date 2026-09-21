/**
 * 正文预算只属于"要内联进提示词"那一路。assemble 的产物同时喂给
 * get_request_detail / search_requests 和鉴权链推导，被削过就再也拿不回来。
 */
import { describe, expect, it } from "vitest";
import { DataAssembler } from "../../../src/main/ai/data-assembler";
import { handleGetRequestDetail, handleSearchRequests } from "../../../src/main/ai/request-tools";
import type { CapturedRequest } from "../../../src/shared/types";

/**
 * 单条约 10KB：远低于工具自己的 40000 字符上限，但 20 条加起来
 * 超过整会话 30000 token × 4 = 120000 字符的内联预算。
 */
function loginBody(): string {
  return JSON.stringify({
    access_token: "eyJhbGciOiJIUzI1NiJ9.QUJDREVGRw",
    refresh_token: "rt_0123456789abcdef",
    expires_in: 3600,
    profile: Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`field_${i}`, `value_${"x".repeat(30)}`]),
    ),
    signature_secret: "SIG_TAIL_MARKER",
  });
}

function request(sequence: number, body: string): CapturedRequest {
  return {
    id: `req-${sequence}`,
    session_id: "s1",
    sequence,
    timestamp: 1_000 + sequence,
    method: "POST",
    url: `https://api.example.com/v1/login/${sequence}`,
    request_headers: '{"content-type":"application/json"}',
    request_body: '{"u":"demo"}',
    status_code: 200,
    response_headers: '{"content-type":"application/json"}',
    response_body: body,
    content_type: "application/json",
    initiator: null,
    duration_ms: 10,
    is_streaming: false,
    is_websocket: false,
  };
}

function assembleSession(count: number) {
  const requests = Array.from({ length: count }, (_, i) => request(i + 1, loginBody()));
  const assembler = new DataAssembler(
    { findBySession: () => requests } as never,
    { findBySession: () => [] } as never,
    { findBySession: () => [] } as never,
  );
  return { assembler, data: assembler.assemble("s1"), rawLength: requests[0].response_body!.length };
}

describe("response body budget", () => {
  it("keeps full bodies in assemble, well past the inline budget", () => {
    const { data, rawLength } = assembleSession(20);

    // 会话总量远超 120000 字符的内联预算
    expect(rawLength * 20).toBeGreaterThan(120_000);
    for (const req of data.requests) {
      expect(req.responseBody).toHaveLength(rawLength);
      expect(req.responseBody).not.toContain("TRUNCATED");
    }
  });

  it("still derives the auth chain from every login, which needs the body to parse as JSON", () => {
    const { data } = assembleSession(20);
    const types = data.authChain.map((item) => item.credentialType);

    // 截断过的 JSON 一定 parse 不出来，被削掉的那些响应会整条从鉴权链里消失
    expect(types.filter((type) => type === "Bearer Token")).toHaveLength(20);
    expect(types.filter((type) => type === "Refresh Token")).toHaveLength(20);
  });

  it("serves the whole body to the tools, including matches near its end", () => {
    const { data } = assembleSession(20);
    const requestMap = new Map(data.requests.map((r) => [r.seq, r]));

    const detail = handleGetRequestDetail({ seq: 1, full: true }, requestMap);
    expect(detail.result).toContain("SIG_TAIL_MARKER");

    const search = handleSearchRequests({ query: "SIG_TAIL_MARKER" }, requestMap);
    expect(search.result).toContain("#1");
    expect(search.result).not.toContain("未找到");
  });

  it("budgetInlineBodies trims a copy and leaves the assembled data untouched", () => {
    const { assembler, data, rawLength } = assembleSession(20);

    const inline = assembler.budgetInlineBodies(data);

    expect(inline.requests.some((r) => r.responseBody!.includes("TRUNCATED"))).toBe(true);
    expect(inline.requests.every((r) => r.responseBody!.length <= rawLength)).toBe(true);
    // 原始数据不受影响：工具和搜索仍然看得到全文
    for (const req of data.requests) {
      expect(req.responseBody).toHaveLength(rawLength);
    }
  });

  it("gives the inline copy's streaming section the trimmed bodies too", () => {
    const requests = Array.from({ length: 20 }, (_, i) => ({
      ...request(i + 1, loginBody()),
      is_streaming: true,
      content_type: "text/event-stream",
    }));
    const assembler = new DataAssembler(
      { findBySession: () => requests } as never,
      { findBySession: () => [] } as never,
      { findBySession: () => [] } as never,
    );
    const data = assembler.assemble("s1");
    expect(data.streamingRequests.length).toBeGreaterThan(0);

    const inline = assembler.budgetInlineBodies(data);

    // streamingRequests 原本和 requests 指向同一批对象，副本没换掉就会内联全文
    expect(inline.streamingRequests.some((r) => r.responseBody!.includes("TRUNCATED"))).toBe(true);
    expect(data.streamingRequests.every((r) => !r.responseBody!.includes("TRUNCATED"))).toBe(true);
  });
});
