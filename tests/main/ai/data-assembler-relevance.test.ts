import { describe, expect, it } from "vitest";
import { DataAssembler } from "../../../src/main/ai/data-assembler";
import type { CapturedRequest } from "../../../src/shared/types";

function request(overrides: Partial<CapturedRequest>): CapturedRequest {
  return {
    id: `req-${overrides.sequence ?? 1}`,
    session_id: "s1",
    sequence: overrides.sequence ?? 1,
    timestamp: 1_000,
    method: "GET",
    url: "https://api.example.com/v1/thing",
    request_headers: "{}",
    request_body: null,
    status_code: 200,
    response_headers: "{}",
    response_body: "{}",
    content_type: "application/json",
    initiator: null,
    duration_ms: 10,
    is_streaming: false,
    is_websocket: false,
    ...overrides,
  };
}

function assemble(requests: CapturedRequest[]) {
  const assembler = new DataAssembler(
    { findBySession: () => requests } as never,
    { findBySession: () => [] } as never,
    { findBySession: () => [] } as never,
  );
  return assembler.assemble("s1");
}

describe("DataAssembler request relevance", () => {
  it("keeps SSE and WebSocket GETs that carry no body and a non-API content type", () => {
    const data = assemble([
      request({ sequence: 1, url: "https://api.example.com/v1/orders/1/events", content_type: "text/event-stream", is_streaming: true, response_body: 'data: {"stage":"paid"}\n\n' }),
      request({ sequence: 2, url: "wss://api.example.com/v1/live", content_type: null, is_websocket: true, response_body: null }),
      // DB 里布尔是 0/1，同样要认
      request({ sequence: 3, url: "https://api.example.com/v1/feed", content_type: "text/event-stream", is_streaming: 1 as unknown as boolean, response_body: "data: x\n\n" }),
    ]);

    expect(data.requests.map((r) => r.seq)).toEqual([1, 2, 3]);
    expect(data.streamingRequests.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it("still drops static assets and plain GETs without an API content type", () => {
    const data = assemble([
      request({ sequence: 1, url: "https://cdn.example.com/app.js", content_type: "application/javascript" }),
      request({ sequence: 2, url: "https://api.example.com/v1/ping", content_type: "text/plain", response_body: "pong" }),
      request({ sequence: 3, url: "https://api.example.com/v1/data", content_type: "application/json" }),
      request({ sequence: 4, method: "POST", url: "https://api.example.com/v1/submit", content_type: "text/plain" }),
    ]);

    expect(data.requests.map((r) => r.seq)).toEqual([3, 4]);
    expect(data.streamingRequests).toEqual([]);
  });
});
