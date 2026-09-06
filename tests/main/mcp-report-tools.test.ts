/**
 * MCP 报告类工具：走真实 McpServer + InMemoryTransport，deps 用最小内存实现。
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisReport, CapturedRequest, ChatMessage } from "../../src/shared/types";
import { sampleSpec } from "../shared/fixtures/protocol-spec.fixture";

const llmConfig = { name: "openai", baseUrl: "https://api.openai.com/v1", apiKey: "sk", model: "gpt-4o", maxTokens: 4096 };

vi.mock("../../src/main/ipc", () => ({
  loadLLMConfig: vi.fn(() => llmConfig),
  loadProxyConfig: vi.fn(() => null),
}));

vi.mock("../../src/main/prompt-templates", () => ({
  findTemplate: vi.fn((id: string) => (id === "auto" || id === "reverse-api"
    ? { id, name: id, description: "", systemPrompt: "sys", requirements: "req", isBuiltin: true, isModified: false }
    : undefined)),
}));

import { createMcpServerInstance, type MCPServerDeps } from "../../src/main/mcp/mcp-server";

function request(sequence: number, url: string): CapturedRequest {
  return {
    id: `req-${sequence}`,
    session_id: "s1",
    sequence,
    timestamp: 1_000 + sequence,
    method: sequence === 1 ? "POST" : "GET",
    url,
    request_headers: "{}",
    request_body: null,
    status_code: 200,
    response_headers: JSON.stringify({ "content-type": "application/json" }),
    response_body: '{"ok":true}',
    content_type: "application/json",
    initiator: null,
    duration_ms: 5,
    is_streaming: false,
    is_websocket: false,
  };
}

function report(overrides: Partial<AnalysisReport>): AnalysisReport {
  return {
    id: "r1",
    session_id: "s1",
    created_at: 1_000,
    llm_provider: "openai",
    llm_model: "gpt-4o",
    prompt_tokens: 1,
    completion_tokens: 1,
    report_content: "# 报告\n登录 [#1]",
    filter_prompt_tokens: null,
    filter_completion_tokens: null,
    purpose: "auto",
    spec_json: null,
    spec_error: null,
    enrichment_json: null,
    ...overrides,
  };
}

interface Harness {
  client: Client;
  reports: AnalysisReport[];
  chat: Map<string, ChatMessage[]>;
  analyzer: {
    analyze: ReturnType<typeof vi.fn>;
    ensureSpec: ReturnType<typeof vi.fn>;
    chat: ReturnType<typeof vi.fn>;
    getSessionEnrichment: ReturnType<typeof vi.fn>;
  };
}

const closeCallbacks: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closeCallbacks.splice(0).map((close) => close()));
});

async function connect(initialReports: AnalysisReport[]): Promise<Harness> {
  const reports = [...initialReports];
  const chat = new Map<string, ChatMessage[]>();
  const requests = [request(1, "https://api.example.com/v1/login"), request(2, "https://api.example.com/v1/me")];

  const analyzer = {
    analyze: vi.fn(async (_sessionId: string, _config: unknown, _p: unknown, purpose?: string, template?: { id: string }) => {
      const created = report({ id: `r${reports.length + 1}`, created_at: 5_000 + reports.length, purpose: template?.id ?? purpose ?? null, spec_json: JSON.stringify(sampleSpec) });
      reports.unshift(created);
      return created;
    }),
    ensureSpec: vi.fn(async (reportId: string) => {
      const index = reports.findIndex((r) => r.id === reportId);
      reports[index] = { ...reports[index], spec_json: JSON.stringify(sampleSpec), spec_error: null };
      return reports[index];
    }),
    chat: vi.fn(async () => "回复正文 [#1]\n\n<tool_state>{\"fetched\":[1]}</tool_state>"),
    getSpec: (r: AnalysisReport) => (r.spec_json ? JSON.parse(r.spec_json) : null),
    getSessionEnrichment: vi.fn(() => ({
      generatedAt: 1,
      requestCount: 2,
      totalRequests: 2,
      sceneHints: [{ scene: "login", confidence: "high", evidence: "POST /v1/login", relatedRequestIds: ["#1"] }],
      authChain: [],
      storageDiff: { cookies: { added: {}, changed: {}, removed: [] }, localStorage: { added: {}, changed: {}, removed: [] }, sessionStorage: { added: {}, changed: {}, removed: [] } },
      streamingSeqs: [],
    })),
    buildInitialChatMessages: (r: AnalysisReport): ChatMessage[] => [
      { role: "system", content: "sys" },
      { role: "assistant", content: r.report_content },
    ],
  };

  const deps = {
    sessionManager: {
      getSession: () => ({ id: "s1", name: "demo", target_url: "https://example.com" }),
      listSessions: () => [{ id: "s1", name: "demo" }],
    },
    aiAnalyzer: analyzer,
    requestsRepo: { findBySession: () => requests, countBySession: () => requests.length },
    jsHooksRepo: { findBySession: () => [], countBySession: () => 0 },
    storageSnapshotsRepo: { findBySession: () => [] },
    reportsRepo: {
      findBySession: () => [...reports].sort((a, b) => b.created_at - a.created_at),
      findById: (id: string) => reports.find((r) => r.id === id),
      countBySession: () => reports.length,
    },
    chatMessagesRepo: {
      findByReport: (id: string) => chat.get(id) ?? [],
      insertMany: (id: string, messages: ChatMessage[]) => { chat.set(id, [...(chat.get(id) ?? []), ...messages]); },
      append: (id: string, role: string, content: string) => { chat.set(id, [...(chat.get(id) ?? []), { role: role as ChatMessage["role"], content }]); },
    },
    interactionEventsRepo: { findBySession: () => [] },
  } as unknown as MCPServerDeps;

  const server = createMcpServerInstance(deps);
  const client = new Client({ name: "report-tools-test", version: "1.0.0" }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  closeCallbacks.push(async () => {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, reports, chat, analyzer };
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

describe("MCP report tools", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await connect([
      report({ id: "old", created_at: 1_000, report_content: "旧报告" }),
      report({ id: "new", created_at: 2_000, report_content: "新报告 [#1]", spec_json: JSON.stringify(sampleSpec) }),
    ]);
  });

  it("get_reports returns metadata with a short preview instead of the whole body", async () => {
    const list = await call(harness.client, "get_reports", { sessionId: "s1" }) as unknown as Array<Record<string, unknown>>;
    expect(list.map((r) => r.id)).toEqual(["new", "old"]);
    expect(list[0].hasSpec).toBe(true);
    expect(list[1].hasSpec).toBe(false);
    expect(list[0]).not.toHaveProperty("content");
    expect(list[0].preview).toBe("新报告 [#1]");
  });

  it("get_report returns markdown, spec or both", async () => {
    const both = await call(harness.client, "get_report", { reportId: "new" });
    expect(both.content).toBe("新报告 [#1]");
    expect((both.spec as { scene: string }).scene).toBe("login");
    const md = await call(harness.client, "get_report", { reportId: "new", format: "markdown" });
    expect(md).not.toHaveProperty("spec");
    const missing = await call(harness.client, "get_report", { reportId: "nope" });
    expect(missing.error).toBe("Report not found");
  });

  it("get_protocol_spec extracts on demand for reports without a spec", async () => {
    const result = await call(harness.client, "get_protocol_spec", { reportId: "old" });
    expect(harness.analyzer.ensureSpec).toHaveBeenCalledWith("old", llmConfig);
    expect((result.spec as { scene: string }).scene).toBe("login");

    harness.analyzer.ensureSpec.mockClear();
    const latest = await call(harness.client, "get_protocol_spec", { sessionId: "s1" });
    expect(latest.reportId).toBe("new");
    expect(harness.analyzer.ensureSpec).not.toHaveBeenCalled();
  });

  it("get_openapi builds a document from the latest spec", async () => {
    const doc = await call(harness.client, "get_openapi", { sessionId: "s1" });
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths as Record<string, unknown>)).toEqual(["/v1/login", "/v1/users/{id}"]);
    expect((doc.info as Record<string, unknown>).title).toBe("demo API");
  });

  it("get_session_brief stays compact and prefers spec endpoints", async () => {
    const brief = await call(harness.client, "get_session_brief", { sessionId: "s1" });
    expect((brief.session as { name: string }).name).toBe("demo");
    expect((brief.counts as { requests: number; reports: number }).requests).toBe(2);
    expect(brief.endpointsSource).toBe("protocol-spec");
    expect((brief.endpoints as unknown[]).length).toBe(2);
    expect((brief.latestReport as { id: string; summary: string }).id).toBe("new");
    expect((brief.latestReport as { summary: string }).summary).toBe(sampleSpec.summary);
    expect(JSON.stringify(brief).length).toBeLessThan(8_000);
  });

  it("get_session_enrichment goes through the analyzer's cached enrichment", async () => {
    const enrichment = await call(harness.client, "get_session_enrichment", { sessionId: "s1" });
    expect(enrichment.requestCount).toBe(2);
    expect((enrichment.sceneHints as Array<{ scene: string }>)[0].scene).toBe("login");
    expect(harness.analyzer.getSessionEnrichment).toHaveBeenCalledWith("s1");
  });

  it("get_request_by_seq resolves seqs and reports the missing ones", async () => {
    const result = await call(harness.client, "get_request_by_seq", { sessionId: "s1", seqs: [2, 42] });
    expect((result.requests as Array<{ sequence: number }>).map((r) => r.sequence)).toEqual([2]);
    expect(result.missing).toEqual([42]);
  });

  it("run_analysis resolves the template like the IPC path and returns the spec", async () => {
    const result = await call(harness.client, "run_analysis", { sessionId: "s1", purpose: "reverse-api" });
    const [, , , purpose, template] = harness.analyzer.analyze.mock.calls[0];
    expect(purpose).toBe("reverse-api");
    expect((template as { id: string }).id).toBe("reverse-api");
    expect(result.purpose).toBe("reverse-api");
    expect((result.spec as { scene: string }).scene).toBe("login");
    // 初始对话已落库
    expect(harness.chat.get(result.id as string)?.[0].role).toBe("system");
  });

  it("chat_followup uses the latest report, persists history and strips tool_state", async () => {
    const result = await call(harness.client, "chat_followup", { sessionId: "s1", message: "第一步是什么？" });
    expect(result.reportId).toBe("new");
    expect(result.reply).toBe("回复正文 [#1]");

    const [sessionId, , history, message, , reportId] = harness.analyzer.chat.mock.calls[0];
    expect(sessionId).toBe("s1");
    expect(reportId).toBe("new");
    expect(message).toBe("第一步是什么？");
    expect((history as ChatMessage[])[1].content).toBe("新报告 [#1]");

    const persisted = harness.chat.get("new")!;
    expect(persisted.map((m) => m.role)).toEqual(["system", "assistant", "user", "assistant"]);
    expect(persisted[3].content).toContain("<tool_state>");

    // 第二次追问带上已持久化的历史
    await call(harness.client, "chat_followup", { sessionId: "s1", message: "再问一个" });
    const [, , secondHistory] = harness.analyzer.chat.mock.calls[1];
    expect((secondHistory as ChatMessage[]).length).toBe(4);
  });
});
