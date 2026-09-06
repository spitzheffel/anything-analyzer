import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SessionManager } from "../session/session-manager";
import type { AiAnalyzer } from "../ai/ai-analyzer";
import type { WindowManager } from "../window";
import type { BrowserCoordinator } from "../browser/browser-coordinator";
import {
  BrowserBackendError,
  type BrowserContext,
  type BrowserTarget,
} from "../browser/contracts";
import type {
  RequestsRepo,
  JsHooksRepo,
  StorageSnapshotsRepo,
  AnalysisReportsRepo,
  ChatMessagesRepo,
  InteractionEventsRepo,
} from "../db/repositories";
import type { AnalysisReport, ChatMessage, InteractionType } from "@shared/types";
import { stripToolContext } from "@shared/types";
import { parseProtocolSpecJson, type ProtocolSpec } from "@shared/protocol-spec";
import { buildOpenApiDocument } from "@shared/openapi-export";
import { loadLLMConfig, loadProxyConfig } from "../ipc";
import { findTemplate } from "../prompt-templates";
import { DataAssembler } from "../ai/data-assembler";
import { ReplayEngine } from "../capture/replay-engine";
import { formatMCPServerUrl, normalizeMCPListenHost } from "./mcp-server-listen";

export interface MCPServerDeps {
  sessionManager: SessionManager;
  browserCoordinator: BrowserCoordinator;
  aiAnalyzer: AiAnalyzer;
  windowManager: WindowManager;
  requestsRepo: RequestsRepo;
  jsHooksRepo: JsHooksRepo;
  storageSnapshotsRepo: StorageSnapshotsRepo;
  reportsRepo: AnalysisReportsRepo;
  chatMessagesRepo: ChatMessagesRepo;
  interactionEventsRepo: InteractionEventsRepo;
}

let httpServer: Server | null = null;
const transports = new Map<string, StreamableHTTPServerTransport>();
// Per-session McpServer instances (one per transport/session)
const mcpServers = new Map<string, McpServer>();
let currentDeps: MCPServerDeps | null = null;

/** get_session_brief 里各列表的上限，控制在 ~2k token 内 */
const BRIEF_ENDPOINT_LIMIT = 30;
const BRIEF_HINT_LIMIT = 10;
const REPORT_PREVIEW_CHARS = 500;

const browserSessionIdSchema = z
  .string()
  .optional()
  .describe("Browser Session ID (defaults to the active browser Session)");
const browserTabIdSchema = z
  .string()
  .optional()
  .describe("Browser tab ID (defaults to the active tab in the selected Session)");
const browserTargetScopeShape = {
  sessionId: browserSessionIdSchema,
  tabId: browserTabIdSchema,
};

/**
 * Check if the body (single or batch JSON-RPC) contains an initialize request.
 */
function isInitRequest(body: unknown): boolean {
  if (Array.isArray(body)) {
    return body.some((msg) => isInitializeRequest(msg));
  }
  return isInitializeRequest(body);
}

/**
 * Create a new McpServer instance with tools and resources registered.
 */
export function createMcpServerInstance(deps: MCPServerDeps): McpServer {
  const server = new McpServer({
    name: "anything-analyzer",
    version: "1.0.0",
  });
  registerTools(server, deps);
  registerResources(server, deps);
  return server;
}

/**
 * Initialize and start the MCP Server on the given port.
 */
export async function initMCPServer(
  deps: MCPServerDeps,
  port: number,
  authEnabled: boolean = true,
  authToken: string = '',
  hostInput: string = '0.0.0.0',
): Promise<void> {
  if (httpServer) await stopMCPServer();

  const host = normalizeMCPListenHost(hostInput);
  currentDeps = deps;

  httpServer = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      // CORS
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, DELETE, OPTIONS",
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, mcp-session-id, mcp-protocol-version",
      );
      res.setHeader(
        "Access-Control-Expose-Headers",
        "mcp-session-id, mcp-protocol-version",
      );

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // Authentication check (skip OPTIONS preflight)
      if (authEnabled && authToken) {
        const authHeader = req.headers["authorization"];
        if (authHeader !== `Bearer ${authToken}`) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized: invalid or missing token" }));
          return;
        }
      }

      const url = new URL(req.url || "/", formatMCPServerUrl(host, port));
      if (url.pathname !== "/mcp") {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      try {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        if (req.method === "DELETE") {
          if (sessionId && transports.has(sessionId)) {
            // Delegate to transport so internal state is cleaned up properly
            await transports.get(sessionId)!.handleRequest(req, res);
          } else {
            res.writeHead(sessionId ? 404 : 400);
            res.end(JSON.stringify({ error: "Session not found" }));
          }
          return;
        }

        if (req.method === "GET") {
          if (sessionId && transports.has(sessionId)) {
            await transports.get(sessionId)!.handleRequest(req, res);
          } else {
            res.writeHead(sessionId ? 404 : 400);
            res.end(
              JSON.stringify({ error: "Missing or invalid session ID" }),
            );
          }
          return;
        }

        // POST
        const body = await readBody(req);

        if (sessionId && transports.has(sessionId)) {
          await transports.get(sessionId)!.handleRequest(req, res, body);
        } else if (!sessionId && isInitRequest(body)) {
          // Create per-session McpServer first so it can be captured in the callback
          const sessionServer = createMcpServerInstance(currentDeps!);
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              transports.set(sid, transport);
              // Store mcpServer here – sessionId is available now
              mcpServers.set(sid, sessionServer);
            },
          });
          transport.onclose = () => {
            if (transport.sessionId) {
              transports.delete(transport.sessionId);
              const srv = mcpServers.get(transport.sessionId);
              if (srv) {
                srv.close().catch(() => {});
                mcpServers.delete(transport.sessionId);
              }
            }
          };
          await sessionServer.connect(transport);
          await transport.handleRequest(req, res, body);
        } else if (sessionId && !transports.has(sessionId)) {
          // Session ID provided but transport is gone (e.g. server restarted)
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Session not found" }));
        } else {
          res.writeHead(400);
          res.end(
            JSON.stringify({
              error:
                "Bad request: missing session ID or not an initialize request",
            }),
          );
        }
      } catch (err) {
        console.error("[MCP Server] Error handling request:", err);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: String(err) }));
        }
      }
    },
  );

  const server = httpServer;
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });
    console.log(`[MCP Server] Listening on ${formatMCPServerUrl(host, port)}`);
  } catch (error) {
    httpServer = null;
    currentDeps = null;
    try {
      server.close();
    } catch {
      // Server may fail before entering the listening state.
    }
    throw error;
  }
}

