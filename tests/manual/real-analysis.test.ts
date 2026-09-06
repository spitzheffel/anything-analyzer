/**
 * 端到端真实模型验证。默认跳过，需要显式给出端点才会执行：
 *   $env:AA_TEST_BASE_URL="http://127.0.0.1:18080/v1"
 *   $env:AA_TEST_API_KEY="sk-..."
 *   node scripts/run-electron-vitest.mjs tests/manual/real-analysis.test.ts
 *
 * 必须在 Electron 下跑：better-sqlite3 是按 Electron ABI 编译的。
 * 流程：建临时库 → 灌一个真实感的登录/下单会话 → 用真实模型跑 analyze
 *       → 校验引用、ProtocolSpec、ensureSpec、HAR、OpenAPI。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const workDir = mkdtempSync(join(tmpdir(), "aa-real-verify-"));
vi.mock("electron", () => ({ app: { getPath: () => workDir, getVersion: () => "manual-verify" } }));

import type { AnalysisReport, AiProgressEvent, CapturedRequest, LLMProviderConfig } from "../../src/shared/types";
import { runMigrations } from "../../src/main/db/migrations";
import {
  AiRequestLogRepo,
  AnalysisReportsRepo,
  InteractionEventsRepo,
  JsHooksRepo,
  RequestsRepo,
  SessionsRepo,
  StorageSnapshotsRepo,
} from "../../src/main/db/repositories";
import { AiAnalyzer } from "../../src/main/ai/ai-analyzer";
import { parseProtocolSpec, type ProtocolSpec } from "../../src/shared/protocol-spec";
import { extractCitedSeqs, linkifyCitations, parseCitationHref, validateCitations } from "../../src/shared/citations";
import { buildHar } from "../../src/shared/har-export";
import { buildOpenApiDocument } from "../../src/shared/openapi-export";

const require = createRequire(import.meta.url);
type BetterSqlite3Database = import("better-sqlite3").Database;

const BASE_URL = process.env.AA_TEST_BASE_URL;
const API_KEY = process.env.AA_TEST_API_KEY;
const MAIN_MODEL = process.env.AA_TEST_MODEL ?? "claude-sonnet-4-6";
const LIGHT_MODEL = process.env.AA_TEST_LIGHT_MODEL ?? "gpt-5.4-mini";

const SESSION_ID = "verify-session";
const HOST = "https://api.shop.example.com";

let db: BetterSqlite3Database;
let analyzer: AiAnalyzer;
let requestsRepo: RequestsRepo;
let sessionsRepo: SessionsRepo;
let report: AnalysisReport;
let spec: ProtocolSpec | null;
const statusLog: string[] = [];
let reasoningChars = 0;
let textChars = 0;

interface SeedRequest {
  seq: number;
  method: string;
  url: string;
  reqHeaders: Record<string, string>;
  reqBody: string | null;
  status: number;
  resHeaders: Record<string, string>;
  resBody: string;
  streaming?: boolean;
}

const ACCESS_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI3NzEyIn0.9xKQm3Zr8bTfLpQwUvNhAaCcDdEeFfGgHhIiJjKk";
const REFRESH_TOKEN = "rt_8f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e";
const authHeader = { authorization: `Bearer ${ACCESS_TOKEN}`, "content-type": "application/json" };

const SEED: SeedRequest[] = [
  {
    seq: 1,
    method: "POST",
    url: `${HOST}/v1/auth/login`,
    reqHeaders: { "content-type": "application/json", "x-client-ver": "3.2.0" },
    reqBody: JSON.stringify({ username: "alice@example.com", password: "P@ssw0rd!", device_id: "web-9f2a" }),
    status: 200,
    resHeaders: { "content-type": "application/json", "set-cookie": "sid=abc123def456; Path=/; HttpOnly; Secure" },
    resBody: JSON.stringify({ access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, expires_in: 7200, user: { id: 7712, name: "Alice" } }),
  },
  {
    seq: 2,
    method: "GET",
    url: `${HOST}/v1/users/me`,
    reqHeaders: authHeader,
    reqBody: null,
    status: 200,
    resHeaders: { "content-type": "application/json" },
    resBody: JSON.stringify({ id: 7712, name: "Alice", email: "alice@example.com", level: "gold" }),
  },
  {
    seq: 3,
    method: "GET",
    url: `${HOST}/v1/products?page=1&size=20&category=phone`,
    reqHeaders: authHeader,
    reqBody: null,
    status: 200,
    resHeaders: { "content-type": "application/json" },
    resBody: JSON.stringify({ total: 128, page: 1, items: [{ id: "p-1001", title: "Phone A", price: 3999 }, { id: "p-1002", title: "Phone B", price: 4599 }] }),
  },
  {
    seq: 4,
    method: "POST",
    url: `${HOST}/v1/cart/items`,
    reqHeaders: authHeader,
    reqBody: JSON.stringify({ product_id: "p-1001", quantity: 2 }),
    status: 200,
    resHeaders: { "content-type": "application/json" },
    resBody: JSON.stringify({ cart_id: "c-55231", item_count: 2, amount: 7998 }),
  },
  {
    seq: 5,
    method: "POST",
    url: `${HOST}/v1/orders`,
    reqHeaders: { ...authHeader, "x-signature": "8a5f0c1d9e2b7643aa10cc55ee77bb99" },
    reqBody: JSON.stringify({ cart_id: "c-55231", address_id: "ad-77", timestamp: 1757116800, nonce: "n-4f8c", sign: "8a5f0c1d9e2b7643aa10cc55ee77bb99" }),
    status: 201,
    resHeaders: { "content-type": "application/json" },
    resBody: JSON.stringify({ order_id: "o-908812", status: "created", amount: 7998, pay_url: `${HOST}/pay/o-908812` }),
  },
  {
    seq: 6,
    method: "GET",
    url: `${HOST}/v1/orders/o-908812/events`,
    reqHeaders: { ...authHeader, accept: "text/event-stream" },
    reqBody: null,
    status: 200,
    resHeaders: { "content-type": "text/event-stream" },
    resBody: 'data: {"stage":"created"}\n\ndata: {"stage":"paying"}\n\ndata: {"stage":"paid"}\n\n',
    streaming: true,
  },
  {
    seq: 7,
    method: "POST",
    url: `${HOST}/v1/auth/refresh`,
    reqHeaders: { "content-type": "application/json" },
    reqBody: JSON.stringify({ refresh_token: REFRESH_TOKEN }),
    status: 200,
    resHeaders: { "content-type": "application/json" },
    resBody: JSON.stringify({ access_token: `${ACCESS_TOKEN}.v2`, expires_in: 7200 }),
  },
];

function seedSession(): void {
  sessionsRepo.insert({
    id: SESSION_ID,
    name: "Shop 下单链路",
    target_url: "https://shop.example.com",
    status: "stopped",
    created_at: Date.now() - 600_000,
    stopped_at: Date.now() - 60_000,
  });

  const base = Date.now() - 500_000;
  for (const item of SEED) {
    requestsRepo.insert({
      id: `req-${item.seq}`,
      session_id: SESSION_ID,
      sequence: item.seq,
      timestamp: base + item.seq * 1_500,
      method: item.method,
      url: item.url,
      request_headers: JSON.stringify(item.reqHeaders),
      request_body: item.reqBody,
      content_type: item.reqHeaders["content-type"] ?? null,
      initiator: null,
      source: "cdp",
    });
    requestsRepo.updateResponse({
      id: `req-${item.seq}`,
      status_code: item.status,
      response_headers: JSON.stringify(item.resHeaders),
      response_body: item.resBody,
      content_type: item.resHeaders["content-type"] ?? null,
      duration_ms: 90 + item.seq * 13,
      is_streaming: item.streaming ? 1 : 0,
      is_websocket: 0,
    });
  }

  // 下单签名的 HMAC 调用，正好落在 #5 的时间窗口里
  const hooksRepo = new JsHooksRepo(db);
  hooksRepo.insert({
    session_id: SESSION_ID,
    timestamp: base + 5 * 1_500 - 200,
    hook_type: "crypto",
    function_name: "CryptoJS.HmacSHA256",
    arguments: JSON.stringify(["cart_id=c-55231&address_id=ad-77&nonce=n-4f8c&timestamp=1757116800", "APP_SECRET_2f8b91"]),
    result: JSON.stringify("8a5f0c1d9e2b7643aa10cc55ee77bb99"),
    call_stack: "at buildSign (https://shop.example.com/static/js/sign.js:42:17)\nat submitOrder (https://shop.example.com/static/js/order.js:118:9)",
    related_request_id: "req-5",
  });

  const storageRepo = new StorageSnapshotsRepo(db);
  storageRepo.insert({
    session_id: SESSION_ID,
    timestamp: base,
    domain: "shop.example.com",
    storage_type: "localStorage",
    data: JSON.stringify({ theme: "dark" }),
  });
  storageRepo.insert({
    session_id: SESSION_ID,
    timestamp: base + 20_000,
    domain: "shop.example.com",
    storage_type: "localStorage",
    data: JSON.stringify({ theme: "dark", access_token: ACCESS_TOKEN, refresh_token: REFRESH_TOKEN, uid: "7712" }),
  });
}

const config: LLMProviderConfig = {
  name: "custom",
  apiType: "completions",
  baseUrl: BASE_URL ?? "",
  apiKey: API_KEY ?? "",
  model: MAIN_MODEL,
  lightweightModel: LIGHT_MODEL,
  maxTokens: 16_000,
  generation: { reasoningEffort: "none" },
  contextBudget: { maxContextTokens: 200_000, autoContextWindow: false, subagentEnabled: false },
};

// better-sqlite3 按 Electron ABI 编译，普通 node 下加载不了；探测一次，不可用就跳过
let Database: typeof import("better-sqlite3") | null = null;
try {
  Database = require("better-sqlite3") as typeof import("better-sqlite3");
  const probe = new Database(":memory:");
  probe.close();
} catch {
  Database = null;
}

const enabled = Boolean(BASE_URL && API_KEY && Database);

beforeAll(() => {
  if (!enabled) return;
  db = new Database!(join(workDir, "verify.db"));
  db.pragma("foreign_keys = ON");
  runMigrations(db);

  sessionsRepo = new SessionsRepo(db);
  requestsRepo = new RequestsRepo(db);
  seedSession();

  analyzer = new AiAnalyzer(
    sessionsRepo,
    requestsRepo,
    new JsHooksRepo(db),
    new StorageSnapshotsRepo(db),
    new AnalysisReportsRepo(db),
    new AiRequestLogRepo(db),
    new InteractionEventsRepo(db),
  );
});

afterAll(() => {
  db?.close();
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* 临时目录清理失败无所谓 */
  }
});

