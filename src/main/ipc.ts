import { ipcMain, dialog, app, session, shell } from "electron";
import { networkInterfaces } from "os";
import type {
  AiProgressEvent,
  CloakRuntimePolicy,
  ChatMessage,
  CreateSessionOptions,
  DeleteSessionOptions,
  LLMProviderConfig,
  MCPServerConfig,
  MCPServerSettings,
  MitmProxyConfig,
  ProxyConfig,
  PromptTemplate,
} from "@shared/types";
import type { SessionManager } from "./session/session-manager";
import type { AiAnalyzer } from "./ai/ai-analyzer";
import type { WindowManager } from "./window";
import type { Updater } from "./updater";
import type { MCPClientManager } from "./mcp/mcp-manager";
import type { MitmProxyServer } from "./proxy/mitm-proxy-server";
import type { CaManager } from "./proxy/ca-manager";
import type { ProfileStore } from './fingerprint/profile-store';
import { CertInstaller } from "./proxy/cert-installer";
import { SystemProxy } from "./proxy/system-proxy";
import { loadMitmProxyConfig, saveMitmProxyConfig } from "./proxy/mitm-proxy-config";
import {
  loadTemplates,
  saveTemplate,
  deleteTemplate,
  resetTemplate,
  findTemplate,
} from "./prompt-templates";
import {
  loadMCPServers,
  saveMCPServer,
  deleteMCPServer,
} from "./mcp/mcp-config";
import { buildHar } from "@shared/har-export";
import { buildOpenApiDocument } from "@shared/openapi-export";
import type {
  RequestsRepo,
  JsHooksRepo,
  StorageSnapshotsRepo,
  AnalysisReportsRepo,
  SessionsRepo,
  ChatMessagesRepo,
  AiRequestLogRepo,
  InteractionEventsRepo,
} from "./db/repositories";
import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_MCP_LISTEN_HOST,
  normalizeMCPListenHost,
} from "./mcp/mcp-server-listen";
import { applyModelOverride, fetchLLMModels } from "./ai/model-catalog";
import type { BrowserCoordinator } from "./browser/browser-coordinator";

/**
 * Register all IPC handlers for communication between renderer and main process.
 */

/** Active analysis abort controllers, keyed by sessionId */
const analysisControllers = new Map<string, AbortController>();

/** Report IDs with in-flight chat calls — protected from cascade deletion */
const activeChatReports = new Set<string>();