/**
 * Stop the MCP Server and close all connections.
 */
export async function stopMCPServer(): Promise<void> {
  for (const transport of transports.values()) {
    await transport.close().catch(() => {});
  }
  transports.clear();

  for (const srv of mcpServers.values()) {
    await srv.close().catch(() => {});
  }
  mcpServers.clear();
  currentDeps = null;

  return new Promise((resolve) => {
    if (httpServer) {
      httpServer.close(() => {
        httpServer = null;
        resolve();
      });
    } else {
      resolve();
    }
  });
}

/**
 * Check if MCP Server is currently running.
 */
export function isMCPServerRunning(): boolean {
  return httpServer !== null && httpServer.listening;
}

// ---- Tool Registration ----

function registerTools(server: McpServer, deps: MCPServerDeps): void {
  const {
    sessionManager,
    browserCoordinator,
    aiAnalyzer,
    windowManager,
    requestsRepo,
    jsHooksRepo,
    storageSnapshotsRepo,
    reportsRepo,
    chatMessagesRepo,
    interactionEventsRepo,
  } = deps;

  const latestReportOf = (sessionId: string): AnalysisReport | undefined => reportsRepo.findBySession(sessionId)[0];

  /** 会话名等元信息；session 可能已删，缺省即可 */
  const sessionMetaOf = (sessionId: string): { name?: string; targetUrl?: string } => {
    const session = sessionManager.getSession(sessionId);
    return { name: session?.name, targetUrl: session?.target_url };
  };

  // -- Session Management --

  server.registerTool(
    "list_sessions",
    {
      description: "List all analysis sessions",
      inputSchema: z.object({}),
    },
    async () => {
      const sessions = sessionManager.listSessions();
      return text(sessions);
    },
  );

  server.registerTool(
    "create_session",
    {
      description: "Create a new analysis session",
      inputSchema: z.object({
        name: z.string().describe("Session name"),
        targetUrl: z.string().describe("Target URL to analyze"),
        backend: z
          .enum(["electron", "cloak"])
          .optional()
          .describe("Browser backend (defaults to electron)"),
        captureMode: z
          .enum(["passive", "deep"])
          .optional()
          .describe("Capture mode (defaults according to the selected backend)"),
      }),
    },
    async ({ name, targetUrl, backend, captureMode }) => {
      const s = sessionManager.createSession(name, targetUrl, {
        backend,
        captureMode,
      });
      return text(s);
    },
  );

  server.registerTool(
    "start_capture",
    {
      description:
        "Start capturing HTTP requests in the selected browser context.",
      inputSchema: z.object({
        sessionId: z.string().describe("Session ID"),
      }),
    },
    async ({ sessionId }) => {
      const mainWin = windowManager.getMainWindow();
      if (!mainWin || mainWin.isDestroyed()) {
        throw new Error("Main renderer is not ready");
      }
      // The compatibility TabManager parameter is no longer used by SessionManager.
      await sessionManager.startCapture(
        sessionId,
        undefined,
        mainWin.webContents,
        loadProxyConfig(),
      );
      return text({ success: true });
    },
  );

  server.registerTool(
    "pause_capture",
    {
      description: "Pause capturing for a session",
      inputSchema: z.object({ sessionId: z.string() }),
    },
    async ({ sessionId }) => {
      await sessionManager.pauseCapture(sessionId);
      return text({ success: true });
    },
  );

  server.registerTool(
    "resume_capture",
    {
      description: "Resume capturing for a paused session",
      inputSchema: z.object({ sessionId: z.string() }),
    },
    async ({ sessionId }) => {
      await sessionManager.resumeCapture(sessionId);
      return text({ success: true });
    },
  );

  server.registerTool(
    "stop_capture",
    {
      description: "Stop capturing and finalize a session",
      inputSchema: z.object({ sessionId: z.string() }),
    },
    async ({ sessionId }) => {
      await sessionManager.stopCapture(sessionId);
      return text({ success: true });
    },
  );

  server.registerTool(
    "delete_session",
    {
      description: "Delete a session and all its data",
      inputSchema: z.object({
        sessionId: z.string(),
        retainProfile: z
          .boolean()
          .optional()
          .describe("Retain the persistent browser profile for later recovery"),
      }),
    },
    async ({ sessionId, retainProfile }) => {
      await sessionManager.deleteSession(sessionId, undefined, { retainProfile });
      return text({ success: true });
    },
  );

  // -- Browser Control --

  server.registerTool(
    "navigate",
    {
      description: "Navigate a browser tab to a URL",
      inputSchema: z.object({
        url: z.string().describe("URL to navigate to"),
        ...browserTargetScopeShape,
      }),
    },
    async ({ url, sessionId, tabId }) => {
      const target = resolveBrowserTarget(browserCoordinator, sessionId, tabId);
      await target.navigate(url);
      return text({ success: true, target: browserTargetState(target) });
    },
  );

  server.registerTool(
    "browser_back",
    {
      description: "Go back in a browser tab",
      inputSchema: z.object(browserTargetScopeShape),
    },
    async ({ sessionId, tabId }) => {
      const target = resolveBrowserTarget(browserCoordinator, sessionId, tabId);
      await target.goBack();
      return text({ success: true, target: browserTargetState(target) });
    },
  );

  server.registerTool(
    "browser_forward",
    {
      description: "Go forward in a browser tab",
      inputSchema: z.object(browserTargetScopeShape),
    },
    async ({ sessionId, tabId }) => {
      const target = resolveBrowserTarget(browserCoordinator, sessionId, tabId);
      await target.goForward();
      return text({ success: true, target: browserTargetState(target) });
    },
  );

  server.registerTool(
    "browser_reload",
    {
      description: "Reload a browser tab",
      inputSchema: z.object(browserTargetScopeShape),
    },
    async ({ sessionId, tabId }) => {
      const target = resolveBrowserTarget(browserCoordinator, sessionId, tabId);
      await target.reload();
      return text({ success: true, target: browserTargetState(target) });
    },
  );

  server.registerTool(
    "create_tab",
    {
      description: "Create a new browser tab",
      inputSchema: z.object({
        url: z.string().optional().describe("Optional URL to open"),
        ...browserTargetScopeShape,
      }),
    },
    async ({ url, sessionId, tabId }) => {
      const context = resolveBrowserContext(
        browserCoordinator,
        sessionId,
        tabId,
      );
      const target = await sessionManager.createBrowserTab(
        url,
        context.sessionId,
      );
      return text(target);
    },
  );

  server.registerTool(
    "close_tab",
    {
      description: "Close a browser tab",
      inputSchema: z.object({
        sessionId: browserSessionIdSchema,
        tabId: z.string().describe("Browser tab ID"),
      }),
    },
    async ({ sessionId, tabId }) => {
      const context = resolveBrowserContext(browserCoordinator, sessionId, tabId);
      await context.closeTarget(tabId);
      return text({ success: true, sessionId: context.sessionId, tabId });
    },
  );

  server.registerTool(
    "switch_tab",
    {
      description: "Activate a browser tab",
      inputSchema: z.object({
        sessionId: browserSessionIdSchema,
        tabId: z.string().describe("Browser tab ID"),
      }),
    },
    async ({ sessionId, tabId }) => {
      const context = resolveBrowserContext(browserCoordinator, sessionId, tabId);
      const target = await browserCoordinator.setActiveTarget(context.sessionId, tabId);
      return text(browserTargetState(target));
    },
  );

  server.registerTool(
    "list_tabs",
    {
      description: "List all browser tabs with their URLs and titles",
      inputSchema: z.object(browserTargetScopeShape),
    },
    async ({ sessionId, tabId }) => {
      const context = resolveBrowserContext(browserCoordinator, sessionId, tabId);
      const targets = tabId
        ? [browserCoordinator.resolveTarget(context.sessionId, tabId)]
        : await context.targets();
      return text(targets.map(browserTargetState));
    },
  );

  server.registerTool(
    "clear_browser_env",
    {
      description:
        "Clear all browser data (cookies, localStorage, sessionStorage, cache). Current login state will be lost.",
      inputSchema: z.object(browserTargetScopeShape),
    },
    async ({ sessionId, tabId }) => {
      const context = resolveBrowserContext(browserCoordinator, sessionId, tabId);
      await context.clearData({ storage: true, cache: true, reloadTargets: true });
      return text({ success: true, sessionId: context.sessionId });
    },
  );

  server.registerTool(
    "browser_screenshot",
    {
      description:
        "Capture a screenshot of a browser tab. Returns a PNG image.",
      inputSchema: z.object(browserTargetScopeShape),
    },
    async ({ sessionId, tabId }) => {
      const target = resolveBrowserTarget(browserCoordinator, sessionId, tabId);
      const base64 = (await target.captureScreenshot()).toString("base64");
      return {
        content: [{ type: "image" as const, data: base64, mimeType: "image/png" }],
      };
    },
  );

  server.registerTool(
    "get_page_info",
    {
      description: "Get the URL, title, loading state, and history state of a browser tab",
      inputSchema: z.object(browserTargetScopeShape),
    },
    async ({ sessionId, tabId }) => {
      const target = resolveBrowserTarget(browserCoordinator, sessionId, tabId);
      return text(browserTargetState(target));
    },
  );

  server.registerTool(
    "cdp_send_command",
    {
      description:
        "Send a raw Chrome DevTools Protocol (CDP) command to a browser tab. " +
        "Supports all CDP domains: Page, DOM, Runtime, Network, Emulation, Input, etc. " +
        "See https://chromedevtools.github.io/devtools-protocol/ for available methods.",
      inputSchema: z.object({
        method: z.string().describe("CDP method name, e.g. 'Page.captureScreenshot', 'Runtime.evaluate', 'DOM.getDocument'"),
        params: z.record(z.string(), z.unknown()).optional().describe("CDP method parameters as a JSON object"),
        ...browserTargetScopeShape,
      }),
    },
    async ({ method, params, sessionId, tabId }) => {
      const target = resolveBrowserTarget(browserCoordinator, sessionId, tabId);
      const lease = await target.getCdpTransport().then((transport) =>
        transport.acquire(`mcp:${randomUUID()}`),
      );
      try {
        return text(await lease.send(method, params));
      } finally {
        await lease.release();
      }
    },
  );

  // -- Data Query --

  server.registerTool(
    "get_requests",
    {
      description:
        "Get all captured HTTP requests for a session. Returns method, url, status, headers, body, and response for each request.",
      inputSchema: z.object({ sessionId: z.string() }),
    },
    async ({ sessionId }) => {
      const requests = requestsRepo.findBySession(sessionId);
      // Trim large bodies to keep response manageable
      const trimmed = requests.map((r) => ({
        id: r.id,
        sequence: r.sequence,
        method: r.method,
        url: r.url,
        status_code: r.status_code,
        content_type: r.content_type,
        duration_ms: r.duration_ms,
        request_body: r.request_body
          ? r.request_body.length > 2000
            ? r.request_body.substring(0, 2000) + "..."
            : r.request_body
          : null,
        response_body: r.response_body
          ? r.response_body.length > 2000
            ? r.response_body.substring(0, 2000) + "..."
            : r.response_body
          : null,
      }));
      return text(trimmed);
    },
  );

  server.registerTool(
    "filter_requests",
    {
      description:
        "Filter captured HTTP requests for a session by method, domain, status code, content type, or URL pattern. Returns matching requests with trimmed bodies.",
      inputSchema: z.object({
        sessionId: z.string(),
        method: z.string().optional().describe("HTTP method filter, e.g. GET, POST"),
        domain: z.string().optional().describe("Domain/host to match in URL"),
        statusCode: z.number().optional().describe("Exact status code, e.g. 200, 404"),
        statusRange: z.string().optional().describe("Status code range: 2xx, 3xx, 4xx, 5xx"),
        contentType: z.string().optional().describe("Content-Type contains match, e.g. json, html"),
        urlPattern: z.string().optional().describe("URL substring match"),
        limit: z.number().optional().describe("Max results to return (default 50)"),
      }),
    },
    async ({ sessionId, method, domain, statusCode, statusRange, contentType, urlPattern, limit }) => {
      const requests = requestsRepo.findBySessionFiltered(sessionId, {
        method, domain, statusCode, statusRange, contentType, urlPattern, limit,
      });
      const trimmed = requests.map((r) => ({
        id: r.id,
        sequence: r.sequence,
        method: r.method,
        url: r.url,
        status_code: r.status_code,
        content_type: r.content_type,
        duration_ms: r.duration_ms,
        request_body: r.request_body
          ? r.request_body.length > 2000
            ? r.request_body.substring(0, 2000) + "..."
            : r.request_body
          : null,
        response_body: r.response_body
          ? r.response_body.length > 2000
            ? r.response_body.substring(0, 2000) + "..."
            : r.response_body
          : null,
      }));
      return text(trimmed);
    },
  );

  server.registerTool(
    "get_request_detail",
    {
      description:
        "Get full details of a single captured request by its UUID (the `id` field from get_requests). For sequence numbers cited in reports as [#12], use get_request_by_seq instead.",
      inputSchema: z.object({ requestId: z.string().describe("Request UUID, not the #seq") }),
    },
    async ({ requestId }) => {
      const req = requestsRepo.findById(requestId);
      if (!req) return text({ error: "Request not found" });
      return text(req);
    },
  );

  server.registerTool(
    "get_hooks",
    {
      description:
        "Get all JS Hook records for a session (crypto operations, XHR/fetch intercepts, etc.)",
      inputSchema: z.object({ sessionId: z.string() }),
    },
    async ({ sessionId }) => {
      const hooks = jsHooksRepo.findBySession(sessionId);
      return text(hooks);
    },
  );

  server.registerTool(
    "get_storage",
    {
      description:
        "Get storage snapshots (cookies, localStorage, sessionStorage) for a session",
      inputSchema: z.object({ sessionId: z.string() }),
    },
    async ({ sessionId }) => {
      const snapshots = storageSnapshotsRepo.findBySession(sessionId);
      return text(snapshots);
    },
  );

  // -- AI Analysis --

  server.registerTool(
    "run_analysis",
    {
      description:
        "Run AI-powered protocol analysis on captured session data. Uses the LLM configured in app settings. Returns a full analysis report.",
      inputSchema: z.object({
        sessionId: z.string().describe("Session ID to analyze"),
        purpose: z
          .string()
          .optional()
          .describe(
            "Analysis focus: 'reverse-api', 'security-audit', 'performance', 'crypto-reverse', or custom text",
          ),
        selectedSeqs: z
          .array(z.number())
          .optional()
          .describe("Optional: specific request sequence numbers to analyze"),
      }),
    },
    async ({ sessionId, purpose, selectedSeqs }) => {
      const config = loadLLMConfig();
      if (!config)
        return text({
          error:
            "LLM not configured. Please configure LLM settings in the app first.",
        });
      // 与界面路径一致：purpose 命中模板 id 时使用用户可编辑的模板
      const template = purpose ? findTemplate(purpose) : findTemplate("auto");
      const report = await aiAnalyzer.analyze(
        sessionId,
        config,
        undefined,
        purpose,
        template ?? undefined,
        selectedSeqs,
      );
      try {
        chatMessagesRepo.insertMany(report.id, aiAnalyzer.buildInitialChatMessages(report));
      } catch {
        // 初始对话落库失败不影响返回报告；chat_followup 会按需补建
      }
      return text({
        id: report.id,
        purpose: report.purpose,
        model: report.llm_model,
        content: report.report_content,
        spec: aiAnalyzer.getSpec(report),
        specError: report.spec_error,
      });
    },
  );

  server.registerTool(
    "get_reports",
    {
      description:
        "List analysis reports for a session (newest first) with metadata and a short preview. Use get_report for the full content.",
      inputSchema: z.object({ sessionId: z.string() }),
    },
    async ({ sessionId }) => {
      const reports = reportsRepo.findBySession(sessionId);
      return text(
        reports.map((r) => ({
          id: r.id,
          created_at: r.created_at,
          llm_model: r.llm_model,
          purpose: r.purpose,
          hasSpec: Boolean(r.spec_json),
          specError: r.spec_error,
          preview:
            r.report_content.length > REPORT_PREVIEW_CHARS
              ? r.report_content.substring(0, REPORT_PREVIEW_CHARS) + "..."
              : r.report_content,
        })),
      );
    },
  );

  server.registerTool(
    "get_report",
    {
      description:
        "Get one analysis report by id. format=markdown returns the human-readable report, json returns the structured ProtocolSpec, both returns both.",
      inputSchema: z.object({
        reportId: z.string().describe("Report ID (from get_reports / run_analysis)"),
        format: z.enum(["markdown", "json", "both"]).optional().default("both"),
      }),
    },
    async ({ reportId, format }) => {
      const report = reportsRepo.findById(reportId);
      if (!report) return text({ error: "Report not found" });
      const base = {
        id: report.id,
        session_id: report.session_id,
        created_at: report.created_at,
        llm_model: report.llm_model,
        purpose: report.purpose,
      };
      if (format === "markdown") return text({ ...base, content: report.report_content });
      const spec = aiAnalyzer.getSpec(report);
      if (format === "json") return text({ ...base, spec, specError: report.spec_error });
      return text({ ...base, content: report.report_content, spec, specError: report.spec_error });
    },
  );

  server.registerTool(
    "get_protocol_spec",
    {
      description:
        "Get the structured ProtocolSpec (endpoints, auth chain, flows, storage, crypto, reproduction code) for a session's latest report or a specific report. Extracts it on demand if missing.",
      inputSchema: z.object({
        sessionId: z.string().optional().describe("Session ID; uses the latest report"),
        reportId: z.string().optional().describe("Specific report ID (takes precedence over sessionId)"),
      }),
    },
    async ({ sessionId, reportId }) => {
      const target = reportId ? reportsRepo.findById(reportId) : sessionId ? latestReportOf(sessionId) : undefined;
      if (!target) return text({ error: reportId ? "Report not found" : "No report for this session; run run_analysis first" });
      let report = target;
      if (!report.spec_json) {
        const config = loadLLMConfig();
        if (!config) return text({ error: "Spec not extracted yet and LLM not configured" });
        report = await aiAnalyzer.ensureSpec(report.id, config);
      }
      const spec = aiAnalyzer.getSpec(report);
      if (!spec) return text({ reportId: report.id, error: report.spec_error ?? "Spec extraction failed" });
      return text({ reportId: report.id, spec });
    },
  );

  server.registerTool(
    "get_openapi",
    {
      description:
        "Generate an OpenAPI 3.1 document from the session's structured ProtocolSpec (latest report). Extracts the spec on demand if missing.",
      inputSchema: z.object({ sessionId: z.string() }),
    },
    async ({ sessionId }) => {
      let report = latestReportOf(sessionId);
      if (!report) return text({ error: "No report for this session; run run_analysis first" });
      if (!report.spec_json) {
        const config = loadLLMConfig();
        if (!config) return text({ error: "Spec not extracted yet and LLM not configured" });
        report = await aiAnalyzer.ensureSpec(report.id, config);
      }
      const spec = aiAnalyzer.getSpec(report);
      if (!spec) return text({ reportId: report.id, error: report.spec_error ?? "Spec extraction failed" });
      const meta = sessionMetaOf(sessionId);
      return text(buildOpenApiDocument(spec, {
        sessionName: meta.name,
        targetUrl: meta.targetUrl,
        generatedAt: report.created_at,
      }));
    },
  );

  server.registerTool(
    "get_session_enrichment",
    {
      description:
        "Rule-derived session facts without calling an LLM: scene hints, auth chain (token/cookie sources and consumers), storage diff, streaming request seqs.",
      inputSchema: z.object({ sessionId: z.string() }),
    },
    async ({ sessionId }) => text(aiAnalyzer.getSessionEnrichment(sessionId)),
  );

  server.registerTool(
    "get_session_brief",
    {
      description:
        "Compact (~2k tokens) briefing of a session for another agent's context: counts, scene hints, auth chain, endpoint list (from the ProtocolSpec when available) and the latest report summary.",
      inputSchema: z.object({ sessionId: z.string() }),
    },
    async ({ sessionId }) => {
      const meta = sessionMetaOf(sessionId);
      // 有报告缓存时不重新组装整个会话；只有没有 Spec 需要从索引凑端点清单时才走 assemble
      const enrichment = aiAnalyzer.getSessionEnrichment(sessionId);
      const report = latestReportOf(sessionId);
      const spec = report ? aiAnalyzer.getSpec(report) : null;
      const hookCount = jsHooksRepo.countBySession(sessionId);
      const totalRequests = enrichment.totalRequests ?? requestsRepo.countBySession(sessionId);

      const endpoints = spec
        ? spec.endpoints.slice(0, BRIEF_ENDPOINT_LIMIT).map((endpoint) => ({
            id: endpoint.id,
            method: endpoint.method,
            url: endpoint.urlTemplate,
            purpose: endpoint.purpose,
            auth: endpoint.auth,
            seqs: endpoint.exampleSeqs.slice(0, 3),
          }))
        : (() => {
            const assembler = new DataAssembler(requestsRepo, jsHooksRepo, storageSnapshotsRepo);
            return dedupeEndpoints(assembler.extractSummaries(assembler.assemble(sessionId))).slice(0, BRIEF_ENDPOINT_LIMIT);
          })();

      return text({
        session: { id: sessionId, name: meta.name, targetUrl: meta.targetUrl },
        counts: { requests: totalRequests, analyzedRequests: enrichment.requestCount, hooks: hookCount, reports: reportsRepo.countBySession(sessionId) },
        sceneHints: enrichment.sceneHints.slice(0, BRIEF_HINT_LIMIT).map((hint) => ({ scene: hint.scene, confidence: hint.confidence, seqs: hint.relatedRequestIds })),
        authChain: enrichment.authChain.map((item) => ({ type: item.credentialType, source: item.source, consumers: item.consumers.slice(0, 5) })),
        streamingSeqs: enrichment.streamingSeqs.slice(0, 20),
        endpoints,
        endpointsSource: spec ? "protocol-spec" : "request-index",
        latestReport: report
          ? {
              id: report.id,
              created_at: report.created_at,
              purpose: report.purpose,
              scene: spec?.scene ?? null,
              summary: spec?.summary ?? report.report_content.slice(0, REPORT_PREVIEW_CHARS),
              hasSpec: Boolean(spec),
            }
          : null,
        nextSteps: [
          "get_report(reportId) for the full markdown / spec",
          "get_request_by_seq(sessionId, seqs) to inspect cited requests",
          "get_openapi(sessionId) for an OpenAPI 3.1 document",
        ],
      });
    },
  );

  server.registerTool(
    "get_request_by_seq",
    {
      description:
        "Get full captured requests by their sequence numbers (#seq, the numbers cited in reports as [#12]). Use this instead of get_request_detail when you have seqs rather than UUIDs.",
      inputSchema: z.object({
        sessionId: z.string(),
        seqs: z.array(z.number().int()).min(1).max(20).describe("Request sequence numbers"),
      }),
    },
    async ({ sessionId, seqs }) => {
      const wanted = new Set(seqs);
      const requests = requestsRepo.findBySession(sessionId).filter((r) => wanted.has(r.sequence));
      const found = new Set(requests.map((r) => r.sequence));
      return text({
        requests,
        missing: seqs.filter((seq) => !found.has(seq)),
      });
    },
  );

  server.registerTool(
    "chat_followup",
    {
      description:
        "Send a follow-up question about the latest analysis report of a session. Conversation history is persisted per report.",
      inputSchema: z.object({
        sessionId: z.string().describe("Session ID"),
        message: z.string().describe("Follow-up question"),
      }),
    },
    async ({ sessionId, message }) => {
      const config = loadLLMConfig();
      if (!config) return text({ error: "LLM not configured" });
      const report = latestReportOf(sessionId);
      if (!report) return text({ error: "No report for this session; run run_analysis first" });

      let history: ChatMessage[] = chatMessagesRepo.findByReport(report.id).map((m) => ({
        role: m.role as ChatMessage["role"],
        content: m.content,
      }));
      if (history.length === 0) {
        history = aiAnalyzer.buildInitialChatMessages(report);
        chatMessagesRepo.insertMany(report.id, history);
      }

      const reply = await aiAnalyzer.chat(sessionId, config, history, message, undefined, report.id);
      chatMessagesRepo.append(report.id, "user", message);
      chatMessagesRepo.append(report.id, "assistant", reply);

      return text({ reportId: report.id, reply: stripToolContext(reply) });
    },
  );

  // -- Interaction Recording --

  const replayEngine = new ReplayEngine();

  server.registerTool(
    "get_interactions",
    {
      description:
        "Get recorded user interaction events (clicks, inputs, scrolls, mouse movements) for a session. " +
        "Returns element selectors, positions, input values, and timestamps.",
      inputSchema: z.object({
        sessionId: z.string().describe("Session ID"),
        type: z.enum(['click', 'dblclick', 'input', 'scroll', 'navigate', 'hover']).optional().describe("Filter by interaction type"),
        limit: z.number().default(100).describe("Max events to return"),
      }),
    },
    async ({ sessionId, type, limit }) => {
      const events = type
        ? interactionEventsRepo.findBySessionAndType(sessionId, type as InteractionType)
        : interactionEventsRepo.findBySession(sessionId, limit);
      return text(events.slice(0, limit));
    },
  );

  server.registerTool(
    "get_interaction_summary",
    {
      description:
        "Get a high-level summary of recorded interactions: action sequence, key elements, and navigation flow. " +
        "Useful for understanding what the user did before asking AI to automate it.",
      inputSchema: z.object({ sessionId: z.string() }),
    },
    async ({ sessionId }) => {
      const events = interactionEventsRepo.findBySession(sessionId, 500);
      if (events.length === 0) {
        return text({ summary: "No interactions recorded for this session.", steps: [] });
      }

      // Generate human-readable summary
      const steps: string[] = [];
      let stepNum = 1;
      for (const event of events) {
        if (event.type === 'hover') continue; // skip movement in summary
        let desc = '';
        switch (event.type) {
          case 'click':
          case 'dblclick': {
            const target = event.element_text || event.selector || `(${event.x}, ${event.y})`;
            desc = `${event.type === 'dblclick' ? 'Double-click' : 'Click'} "${target}" [${event.tag_name || 'element'}]`;
            break;
          }
          case 'input': {
            const field = event.selector || event.tag_name || 'input';
            desc = `Type "${event.input_value}" into ${field}`;
            break;
          }
          case 'scroll': {
            desc = `Scroll to (${event.scroll_x}, ${event.scroll_y})`;
            break;
          }
          case 'navigate': {
            desc = `Navigate to ${event.url}`;
            break;
          }
        }
        if (desc) {
          steps.push(`${stepNum++}. ${desc}`);
        }
      }

      return text({
        totalEvents: events.length,
        clickCount: events.filter(e => e.type === 'click' || e.type === 'dblclick').length,
        inputCount: events.filter(e => e.type === 'input').length,
        scrollCount: events.filter(e => e.type === 'scroll').length,
        pagesVisited: [...new Set(events.map(e => e.url))],
        steps,
      });
    },
  );

  server.registerTool(
    "replay_interactions",
    {
      description:
        "Replay recorded user interactions in the browser via CDP Input simulation. " +
        "Reproduces clicks, inputs, scrolls in the original sequence.",
      inputSchema: z.object({
        sessionId: browserSessionIdSchema.describe(
          "Session ID with recorded interactions (defaults to the active browser Session)",
        ),
        tabId: browserTabIdSchema,
        speed: z.number().default(2).describe("Playback speed multiplier (2 = 2x faster)"),
        fromSequence: z.number().optional().describe("Start from this sequence number"),
        toSequence: z.number().optional().describe("Stop at this sequence number"),
        skipMoves: z.boolean().default(true).describe("Skip mouse movement events"),
      }),
    },
    async ({ sessionId, tabId, speed, fromSequence, toSequence, skipMoves }) => {
      const target = resolveBrowserTarget(browserCoordinator, sessionId, tabId);
      const sourceSessionId = sessionId ?? target.sessionId;
      let events = interactionEventsRepo.findBySession(sourceSessionId, 10000);
      if (fromSequence != null) events = events.filter(e => e.sequence >= fromSequence);
      if (toSequence != null) events = events.filter(e => e.sequence <= toSequence);

      if (events.length === 0) return text({ error: "No interactions to replay" });

      const result = await replayEngine.replay(target, events, { speed, skipMoves });
      return text(result);
    },
  );

  server.registerTool(
    "cancel_replay",
    {
      description: "Cancel the currently running interaction replay, if any.",
      inputSchema: z.object({}),
    },
    async () => {
      replayEngine.abort();
      return text({ success: true });
    },
  );

  server.registerTool(
    "execute_browser_action",
    {
      description:
        "Execute a single browser action: click an element, type text, scroll, or navigate. " +
        "Use CSS selectors from interaction recordings or get_page_elements to target elements.",
      inputSchema: z.object({
        action: z.enum(['click', 'type', 'scroll', 'navigate']).describe("Action to perform"),
        selector: z.string().optional().describe("CSS selector of target element (for click/type)"),
        text: z.string().optional().describe("Text to type (for 'type' action)"),
        url: z.string().optional().describe("URL to navigate (for 'navigate' action)"),
        x: z.number().optional().describe("X coordinate (for click without selector)"),
        y: z.number().optional().describe("Y coordinate (for click without selector)"),
        scrollDelta: z.number().optional().describe("Scroll delta in pixels (for 'scroll' action, positive=down)"),
        ...browserTargetScopeShape,
      }),
    },
    async ({ action, selector, text: inputText, url, x, y, scrollDelta, sessionId, tabId }) => {
      const target = resolveBrowserTarget(browserCoordinator, sessionId, tabId);
      const result = await replayEngine.executeAction(target, {
        type: action, selector, text: inputText, url, x, y, scrollDelta,
      });
      return text(result);
    },
  );

  server.registerTool(
    "get_page_elements",
    {
      description:
        "Get interactive elements on the current page with their CSS selectors, text content, and bounding boxes. " +
        "Use this to discover what elements are available before executing browser actions.",
      inputSchema: z.object({
        filter: z.enum(['all', 'clickable', 'inputs', 'links', 'buttons']).default('clickable')
          .describe("Element filter: 'clickable' for buttons/links/interactive, 'inputs' for form fields"),
        ...browserTargetScopeShape,
      }),
    },
    async ({ filter, sessionId, tabId }) => {
      const target = resolveBrowserTarget(browserCoordinator, sessionId, tabId);
      const selectorMap: Record<string, string> = {
        all: 'a, button, input, select, textarea, [role="button"], [onclick], [tabindex]',
        clickable: 'a, button, [role="button"], [onclick], [tabindex]:not(input):not(textarea)',
        inputs: 'input, select, textarea',
        links: 'a[href]',
        buttons: 'button, [role="button"], input[type="submit"], input[type="button"]',
      };

      const result = await target.evaluate(`
        (function() {
          const selector = ${JSON.stringify(selectorMap[filter] || selectorMap.clickable)};
          const elements = Array.from(document.querySelectorAll(selector)).slice(0, 50);
          return elements.map(el => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) return null; // hidden
            const id = el.id && !(/[0-9a-f]{8,}|_\\d+$|^:r\\d+:|^ember\\d+/.test(el.id))
              ? '#' + el.id : null;
            const testId = el.getAttribute('data-testid');
            const selector = id || (testId ? '[data-testid=\"' + testId + '\"]' : null)
              || (el.className && typeof el.className === 'string'
                ? el.tagName.toLowerCase() + '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.')
                : el.tagName.toLowerCase());
            return {
              selector,
              tag: el.tagName.toLowerCase(),
              type: el.getAttribute('type'),
              text: (el.textContent || '').trim().slice(0, 80),
              placeholder: el.getAttribute('placeholder'),
              href: el.getAttribute('href'),
              rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
            };
          }).filter(Boolean);
        })()
      `);

      return text(result);
    },
  );
}