describe.skipIf(!enabled)("real endpoint end-to-end", () => {
  it("runs a full analysis and extracts a ProtocolSpec", async () => {
    const onProgress = (event: AiProgressEvent): void => {
      if (event.kind === "status") statusLog.push(event.text);
      else if (event.kind === "reasoning") reasoningChars += event.text.length;
      else if (event.kind === "text") textChars += event.text.length;
    };

    report = await analyzer.analyze(SESSION_ID, config, onProgress, undefined, undefined);

    console.log("\n=== 分析结果 ===");
    console.log(`model=${report.llm_model} tokens=${report.prompt_tokens}/${report.completion_tokens}`);
    console.log(`report chars=${report.report_content.length} streamed text chars=${textChars} reasoning chars=${reasoningChars}`);
    console.log("status events:");
    for (const line of statusLog) console.log(`  - ${line}`);
    console.log(`spec_error=${report.spec_error ?? "(none)"}`);

    expect(report.report_content.length).toBeGreaterThan(200);
    // 流式确实推送了正文（不是一次性吐出）
    expect(textChars).toBeGreaterThan(200);
    expect(report.enrichment_json).not.toBeNull();
    expect(report.spec_error).toBeNull();
    expect(report.spec_json).not.toBeNull();

    spec = parseProtocolSpec(JSON.parse(report.spec_json!));
    expect(spec).not.toBeNull();
  }, 900_000);

  it("cites real request seqs in the report", () => {
    const knownSeqs = SEED.map((item) => item.seq);
    const citation = validateCitations(report.report_content, knownSeqs);
    console.log(`\ncited seqs: ${citation.cited.join(", ") || "(none)"}`);
    console.log(`unknown seqs: ${citation.unknown.join(", ") || "(none)"}`);

    expect(citation.cited.length).toBeGreaterThan(0);
    expect(citation.unknown).toEqual([]);

    // 引用能被渲染层改写成可点击链接，并解析回序号
    const linkified = linkifyCitations(report.report_content);
    const firstSeq = citation.cited[0];
    expect(linkified).toContain(`[#${firstSeq}](seq://${firstSeq})`);
    expect(parseCitationHref(`seq://${firstSeq}`)).toBe(firstSeq);
    // 点击后能在会话里找到这条请求
    expect(requestsRepo.findBySession(SESSION_ID).some((r) => r.sequence === firstSeq)).toBe(true);
  });

  it("produces a usable ProtocolSpec", () => {
    const s = spec!;
    console.log("\n=== ProtocolSpec ===");
    console.log(`scene=${s.scene}`);
    console.log(`summary=${s.summary}`);
    console.log(`endpoints (${s.endpoints.length}):`);
    for (const e of s.endpoints) console.log(`  ${e.method} ${e.urlTemplate} [${e.auth}] seqs=${e.exampleSeqs.join(",")} <- ${e.purpose}`);
    console.log(`authChain (${s.authChain.length}):`);
    for (const a of s.authChain) console.log(`  ${a.credentialType} from=${a.obtainedFrom} in=${a.carriedIn}:${a.keyName ?? "-"} seqs=${a.evidenceSeqs.join(",")}`);
    console.log(`flows: ${s.flows.map((f) => `${f.name}(${f.steps.map((x) => x.endpointId).join("->")})`).join(" | ") || "(none)"}`);
    console.log(`storage: ${s.storage.map((x) => `${x.type}:${x.key}`).join(", ") || "(none)"}`);
    console.log(`crypto: ${s.crypto.map((x) => x.algorithm).join(", ") || "(none)"}`);
    console.log(`reproduction: ${s.reproduction ? `${s.reproduction.language}, ${s.reproduction.code.length} chars` : "(none)"}`);

    const knownSeqs = new Set(SEED.map((item) => item.seq));
    const endpointIds = new Set(s.endpoints.map((e) => e.id));

    expect(s.endpoints.length).toBeGreaterThanOrEqual(4);
    expect(s.authChain.length).toBeGreaterThanOrEqual(1);
    // SSE 端点必须进入分析（曾因 content-type 不在 API 列表里被整个过滤掉）
    expect(s.endpoints.some((e) => e.streaming === "sse" || /events/.test(e.urlTemplate))).toBe(true);
    // 方法已归一化为大写
    expect(s.endpoints.every((e) => e.method === e.method.toUpperCase())).toBe(true);
    // 所有依据序号真实存在
    for (const e of s.endpoints) for (const seq of e.exampleSeqs) expect(knownSeqs.has(seq)).toBe(true);
    for (const a of s.authChain) for (const seq of a.evidenceSeqs) expect(knownSeqs.has(seq)).toBe(true);
    // 端点引用没有悬空
    for (const e of s.endpoints) for (const dep of e.dependsOn) expect(endpointIds.has(dep)).toBe(true);
    for (const f of s.flows) for (const step of f.steps) expect(endpointIds.has(step.endpointId)).toBe(true);
    // 至少认出登录端点，并且大部分端点带上了依据
    expect(s.endpoints.some((e) => /login|auth/i.test(e.urlTemplate))).toBe(true);
    expect(s.endpoints.filter((e) => e.exampleSeqs.length > 0).length).toBeGreaterThanOrEqual(3);
  });

  it("ensureSpec backfills a report that has none", async () => {
    const reportsRepo = new AnalysisReportsRepo(db);
    reportsRepo.updateSpec(report.id, null, "manually cleared for verification");
    expect(reportsRepo.findById(report.id)?.spec_json).toBeNull();

    const refreshed = await analyzer.ensureSpec(report.id, config);
    console.log(`\nensureSpec: spec_error=${refreshed.spec_error ?? "(none)"} endpoints=${parseProtocolSpec(JSON.parse(refreshed.spec_json ?? "null"))?.endpoints.length ?? 0}`);
    expect(refreshed.spec_error).toBeNull();
    expect(refreshed.spec_json).not.toBeNull();
  }, 600_000);

  it("exports a valid HAR", () => {
    const requests: CapturedRequest[] = requestsRepo.findBySession(SESSION_ID);
    const har = buildHar(requests, { name: "Shop 下单链路", targetUrl: "https://shop.example.com", appVersion: "manual-verify" });
    const file = join(workDir, "session.har");
    writeFileSync(file, JSON.stringify(har, null, 2), "utf-8");
    const roundTrip = JSON.parse(JSON.stringify(har)) as typeof har;

    console.log(`\n=== HAR ===\nentries=${roundTrip.log.entries.length} file=${file}`);
    const login = roundTrip.log.entries.find((e) => e._seq === 1)!;
    console.log(`#1 ${login.request.method} ${login.request.url} -> ${login.response.status}`);
    console.log(`  reqCookies=${login.request.cookies.length} resCookies=${login.response.cookies.map((c) => c.name).join(",")}`);
    const sse = roundTrip.log.entries.find((e) => e._seq === 6)!;
    console.log(`#6 streaming=${sse._streaming} mime=${sse.response.content.mimeType}`);

    expect(roundTrip.log.version).toBe("1.2");
    expect(roundTrip.log.entries.map((e) => e._seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(login.startedDateTime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(login.request.postData?.text).toContain("alice@example.com");
    expect(login.response.cookies.some((c) => c.name === "sid" && c.httpOnly === true)).toBe(true);
    expect(roundTrip.log.entries.find((e) => e._seq === 3)!.request.queryString.map((q) => q.name)).toEqual(["page", "size", "category"]);
    expect(sse._streaming).toBe(true);
    expect(sse.response.content.mimeType).toContain("text/event-stream");
  });

  it("exports a valid OpenAPI 3.1 document", () => {
    const session = sessionsRepo.findById(SESSION_ID)!;
    const doc = buildOpenApiDocument(spec!, { sessionName: session.name, targetUrl: session.target_url, generatedAt: report.created_at });
    const file = join(workDir, "openapi.json");
    writeFileSync(file, JSON.stringify(doc, null, 2), "utf-8");

    const paths = Object.keys(doc.paths);
    console.log(`\n=== OpenAPI ===\nfile=${file}`);
    console.log(`servers=${doc.servers.map((s) => s.url).join(", ")}`);
    console.log(`paths (${paths.length}): ${paths.join(", ")}`);
    console.log(`securitySchemes=${JSON.stringify(doc.components.securitySchemes)}`);

    expect(doc.openapi).toBe("3.1.0");
    expect(paths.length).toBeGreaterThanOrEqual(4);
    expect(doc.servers.length).toBeGreaterThanOrEqual(1);
    // 每个操作都有 operationId / responses，且方法是小写的 HTTP 动词
    for (const [, item] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(item as Record<string, Record<string, unknown>>)) {
        if (method === "servers") continue;
        expect(["get", "post", "put", "patch", "delete", "head", "options"]).toContain(method);
        expect(typeof op.operationId).toBe("string");
        expect(op.responses).toBeTruthy();
      }
    }
    // 鉴权方案存在且带有真实键名（bearer 或来自 authChain 的 header/cookie 名）
    expect(Object.keys(doc.components.securitySchemes).length).toBeGreaterThanOrEqual(1);
  });
});