export function registerIpcHandlers(deps: {
  sessionManager: SessionManager;
  aiAnalyzer: AiAnalyzer;
  windowManager: WindowManager;
  updater: Updater;
  mcpManager: MCPClientManager;
  mitmProxy: MitmProxyServer;
  caManager: CaManager;
  sessionsRepo: SessionsRepo;
  requestsRepo: RequestsRepo;
  jsHooksRepo: JsHooksRepo;
  storageSnapshotsRepo: StorageSnapshotsRepo;
  reportsRepo: AnalysisReportsRepo;
  chatMessagesRepo: ChatMessagesRepo;
  profileStore: ProfileStore;
  aiRequestLogRepo: AiRequestLogRepo;
  interactionEventsRepo: InteractionEventsRepo;
  browserCoordinator: BrowserCoordinator;
}): void {
  const {
    sessionManager,
    aiAnalyzer,
    windowManager,
    updater,
    mcpManager,
    mitmProxy,
    caManager,
    sessionsRepo,
    requestsRepo,
    jsHooksRepo,
    storageSnapshotsRepo,
    reportsRepo,
    chatMessagesRepo,
    profileStore,
    aiRequestLogRepo,
    interactionEventsRepo,
    browserCoordinator,
  } = deps;

  // ---- Session Management ----

  ipcMain.handle(
    "session:create",
    async (
      _event,
      name: string,
      targetUrl: string,
      options?: CreateSessionOptions,
    ) => {
      return sessionManager.createSession(name, targetUrl, options);
    },
  );

  ipcMain.handle("session:list", async () => {
    return sessionManager.listSessions();
  });

  ipcMain.handle("session:start", async (_event, sessionId: string) => {
    const tabManager = windowManager.getTabManager();
    const mainWin = windowManager.getMainWindow();
    if (!tabManager || !mainWin) throw new Error("Browser not ready");
    const proxyConfig = loadProxyConfig();
    await sessionManager.startCapture(
      sessionId,
      tabManager,
      mainWin.webContents,
      proxyConfig,
    );
    await sendTabsReset();
  });

  ipcMain.handle("session:pause", async (_event, sessionId: string) => {
    await sessionManager.pauseCapture(sessionId);
  });

  ipcMain.handle("session:resume", async (_event, sessionId: string) => {
    await sessionManager.resumeCapture(sessionId);
  });

  ipcMain.handle("session:stop", async (_event, sessionId: string) => {
    await sessionManager.stopCapture(sessionId);
  });

  ipcMain.handle(
    "session:setCaptureMode",
    async (_event, sessionId: string, mode: "passive" | "deep") => {
      return sessionManager.setCaptureMode(sessionId, mode);
    },
  );

  ipcMain.handle("session:delete", async (
    _event,
    sessionId: string,
    options?: DeleteSessionOptions,
  ) => {
    // Check if any reports in this session have in-flight chat calls
    const sessionReports = reportsRepo.findBySession(sessionId);
    const hasActiveChat = sessionReports.some(r => activeChatReports.has(r.id));
    if (hasActiveChat) {
      throw new Error("Cannot delete session while AI chat is in progress. Please wait for the response to complete.");
    }
    const tabManager = windowManager.getTabManager();
    await sessionManager.deleteSession(
      sessionId,
      tabManager ?? undefined,
      options,
    );
  });

  // ---- Window Control (frameless window) ----

  ipcMain.handle("window:minimize", () => {
    windowManager.getMainWindow()?.minimize();
  });

  ipcMain.handle("window:maximize", () => {
    const win = windowManager.getMainWindow();
    if (win?.isMaximized()) {
      win.unmaximize();
    } else {
      win?.maximize();
    }
  });

  ipcMain.handle("window:close", () => {
    windowManager.getMainWindow()?.close();
  });

  ipcMain.handle("window:isMaximized", () => {
    return windowManager.getMainWindow()?.isMaximized() ?? false;
  });

  // ---- Browser Control ----

  ipcMain.handle("browser:navigate", async (_event, url: string) => {
    await sessionManager.navigate(url);
  });

  ipcMain.handle("browser:back", async () => {
    await sessionManager.goBack();
  });

  ipcMain.handle("browser:forward", async () => {
    await sessionManager.goForward();
  });

  ipcMain.handle("browser:reload", async () => {
    await sessionManager.reload();
  });

  ipcMain.handle("browser:clearEnv", async (_event, sessionId?: string) => {
    await sessionManager.clearBrowserEnvironment(sessionId);
  });

  ipcMain.handle("browser:setRatio", async (_event, ratio: number) => {
    windowManager.setBrowserRatio(ratio);
  });

  // Renderer reports exact browser placeholder bounds (fire-and-forget)
  ipcMain.on("browser:syncBounds", (_event, bounds: { x: number; y: number; width: number; height: number }) => {
    if (browserCoordinator.getActiveContext()?.backendKind === "electron") {
      windowManager.syncBrowserBounds(bounds);
    }
  });

  ipcMain.handle("browser:setVisible", async (_event, visible: boolean) => {
    const hasActiveElectronContext =
      browserCoordinator.getActiveContext()?.backendKind === "electron";
    // Hiding must always reach WindowManager. In particular, startup has no
    // active Coordinator context but already owns a default WebContentsView.
    windowManager.setTargetViewVisible(visible && hasActiveElectronContext);
  });

  ipcMain.handle("browser:toggleDevTools", async () => {
    await sessionManager.toggleDevTools();
  });

  ipcMain.handle("browser:focus", async (_event, sessionId?: string) => {
    await sessionManager.focusBrowser(sessionId);
  });

  ipcMain.handle("browser:status", async (_event, sessionId?: string) => {
    return sessionManager.getBrowserSessionStatus(sessionId);
  });

  // ---- Tab Management ----

  ipcMain.handle("tabs:create", async (_event, url?: string) => {
    return sessionManager.createBrowserTab(url);
  });

  ipcMain.handle("tabs:close", async (_event, tabId: string) => {
    await sessionManager.closeBrowserTab(tabId);
  });

  ipcMain.handle("tabs:activate", async (_event, tabId: string) => {
    await sessionManager.activateBrowserTab(tabId);
  });

  ipcMain.handle("tabs:list", async () => {
    if (!browserCoordinator.getActiveContext()) return [];
    return sessionManager.listBrowserTabs();
  });

  // Forward only the active Session's scoped backend events.
  const mainWin = windowManager.getMainWindow();
  const sendTabsReset = async (): Promise<void> => {
    if (!mainWin || mainWin.isDestroyed()) return;
    const context = browserCoordinator.getActiveContext();
    const tabs = context ? await sessionManager.listBrowserTabs() : [];
    mainWin.webContents.send("tabs:reset", {
      sessionId: context?.sessionId ?? null,
      contextId: context?.id ?? null,
      tabId: null,
      tabs,
    });
  };
  if (mainWin) {
    browserCoordinator.onEvent((browserEvent) => {
      if (
        mainWin.isDestroyed() ||
        browserEvent.sessionId !== browserCoordinator.getActiveSessionId()
      ) {
        return;
      }
      const scope = {
        sessionId: browserEvent.sessionId,
        contextId: browserEvent.contextId,
        tabId: browserEvent.tabId,
      };
      if (browserEvent.type === "target-created") {
        mainWin.webContents.send("tabs:created", {
          ...scope,
          ...browserEvent.target.getState(),
          id: browserEvent.tabId,
        });
      } else if (browserEvent.type === "target-closed") {
        mainWin.webContents.send("tabs:closed", scope);
      } else if (browserEvent.type === "target-activated") {
        const target = browserCoordinator
          .resolveContext(browserEvent.sessionId)
          .getTarget(browserEvent.tabId);
        mainWin.webContents.send("tabs:activated", {
          ...scope,
          url: target?.url ?? "",
          title: target?.title ?? "",
        });
      } else if (browserEvent.type === "target-updated") {
        mainWin.webContents.send("tabs:updated", {
          ...scope,
          url: browserEvent.target.url,
          title: browserEvent.target.title,
          isLoading: browserEvent.target.isLoading,
        });
      } else if (browserEvent.type === "disconnected") {
        mainWin.webContents.send("tabs:reset", {
          sessionId: browserEvent.sessionId,
          contextId: browserEvent.contextId,
          tabId: null,
          tabs: [],
        });
      }
    });
  }

  // ---- Data Queries ----

  ipcMain.handle("data:requests", async (_event, sessionId: string) => {
    return requestsRepo.findBySession(sessionId);
  });

  ipcMain.handle("data:hooks", async (_event, sessionId: string) => {
    return jsHooksRepo.findBySession(sessionId);
  });

  ipcMain.handle("data:storage", async (_event, sessionId: string) => {
    return storageSnapshotsRepo.findBySession(sessionId);
  });

  ipcMain.handle("data:reports", async (_event, sessionId: string) => {
    return reportsRepo.findBySession(sessionId);
  });

  ipcMain.handle("data:clear", async (_event, sessionId: string) => {
    requestsRepo.deleteBySession(sessionId);
    jsHooksRepo.deleteBySession(sessionId);
    storageSnapshotsRepo.deleteBySession(sessionId);

    // Protect reports with in-flight chat from cascade deletion
    const allReports = reportsRepo.findBySession(sessionId);
    const protectedIds = new Set(
      allReports.filter(r => activeChatReports.has(r.id)).map(r => r.id)
    );

    if (protectedIds.size === 0) {
      reportsRepo.deleteBySession(sessionId);
    } else {
      // Delete only unprotected reports
      for (const r of allReports) {
        if (!protectedIds.has(r.id)) {
          reportsRepo.deleteById(r.id);
        }
      }
    }
  });

  // ---- AI Analysis ----

  ipcMain.handle("ai:analyze", async (_event, sessionId: string, purpose?: string, selectedSeqs?: number[], model?: string) => {
    const savedConfig = loadLLMConfig();
    if (!savedConfig) throw new Error("LLM provider not configured");
    const config = applyModelOverride(savedConfig, model);

    const win = windowManager.getMainWindow();
    const onProgress = win
      ? (event: AiProgressEvent) => {
          win.webContents.send("ai:progress", event);
        }
      : undefined;

    // 连接所有启用的 MCP 服务器
    const mcpServers = loadMCPServers();
    if (mcpServers.some((s) => s.enabled)) {
      await mcpManager.connectAll(mcpServers);
    }

    // Resolve template: if purpose matches a template ID, load it
    const template = purpose ? findTemplate(purpose) : findTemplate("auto");

    // Cancel any existing analysis for this session
    analysisControllers.get(sessionId)?.abort();
    const controller = new AbortController();
    analysisControllers.set(sessionId, controller);

    try {
      const report = await aiAnalyzer.analyze(sessionId, config, onProgress, purpose, template ?? undefined, selectedSeqs, controller.signal);
      // 初始追问对话由主进程统一生成并落库，渲染进程之后用 data:chatMessages 读取
      try {
        chatMessagesRepo.insertMany(report.id, aiAnalyzer.buildInitialChatMessages(report));
      } catch (e) {
        console.warn("[ai:analyze] Failed to persist initial chat messages:", e);
      }
      return report;
    } finally {
      analysisControllers.delete(sessionId);
    }
  });

  ipcMain.handle("report:ensureSpec", async (_event, reportId: string) => {
    const config = loadLLMConfig();
    if (!config) throw new Error("LLM provider not configured");
    return aiAnalyzer.ensureSpec(reportId, config);
  });

  ipcMain.handle("ai:cancel", async (_event, sessionId: string) => {
    analysisControllers.get(sessionId)?.abort();
    analysisControllers.delete(sessionId);
  });

  ipcMain.handle(
    "ai:chat",
    async (
      _event,
      sessionId: string,
      reportId: string,
      history: ChatMessage[],
      userMessage: string,
    ) => {
      const savedConfig = loadLLMConfig();
      if (!savedConfig) throw new Error("LLM provider not configured");
      const report = reportId ? reportsRepo.findById(reportId) : undefined;
      const config = applyModelOverride(
        savedConfig,
        report?.session_id === sessionId ? report.llm_model : undefined,
      );

      const win = windowManager.getMainWindow();
      const onProgress = win
        ? (event: AiProgressEvent) => {
            win.webContents.send("ai:progress", event);
          }
        : undefined;

      if (reportId) {
        activeChatReports.add(reportId);
      }

      try {
        const reply = await aiAnalyzer.chat(sessionId, config, history, userMessage, onProgress, reportId);

        // Persist user message and AI reply to database
        if (reportId) {
          chatMessagesRepo.append(reportId, 'user', userMessage);
          chatMessagesRepo.append(reportId, 'assistant', reply);
        }

        return reply;
      } finally {
        if (reportId) {
          activeChatReports.delete(reportId);
        }
      }
    },
  );

  // ---- Chat Messages Persistence ----

  ipcMain.handle("data:chatMessages", async (_event, reportId: string) => {
    const existing = chatMessagesRepo.findByReport(reportId);
    if (existing.length > 0) return existing;
    // 旧报告没有持久化过初始对话：在主进程补建，避免渲染进程自己拼 prompt
    const report = reportsRepo.findById(reportId);
    if (!report) return existing;
    const initial = aiAnalyzer.buildInitialChatMessages(report);
    try {
      chatMessagesRepo.insertMany(reportId, initial);
    } catch (e) {
      console.warn(`[data:chatMessages] Failed to backfill initial messages for ${reportId}:`, e);
    }
    return initial;
  });

  // ---- Settings ----

  ipcMain.handle("settings:getLLM", async () => {
    return loadLLMConfig();
  });

  ipcMain.handle(
    "settings:saveLLM",
    async (_event, config: LLMProviderConfig) => {
      saveLLMConfig(config);
    },
  );

  ipcMain.handle(
    "settings:listModels",
    async (_event, config?: LLMProviderConfig) => {
      const targetConfig = config ?? loadLLMConfig();
      if (!targetConfig) throw new Error("LLM provider not configured");
      return fetchLLMModels(targetConfig);
    },
  );

  // ---- File Export ----

  const saveTextFile = async (defaultName: string, content: string): Promise<boolean> => {
    const win = windowManager.getMainWindow();
    if (!win) return false;
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: defaultName,
      filters: exportFiltersFor(defaultName),
    });
    if (canceled || !filePath) return false;
    writeFileSync(filePath, content, "utf-8");
    return true;
  };

  ipcMain.handle(
    "dialog:exportFile",
    async (_event, defaultName: string, content: string) => saveTextFile(defaultName, content),
  );

  ipcMain.handle("report:exportSpec", async (_event, reportId: string) => {
    const report = reportsRepo.findById(reportId);
    if (!report) throw new Error(`Report ${reportId} not found`);
    const spec = aiAnalyzer.getSpec(report);
    if (!spec) throw new Error("该报告还没有结构化数据，请先抽取");
    const defaultName = `protocol-spec-${new Date(report.created_at).toISOString().slice(0, 10)}.json`;
    return saveTextFile(defaultName, JSON.stringify(spec, null, 2));
  });

  ipcMain.handle("report:exportOpenApi", async (_event, reportId: string) => {
    const report = reportsRepo.findById(reportId);
    if (!report) throw new Error(`Report ${reportId} not found`);
    const spec = aiAnalyzer.getSpec(report);
    if (!spec) throw new Error("该报告还没有结构化数据，请先抽取");
    const sessionInfo = sessionsRepo.findById(report.session_id);
    const document = buildOpenApiDocument(spec, {
      sessionName: sessionInfo?.name,
      targetUrl: sessionInfo?.target_url,
      generatedAt: report.created_at,
    });
    const defaultName = `openapi-${new Date(report.created_at).toISOString().slice(0, 10)}.json`;
    return saveTextFile(defaultName, JSON.stringify(document, null, 2));
  });

  // ---- Auto Update ----

  ipcMain.handle("app:version", () => {
    return app.getVersion();
  });

  ipcMain.handle("update:check", async () => {
    updater.checkForUpdates();
  });

  ipcMain.on("update:install", () => {
    updater.quitAndInstall();
  });

  // ---- Prompt Templates ----

  ipcMain.handle("templates:list", async () => {
    return loadTemplates();
  });

  ipcMain.handle("templates:save", async (_event, template: PromptTemplate) => {
    saveTemplate(template);
  });

  ipcMain.handle("templates:delete", async (_event, id: string) => {
    deleteTemplate(id);
  });

  ipcMain.handle("templates:reset", async (_event, id: string) => {
    resetTemplate(id);
  });

  // ---- MCP Servers ----

  ipcMain.handle("mcp:list", async () => {
    return loadMCPServers();
  });

  ipcMain.handle("mcp:save", async (_event, server: MCPServerConfig) => {
    saveMCPServer(server);
  });

  ipcMain.handle("mcp:delete", async (_event, id: string) => {
    deleteMCPServer(id);
    // 同时断开该服务器连接
    await mcpManager.disconnect(id);
  });

  // ---- Export Requests ----

  ipcMain.handle("data:exportRequests", async (_event, sessionId: string) => {
    const win = windowManager.getMainWindow();
    if (!win) return false;
    const requests = requestsRepo.findBySession(sessionId);
    if (requests.length === 0) return false;
    const sessionInfo = sessionsRepo.findById(sessionId);
    const sessionName = sessionInfo?.name || "requests";
    const timestamp = new Date().toISOString().slice(0, 10);
    const defaultName = `${sessionName}-${timestamp}.json`;
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: defaultName,
      filters: [
        { name: "JSON", extensions: ["json"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (canceled || !filePath) return false;
    writeFileSync(filePath, JSON.stringify(requests, null, 2), "utf-8");
    return true;
  });

  ipcMain.handle("data:exportHar", async (_event, sessionId: string) => {
    const requests = requestsRepo.findBySession(sessionId);
    if (requests.length === 0) return false;
    const sessionInfo = sessionsRepo.findById(sessionId);
    const sessionName = sessionInfo?.name || "requests";
    const timestamp = new Date().toISOString().slice(0, 10);
    const har = buildHar(requests, {
      name: sessionInfo?.name,
      targetUrl: sessionInfo?.target_url,
      appVersion: app.getVersion(),
    });
    return saveTextFile(`${sessionName}-${timestamp}.har`, JSON.stringify(har, null, 2));
  });

  // ---- AI Request Logs ----

  ipcMain.handle("data:aiRequestLogs", async (_event, sessionId: string) => {
    return aiRequestLogRepo.findBySession(sessionId);
  });

  ipcMain.handle("data:aiRequestLogsAll", async (_event, limit: number, offset: number) => {
    return aiRequestLogRepo.findAll(limit, offset);
  });

  ipcMain.handle("data:aiRequestLogDetail", async (_event, id: number) => {
    return aiRequestLogRepo.findById(id);
  });

  // ---- Proxy ----

  ipcMain.handle("proxy:get", async () => {
    return loadProxyConfig();
  });

  ipcMain.handle("proxy:restartImpact", async () => {
    return sessionManager.getOpenCloakSessions().map((item) => ({
      id: item.id,
      name: item.name,
      status: item.status,
    }));
  });

  ipcMain.handle("proxy:save", async (_event, config: ProxyConfig) => {
    const next = validateProxyConfig(config);
    const previous = loadProxyConfig();
    await sessionManager.restartOpenCloakContexts(next, previous);
    try {
      await applyProxy(next);
      await browserCoordinator.updateOpenContextProxies(
        "electron",
        next,
        previous,
      );
      saveProxyConfigFile(next);
      deps.mitmProxy.setUpstreamProxy(next);
    } catch (error) {
      await sessionManager
        .restartOpenCloakContexts(previous, next)
        .catch(() => undefined);
      await applyProxy(previous).catch(() => undefined);
      await browserCoordinator
        .updateOpenContextProxies("electron", previous, next)
        .catch(() => undefined);
      deps.mitmProxy.setUpstreamProxy(previous);
      restoreProxyConfigFile(previous);
      throw error;
    }
  });

  // ---- CloakBrowser Runtime / Retained Profiles ----

  ipcMain.handle("cloak:status", async () => {
    return await sessionManager.getCloakStatus();
  });

  ipcMain.handle(
    "cloak:prepare",
    async (_event, policy?: CloakRuntimePolicy) => {
      const status = await sessionManager.prepareCloakRuntime(policy);
      if (policy) saveCloakRuntimePolicy(policy);
      return status;
    },
  );

  ipcMain.handle(
    "cloak:setPolicy",
    async (_event, policy: CloakRuntimePolicy) => {
      const status = await sessionManager.setCloakRuntimePolicy(policy);
      saveCloakRuntimePolicy(policy);
      return status;
    },
  );

  ipcMain.handle("browser-profiles:listRetained", async () => {
    return sessionManager.listRetainedProfiles();
  });

  ipcMain.handle(
    "browser-profiles:restore",
    async (_event, profileId: string) => {
      return sessionManager.restoreBrowserProfile(profileId);
    },
  );

  ipcMain.handle(
    "browser-profiles:delete",
    async (_event, profileId: string) => {
      await sessionManager.deleteBrowserProfile(profileId);
    },
  );

  // ---- MCP Server Config ----

  ipcMain.handle("mcp-server:getConfig", async () => {
    return loadMCPServerConfig();
  });

  ipcMain.handle("mcp-server:saveConfig", async (_event, config: MCPServerSettings) => {
    const normalizedConfig: MCPServerSettings = {
      ...config,
      host: normalizeMCPListenHost(config.host),
    };
    saveMCPServerConfig(normalizedConfig);

    const { initMCPServer, stopMCPServer, isMCPServerRunning } = await import("./mcp/mcp-server");
    if (normalizedConfig.enabled) {
      await initMCPServer(
        {
          sessionManager,
          aiAnalyzer,
          windowManager,
          browserCoordinator,
          requestsRepo,
          jsHooksRepo,
          storageSnapshotsRepo,
          reportsRepo,
          chatMessagesRepo,
          interactionEventsRepo,
        },
        normalizedConfig.port,
        normalizedConfig.authEnabled,
        normalizedConfig.authToken,
        normalizedConfig.host,
      );
    } else if (isMCPServerRunning()) {
      await stopMCPServer();
    }
  });

  ipcMain.handle("mcp-server:status", async () => {
    const { isMCPServerRunning } = await import("./mcp/mcp-server");
    const config = loadMCPServerConfig();
    return { running: isMCPServerRunning(), host: config.host, port: config.port };
  });

  // ---- MITM Proxy ----

  ipcMain.handle("mitm-proxy:getConfig", async () => {
    return loadMitmProxyConfig();
  });

  ipcMain.handle("mitm-proxy:saveConfig", async (_event, config: MitmProxyConfig) => {
    saveMitmProxyConfig(config);
    if (config.enabled && !deps.mitmProxy.isRunning()) {
      await deps.caManager.init();
      await deps.mitmProxy.start(config.port);
    } else if (!config.enabled && deps.mitmProxy.isRunning()) {
      await deps.mitmProxy.stop();
      // Also disable system proxy if it was enabled
      if (config.systemProxy) {
        await SystemProxy.disable();
        saveMitmProxyConfig({ ...config, systemProxy: false });
      }
    }
  });

  ipcMain.handle("mitm-proxy:status", async () => {
    const config = loadMitmProxyConfig();
    // Collect local IPv4 addresses for LAN device configuration
    const localIPs: string[] = [];
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === "IPv4" && !net.internal) {
          localIPs.push(net.address);
        }
      }
    }
    return {
      running: deps.mitmProxy.isRunning(),
      port: deps.mitmProxy.getPort(),
      caInitialized: deps.caManager.isInitialized(),
      caInstalled: config.caInstalled,
      caCertPath: deps.caManager.isInitialized() ? deps.caManager.getCaCertPath() : null,
      systemProxyEnabled: config.systemProxy,
      localIPs,
    };
  });

  ipcMain.handle("mitm-proxy:installCA", async () => {
    // Ensure CA is generated before trying to install
    if (!deps.caManager.isInitialized()) {
      await deps.caManager.init();
    }
    const result = await CertInstaller.install(deps.caManager.getCaCertPath());
    if (result.success) {
      const config = loadMitmProxyConfig();
      saveMitmProxyConfig({ ...config, caInstalled: true });
    }
    return result;
  });

  ipcMain.handle("mitm-proxy:uninstallCA", async () => {
    if (!deps.caManager.isInitialized()) {
      await deps.caManager.init();
    }
    const result = await CertInstaller.uninstall(deps.caManager.getCaCertPath());
    if (result.success) {
      const config = loadMitmProxyConfig();
      saveMitmProxyConfig({ ...config, caInstalled: false });
    }
    return result;
  });

  ipcMain.handle("mitm-proxy:exportCA", async () => {
    if (!deps.caManager.isInitialized()) {
      await deps.caManager.init();
    }
    const { dialog } = await import("electron");
    const win = deps.windowManager.getMainWindow();
    if (!win) return false;
    const certPath = deps.caManager.getCaCertPath();
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: "anything-analyzer-ca.crt",
      filters: [
        { name: "Certificate", extensions: ["crt", "pem"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (canceled || !filePath) return false;
    const { readFileSync, writeFileSync } = await import("fs");
    writeFileSync(filePath, readFileSync(certPath));
    return true;
  });

  ipcMain.handle("mitm-proxy:regenerateCA", async () => {
    if (deps.mitmProxy.isRunning()) await deps.mitmProxy.stop();
    await deps.caManager.regenerate();
    const config = loadMitmProxyConfig();
    saveMitmProxyConfig({ ...config, caInstalled: false });
  });

  ipcMain.handle("mitm-proxy:enableSystemProxy", async () => {
    const config = loadMitmProxyConfig();
    const result = await SystemProxy.enable(config.port);
    if (result.success) {
      saveMitmProxyConfig({ ...config, systemProxy: true });
    }
    return result;
  });

  ipcMain.handle("mitm-proxy:disableSystemProxy", async () => {
    const result = await SystemProxy.disable();
    if (result.success) {
      const config = loadMitmProxyConfig();
      saveMitmProxyConfig({ ...config, systemProxy: false });
    }
    return result;
  });

  // ---- Shell ----
  ipcMain.handle("shell:openExternal", async (_event, url: string) => {
    // 渲染层可能把模型生成的链接传过来，只放行网页和邮件协议
    let protocol = "";
    try {
      protocol = new URL(url).protocol;
    } catch {
      return;
    }
    if (protocol !== "http:" && protocol !== "https:" && protocol !== "mailto:") {
      console.warn(`[shell:openExternal] Blocked non-web URL: ${url.slice(0, 120)}`);
      return;
    }
    const { shell } = await import("electron");
    await shell.openExternal(url);
  });

  // ---- Fingerprint Profile ----

  ipcMain.handle("fingerprint:get", async (_event, sessionId: string) => {
    return profileStore.get(sessionId) ?? null;
  });

  ipcMain.handle("fingerprint:update", async (_event, profileJson: string) => {
    const profile = JSON.parse(profileJson);
    if (sessionManager.getSession(profile.sessionId)?.browser_backend === "cloak") {
      throw new Error("CloakBrowser manages its own fingerprint Profile");
    }
    profileStore.update(profile);
  });

  ipcMain.handle("fingerprint:regenerate", async (_event, sessionId: string) => {
    if (sessionManager.getSession(sessionId)?.browser_backend === "cloak") {
      throw new Error("CloakBrowser manages its own fingerprint Profile");
    }
    return profileStore.regenerate(sessionId) ?? null;
  });

  ipcMain.handle("fingerprint:enable", async (event, sessionId: string) => {
    const tabManager = windowManager.getTabManager();
    if (!tabManager) throw new Error("Browser not ready");
    const proxyConfig = loadProxyConfig();
    await sessionManager.enableStealth(
      sessionId,
      tabManager,
      proxyConfig,
      event.sender,
    );
    await sendTabsReset();
  });

  ipcMain.handle("fingerprint:disable", async () => {
    await sessionManager.disableStealth();
    await sendTabsReset();
  });

  // ---- Interaction Recording ----

  ipcMain.handle("interaction:getEvents", async (_event, sessionId: string, limit?: number) => {
    return interactionEventsRepo.findBySession(sessionId, limit ?? 1000);
  });

  ipcMain.handle("interaction:getCount", async (_event, sessionId: string) => {
    return interactionEventsRepo.count(sessionId);
  });

  ipcMain.handle("interaction:clear", async (_event, sessionId: string) => {
    interactionEventsRepo.deleteBySession(sessionId);
  });

  // ---- Log Files ----

  ipcMain.handle("log:getPath", () => {
    return join(app.getPath("userData"), "logs", "main.log");
  });

  ipcMain.handle("log:openFolder", async () => {
    const logDir = join(app.getPath("userData"), "logs");
    shell.openPath(logDir);
  });

  ipcMain.handle("log:export", async () => {
    const logPath = join(app.getPath("userData"), "logs", "main.log");
    if (!existsSync(logPath)) return false;
    const mainWin = windowManager.getMainWindow();
    const result = await dialog.showSaveDialog(mainWin!, {
      defaultPath: `anything-analyzer-logs-${new Date().toISOString().slice(0, 10)}.log`,
      filters: [{ name: "Log Files", extensions: ["log", "txt"] }],
    });
    if (result.canceled || !result.filePath) return false;
    const { copyFileSync } = await import("fs");
    copyFileSync(logPath, result.filePath);
    return true;
  });
}

// ---- Config persistence helpers ----

/** 按默认文件名的扩展名挑选保存对话框的类型过滤器 */
function exportFiltersFor(defaultName: string): Electron.FileFilter[] {
  const ext = defaultName.split(".").pop()?.toLowerCase();
  const primary: Electron.FileFilter | null =
    ext === "har" ? { name: "HAR", extensions: ["har"] }
    : ext === "json" ? { name: "JSON", extensions: ["json"] }
    : ext === "md" ? { name: "Markdown", extensions: ["md"] }
    : ext === "yaml" || ext === "yml" ? { name: "YAML", extensions: ["yaml", "yml"] }
    : null;
  return [...(primary ? [primary] : []), { name: "All Files", extensions: ["*"] }];
}

function getConfigPath(): string {
  return join(app.getPath("userData"), "llm-config.json");
}

export function loadLLMConfig(): LLMProviderConfig | null {
  const path = getConfigPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as LLMProviderConfig;
  } catch {
    return null;
  }
}

function saveLLMConfig(config: LLMProviderConfig): void {
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
}

// ---- Cloak runtime policy (contains no credentials) ----

function getCloakRuntimeConfigPath(): string {
  return join(app.getPath("userData"), "cloak-runtime-config.json");
}

export function loadCloakRuntimePolicy(): CloakRuntimePolicy {
  const path = getCloakRuntimeConfigPath();
  if (!existsSync(path)) return "strict";
  try {
    const value = JSON.parse(readFileSync(path, "utf-8")) as {
      policy?: unknown;
    };
    return value.policy === "free-latest" ? "free-latest" : "strict";
  } catch {
    return "strict";
  }
}

function saveCloakRuntimePolicy(policy: CloakRuntimePolicy): void {
  if (policy !== "strict" && policy !== "free-latest") {
    throw new Error("Invalid Cloak runtime policy");
  }
  writeFileSync(
    getCloakRuntimeConfigPath(),
    JSON.stringify({ policy }, null, 2),
    "utf-8",
  );
}

// ---- Proxy config persistence ----

function getProxyConfigPath(): string {
  return join(app.getPath("userData"), "proxy-config.json");
}

export function loadProxyConfig(): ProxyConfig | null {
  const path = getProxyConfigPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ProxyConfig;
  } catch {
    return null;
  }
}