// ---- Resource Registration ----

function registerResources(server: McpServer, deps: MCPServerDeps): void {
  const { sessionManager, browserCoordinator, reportsRepo } = deps;

  server.registerResource(
    "sessions",
    "sessions://list",
    {
      description: "List of all analysis sessions",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify(sessionManager.listSessions(), null, 2),
          mimeType: "application/json",
        },
      ],
    }),
  );

  server.registerResource(
    "app-status",
    "app://status",
    {
      description:
        "Current application status including active session and capture state",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify(
            {
              currentSessionId: sessionManager.getCurrentSessionId(),
              mcpServerRunning: isMCPServerRunning(),
            },
            null,
            2,
          ),
          mimeType: "application/json",
        },
      ],
    }),
  );

  server.registerResource(
    "browser-tabs",
    "browser://tabs",
    {
      description: "Current browser tabs",
    },
    async (uri) => {
      const context = resolveBrowserContext(browserCoordinator);
      const tabs = (await context.targets()).map(browserTargetState);
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(tabs, null, 2),
            mimeType: "application/json",
          },
        ],
      };
    },
  );

  server.registerResource(
    "report",
    new ResourceTemplate("report://{reportId}", {
      list: async () => ({
        resources: sessionManager.listSessions().flatMap((session) =>
          reportsRepo.findBySession(session.id).map((report) => ({
            uri: `report://${report.id}`,
            name: `${session.name} · ${new Date(report.created_at).toISOString()}`,
            description: `Analysis report (${report.purpose ?? "auto"}, ${report.llm_model})`,
            mimeType: "text/markdown",
          })),
        ),
      }),
    }),
    { description: "Full markdown of one analysis report" },
    async (uri, variables) => {
      const reportId = String(variables.reportId ?? "");
      const report = reportsRepo.findById(reportId);
      return {
        contents: [
          {
            uri: uri.href,
            text: report ? report.report_content : `Report ${reportId} not found`,
            mimeType: "text/markdown",
          },
        ],
      };
    },
  );

  server.registerResource(
    "protocol-spec",
    new ResourceTemplate("spec://{sessionId}", {
      list: async () => ({
        resources: sessionManager.listSessions().flatMap((session) => {
          const latest = reportsRepo.findBySession(session.id)[0];
          if (!latest?.spec_json) return [];
          return [{
            uri: `spec://${session.id}`,
            name: `${session.name} · ProtocolSpec`,
            description: "Structured protocol spec of the latest report",
            mimeType: "application/json",
          }];
        }),
      }),
    }),
    { description: "Structured ProtocolSpec JSON of a session's latest report (already extracted only)" },
    async (uri, variables) => {
      const sessionId = String(variables.sessionId ?? "");
      const latest = reportsRepo.findBySession(sessionId)[0];
      const spec: ProtocolSpec | null = latest ? parseProtocolSpecJson(latest.spec_json) : null;
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(spec ?? { error: latest ? (latest.spec_error ?? "Spec not extracted yet; call get_protocol_spec") : "No report for this session" }, null, 2),
            mimeType: "application/json",
          },
        ],
      };
    },
  );
}

