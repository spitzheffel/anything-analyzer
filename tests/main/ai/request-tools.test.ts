import { describe, expect, it } from "vitest";
import type { FilteredRequest, RequestSummary } from "../../../src/shared/types";
import {
  dispatchBuiltinRequestTool,
  handleGetRequestDetail,
  handleListRequests,
  handleSearchRequests,
} from "../../../src/main/ai/request-tools";

function req(partial: Partial<FilteredRequest> & Pick<FilteredRequest, "seq" | "method" | "url">): FilteredRequest {
  return {
    headers: {},
    body: null,
    status: 200,
    responseHeaders: { "content-type": "application/json" },
    responseBody: null,
    hooks: [],
    timestamp: 1_700_000_000_000 + partial.seq * 1000,
    ...partial,
  };
}

function summary(partial: Partial<RequestSummary> & Pick<RequestSummary, "seq" | "method" | "url">): RequestSummary {
  return {
    status: 200,
    contentType: "application/json",
    timestamp: 1_700_000_000_000 + partial.seq * 1000,
    bodyBytes: 0,
    responseBytes: 0,
    hasAuthHeader: false,
    isStreaming: false,
    hookCount: 0,
    ...partial,
  };
}

describe("request tools", () => {
  const requests = [
    req({
      seq: 1,
      method: "POST",
      url: "https://api.example.com/login",
      headers: { Authorization: "Bearer abc" },
      body: '{"user":"a","password":"secret-token-xyz"}',
      responseBody: '{"access_token":"tok_123"}',
    }),
    req({
      seq: 2,
      method: "GET",
      url: "https://api.example.com/me",
      headers: { Authorization: "Bearer abc" },
      responseBody: '{"id":1}',
    }),
    req({
      seq: 3,
      method: "GET",
      url: "https://cdn.example.com/app.js",
      status: 304,
      responseBody: "console.log(1)",
    }),
  ];
  const map = new Map(requests.map((r) => [r.seq, r]));
  const summaries = [
    summary({ seq: 1, method: "POST", url: "https://api.example.com/login", hasAuthHeader: true, bodyBytes: 40, responseBytes: 30 }),
    summary({ seq: 2, method: "GET", url: "https://api.example.com/me", hasAuthHeader: true, responseBytes: 8 }),
    summary({ seq: 3, method: "GET", url: "https://cdn.example.com/app.js", status: 304 }),
  ];

  it("lists requests by method and url keyword", () => {
    const result = handleListRequests({ method: "get", url_contains: "api.example" }, summaries);
    expect(result.result).toContain("#2 GET");
    expect(result.result).not.toContain("#1 POST");
    expect(result.result).not.toContain("#3 GET https://cdn");
  });

  it("searches request bodies for keywords", () => {
    const result = handleSearchRequests({ query: "secret-token", in: ["body"] }, map);
    expect(result.result).toContain("#1");
    expect(result.result).toContain("[body]");
    expect(result.result).not.toContain("#2");
  });

  it("returns request details for batch seqs with truncation controls", () => {
    const longBody = "x".repeat(20_000);
    map.set(9, req({ seq: 9, method: "POST", url: "https://api.example.com/big", body: longBody }));
    const clipped = handleGetRequestDetail({ seq: 9 }, map);
    expect(clipped.result).toContain("请求体 0-8000/20000 字符");
    const full = handleGetRequestDetail({ seqs: [1, 2], full: true }, map);
    expect(full.fetchedSeqs).toEqual([1, 2]);
    expect(full.result).toContain("access_token");
    expect(full.result).toContain("---");
  });

  it("pages through a body too long for one call, and says how to continue", () => {
    // 捕获层单条正文最大 1MB；40000 的上限意味着要分 26 段
    const body = `HEAD${"x".repeat(1_000_000)}`.slice(0, 1_000_000 - 11) + "TAIL-MARKER";
    const big = new Map([[5, req({ seq: 5, method: "POST", url: "https://api.example.com/huge", responseBody: body })]]);

    const first = handleGetRequestDetail({ seq: 5, full: true }, big);
    expect(first.result).toContain("HEAD");
    expect(first.result).not.toContain("TAIL-MARKER");
    // 标记要给出区间、总长和可以照抄的续查调用
    expect(first.result).toContain("响应体 0-40000/1000000 字符");
    expect(first.result).toContain("get_request_detail({seq: 5, full: true, offset: 40000})");

    const last = handleGetRequestDetail({ seq: 5, full: true, offset: 960_000 }, big);
    expect(last.result).toContain("TAIL-MARKER");
    expect(last.result).toContain("响应体 960000-1000000/1000000 字符");
    // 已经到底了就不该再给续查调用
    expect(last.result).not.toContain("续看");
    expect(last.refLine).toContain("offset=960000");

    const past = handleGetRequestDetail({ seq: 5, full: true, offset: 2_000_000 }, big);
    expect(past.result).toContain("已越过正文末尾");
  });

  it("leaves a body that fits byte-identical, and ignores a nonsense offset", () => {
    const small = new Map([[6, req({ seq: 6, method: "POST", url: "https://api.example.com/s", body: '{"a":1}' })]]);

    const plain = handleGetRequestDetail({ seq: 6 }, small);
    expect(plain.result).toContain('{"a":1}');
    expect(plain.result).not.toContain("字符]");
    expect(plain.refLine).not.toContain("offset");

    expect(handleGetRequestDetail({ seq: 6, offset: -5 }, small).result).toBe(plain.result);
    expect(handleGetRequestDetail({ seq: 6, offset: "abc" }, small).result).toBe(plain.result);
  });

  it("dispatches builtin tool names", () => {
    expect(dispatchBuiltinRequestTool("list_requests", { method: "POST" }, map, summaries)?.refLine).toContain("list_requests");
    expect(dispatchBuiltinRequestTool("nope", {}, map, summaries)).toBeNull();
  });
});

  it("reports the real hit total and offers a continuation when search is capped", () => {
    const many = new Map(
      Array.from({ length: 30 }, (_, i) => {
        const request = req({ seq: i + 1, url: `https://api.example.com/item/${i + 1}`, responseBody: '{"t":"needle"}' });
        return [request.seq, request] as const;
      }),
    );

    const first = handleSearchRequests({ query: "needle", limit: 5 }, many);
    // 上限是 5，但模型必须看得出后面还有 25 条
    expect(first.result).toContain("命中 30 条，返回 5 条");
    expect(first.result).toContain("offset: 5");
    expect(first.result).toContain("#1 ");
    expect(first.result).not.toContain("#6 ");

    const next = handleSearchRequests({ query: "needle", limit: 5, offset: 5 }, many);
    expect(next.result).toContain("#6 ");
    expect(next.result).toContain("offset=5");
    expect(next.refLine).toContain("matched=30");

    const past = handleSearchRequests({ query: "needle", limit: 5, offset: 99 }, many);
    expect(past.result).toContain("已越过全部结果");
  });

  it("supports offset/page pagination for list_requests", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      summary({ seq: i + 1, method: "GET", url: `https://api.example.com/item/${i + 1}` }),
    );
    const page1 = handleListRequests({ limit: 10, page: 1 }, many);
    const page2 = handleListRequests({ limit: 10, offset: 10 }, many);
    expect(page1.result).toContain("page=1/");
    expect(page1.result).toContain("#1 GET");
    expect(page1.result).not.toContain("#11 GET");
    expect(page2.result).toContain("#11 GET");
    expect(page2.result).toContain("offset=10");
  });