function saveProxyConfigFile(config: ProxyConfig): void {
  const path = getProxyConfigPath();
  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(config, null, 2), "utf-8");
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

function restoreProxyConfigFile(config: ProxyConfig | null): void {
  try {
    if (config) saveProxyConfigFile(config);
    else if (existsSync(getProxyConfigPath())) unlinkSync(getProxyConfigPath());
  } catch (error) {
    console.error("Failed to restore the previous proxy configuration:", error);
  }
}

function validateProxyConfig(value: unknown): ProxyConfig {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid proxy configuration");
  }
  const config = value as Record<string, unknown>;
  if (!["none", "http", "https", "socks5"].includes(String(config.type))) {
    throw new Error("Invalid proxy type");
  }
  const type = config.type as ProxyConfig["type"];
  if (type === "none") return { type, host: "", port: 0 };
  const host = typeof config.host === "string" ? config.host.trim() : "";
  const port = config.port;
  if (
    !host ||
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error("Invalid proxy host or port");
  }
  if (
    (config.username !== undefined && typeof config.username !== "string") ||
    (config.password !== undefined && typeof config.password !== "string")
  ) {
    throw new Error("Invalid proxy credentials");
  }
  return {
    type,
    host,
    port,
    ...(config.username ? { username: config.username } : {}),
    ...(config.password ? { password: config.password } : {}),
  };
}