// ---- Helpers ----

/** 没有 Spec 时用请求索引凑一份端点清单：按 METHOD + pathname 去重，带首个序号 */
function dedupeEndpoints(summaries: Array<{ seq: number; method: string; url: string }>): Array<{ method: string; url: string; seqs: number[] }> {
  const byKey = new Map<string, { method: string; url: string; seqs: number[] }>();
  for (const summary of summaries) {
    let path = summary.url;
    let origin = "";
    try {
      const parsed = new URL(summary.url);
      origin = parsed.origin;
      path = parsed.pathname;
    } catch {
      /* keep full url */
    }
    const key = `${summary.method} ${origin}${path}`;
    const existing = byKey.get(key);
    if (existing) {
      if (existing.seqs.length < 3) existing.seqs.push(summary.seq);
    } else {
      byKey.set(key, { method: summary.method, url: `${origin}${path}`, seqs: [summary.seq] });
    }
  }
  return [...byKey.values()];
}

function resolveBrowserContext(
  browserCoordinator: BrowserCoordinator,
  sessionId?: string,
  tabId?: string,
): BrowserContext {
  const context = sessionId
    ? browserCoordinator.resolveContext(sessionId)
    : browserCoordinator.getActiveContext();
  if (!context) {
    throw new BrowserBackendError(
      "CONTEXT_NOT_FOUND",
      "No browser Session is active; pass sessionId or activate a Session first",
    );
  }
  if (tabId) browserCoordinator.resolveTarget(context.sessionId, tabId);
  return context;
}

function resolveBrowserTarget(
  browserCoordinator: BrowserCoordinator,
  sessionId?: string,
  tabId?: string,
): BrowserTarget {
  if (sessionId) return browserCoordinator.resolveTarget(sessionId, tabId);
  if (tabId) {
    const context = resolveBrowserContext(browserCoordinator);
    return browserCoordinator.resolveTarget(context.sessionId, tabId);
  }
  const target = browserCoordinator.getActiveTarget();
  if (!target) {
    const context = browserCoordinator.getActiveContext();
    throw new BrowserBackendError(
      "TARGET_NOT_FOUND",
      context
        ? `Session ${context.sessionId} has no active browser tab`
        : "No browser Session is active; pass sessionId or activate a Session first",
      context
        ? {
            backendKind: context.backendKind,
            sessionId: context.sessionId,
            contextId: context.id,
          }
        : {},
    );
  }
  return target;
}

function browserTargetState(target: BrowserTarget) {
  return {
    ...target.getState(),
    backendKind: target.backendKind,
  };
}

function text(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        resolve(body ? JSON.parse(body) : undefined);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}