export async function applyProxy(
  config: ProxyConfig | null,
  elSession: Electron.Session = session.defaultSession,
): Promise<void> {
  if (!config || config.type === "none") {
    await elSession.setProxy({ mode: "direct" });
    return;
  }

  // Chromium proxyRules do NOT support inline credentials (user:pass@host)
  // — that causes ERR_NO_SUPPORTED_PROXIES. Use plain host:port instead.
  // Proxy auth is handled via app.on('login') in index.ts.
  const proxyRules = `${config.type}://${config.host}:${config.port}`;
  await elSession.setProxy({ proxyRules });
}

// ---- MCP Server config persistence ----

const DEFAULT_MCP_SERVER_CONFIG: MCPServerSettings = {
  enabled: false,
  host: DEFAULT_MCP_LISTEN_HOST,
  port: 23816,
  authEnabled: true,
  authToken: '',
};

function getMCPServerConfigPath(): string {
  return join(app.getPath("userData"), "mcp-server-config.json");
}

export function loadMCPServerConfig(): MCPServerSettings {
  const path = getMCPServerConfigPath();
  let config: MCPServerSettings;
  if (!existsSync(path)) {
    config = { ...DEFAULT_MCP_SERVER_CONFIG };
  } else {
    try {
      config = { ...DEFAULT_MCP_SERVER_CONFIG, ...JSON.parse(readFileSync(path, "utf-8")) };
    } catch {
      config = { ...DEFAULT_MCP_SERVER_CONFIG };
    }
  }
  try {
    config.host = normalizeMCPListenHost(config.host);
  } catch {
    config.host = DEFAULT_MCP_LISTEN_HOST;
  }
  // Auto-generate token if empty (first run or upgraded from old config)
  if (!config.authToken) {
    config.authToken = randomUUID();
    saveMCPServerConfig(config);
  }
  return config;
}

function saveMCPServerConfig(config: MCPServerSettings): void {
  writeFileSync(getMCPServerConfigPath(), JSON.stringify(config, null, 2), "utf-8");
}
