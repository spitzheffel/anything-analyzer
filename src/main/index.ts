import { app, BrowserWindow, crashReporter, dialog } from "electron";
import { initLogger } from "./logger";
import {
  getDatabase,
  closeDatabase,
  backupBeforeBrowserMigration,
  databasePathFor,
  importDatabaseSnapshot,
} from "./db/database";
import { runMigrations } from "./db/migrations";
import {
  SessionsRepo,
  RequestsRepo,
  JsHooksRepo,
  StorageSnapshotsRepo,
  AnalysisReportsRepo,
  FingerprintProfilesRepo,
  ChatMessagesRepo,
  AiRequestLogRepo,
  InteractionEventsRepo,
  SessionBrowserConfigRepo,
  BrowserProfilesRepo,
  BrowserTabsRepo,
} from "./db/repositories";
import { CaptureEngine } from "./capture/capture-engine";
import { SessionManager } from "./session/session-manager";
import { AiAnalyzer } from "./ai/ai-analyzer";
import { WindowManager } from "./window";
import {
  ensureTokenCalibrationLoaded,
  flushTokenCalibration,
} from "./ai/token-calibration-store";
import {
  registerIpcHandlers,
  loadProxyConfig,
  applyProxy,
  loadMCPServerConfig,
  loadCloakRuntimePolicy,
} from "./ipc";
import { Updater } from "./updater";
import { MCPClientManager } from "./mcp/mcp-manager";
import { initMCPServer, stopMCPServer } from "./mcp/mcp-server";
import { CaManager } from "./proxy/ca-manager";
import { MitmProxyServer } from "./proxy/mitm-proxy-server";
import { loadMitmProxyConfig, saveMitmProxyConfig } from "./proxy/mitm-proxy-config";
import { SystemProxy } from "./proxy/system-proxy";
import { ProfileStore } from "./fingerprint/profile-store";
import { join, resolve } from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { BUILD_CHANNEL, CLOAK_BACKEND_AVAILABLE } from "./build-flavor";
import { BrowserCoordinator } from "./browser/browser-coordinator";
import { ElectronBrowserBackend } from "./browser/electron-backend";
import type { CloakRuntime } from "./browser/cloak-runtime";

const originalUserDataPath = app.getPath("userData");
const packagedSmoke = process.argv.includes("--aa-packaged-smoke");
const packagedUiSmoke = process.argv.includes("--aa-packaged-ui-smoke");
const packagedTest = packagedSmoke || packagedUiSmoke;
const packagedSmokeUserData = process.argv
  .find((argument) => argument.startsWith("--aa-smoke-user-data="))
  ?.slice("--aa-smoke-user-data=".length);

if (packagedTest) {
  if (!packagedSmokeUserData) {
    throw new Error("--aa-packaged-smoke requires --aa-smoke-user-data");
  }
  app.setPath("userData", resolve(packagedSmokeUserData));
} else if (BUILD_CHANNEL === "internal") {
  app.setName("Anything Analyzer Internal");
  app.setPath("userData", join(app.getPath("appData"), "Anything Analyzer Internal"));
}

const windowManager = new WindowManager();
const mcpManager = new MCPClientManager();
let sessionManagerRef: SessionManager | null = null;
let quitInProgress = false;

// Prevent unhandled promise rejections from crashing the main process.
// Common source: executeJavaScript on crashed/destroyed WebContents.
process.on("unhandledRejection", (reason) => {
  console.warn("[Main] Unhandled rejection:", reason);
});

// MITM Proxy — initialized lazily inside whenReady (app.getPath requires ready state)
let caManager: CaManager;
let mitmProxy: MitmProxyServer;

app.whenReady().then(async () => {
  ensureTokenCalibrationLoaded();
  // Initialize structured logging (replaces console.log/warn/error globally)
  initLogger();

  // Enable native crash reporter — dumps go to userData/Crashpad/
  crashReporter.start({ uploadToServer: false });

  // Initialize MITM CA & proxy (requires app.getPath)
  caManager = new CaManager(join(app.getPath("userData"), "mitm-ca"));
  mitmProxy = new MitmProxyServer(caManager);
  if (!packagedTest) await offerPublicDatabaseImport();
  // Initialize database
  const db = getDatabase();
  await backupBeforeBrowserMigration(db);
  runMigrations(db);

  // Initialize repositories
  const sessionsRepo = new SessionsRepo(db);
  const requestsRepo = new RequestsRepo(db);
  const jsHooksRepo = new JsHooksRepo(db);
  const storageSnapshotsRepo = new StorageSnapshotsRepo(db);
  const reportsRepo = new AnalysisReportsRepo(db);
  const chatMessagesRepo = new ChatMessagesRepo(db);
  const fingerprintRepo = new FingerprintProfilesRepo(db);
  const aiRequestLogRepo = new AiRequestLogRepo(db);
  const interactionEventsRepo = new InteractionEventsRepo(db);
  const browserConfigRepo = new SessionBrowserConfigRepo(db);
  const browserProfilesRepo = new BrowserProfilesRepo(db);
  const browserTabsRepo = new BrowserTabsRepo(db);
  const profileStore = new ProfileStore(fingerprintRepo);

  // WindowManager owns only the Electron shell and embedded view layout.
  windowManager.createMainWindow();
  const tabManager = windowManager.initTabs();

  const browserCoordinator = new BrowserCoordinator();
  browserCoordinator.registerBackend(
    new ElectronBrowserBackend(windowManager, tabManager),
  );

  let cloakRuntime: CloakRuntime | undefined;
  if (CLOAK_BACKEND_AVAILABLE) {
    const { CloakBrowserBackend } = await import("./browser/cloak-backend");
    const cloakBackend = new CloakBrowserBackend({
      policy: loadCloakRuntimePolicy(),
      resolveProfile: (options) => {
        const profile = options.profileId
          ? browserProfilesRepo.findById(options.profileId)
          : null;
        if (!profile) {
          throw new Error(
            `Cloak Profile for Session ${options.sessionId} was not found`,
          );
        }
        return {
          profileId: profile.id,
          profileKey: profile.profile_key,
          seed: profile.cloak_seed,
        };
      },
      onProfileTouched: (touch) => {
        if (touch.profileId) {
          browserProfilesRepo.touchLastUsed(touch.profileId, touch.lastUsedAt);
        }
      },
      onBrowserVersionResolved: (resolution) => {
        const config = browserConfigRepo.findBySessionId(resolution.sessionId);
        if (!config) return;
        browserConfigRepo.upsert({
          ...config,
          last_browser_version: resolution.version,
          updated_at: Date.now(),
        });
      },
    });
    cloakRuntime = cloakBackend.getRuntime();
    browserCoordinator.registerBackend(cloakBackend);
  }

  // Initialize capture engine
  const captureEngine = new CaptureEngine(
    requestsRepo,
    jsHooksRepo,
    storageSnapshotsRepo,
  );

  // Initialize session manager
  const sessionManager = new SessionManager(
    sessionsRepo,
    captureEngine,
    profileStore,
    interactionEventsRepo,
    browserCoordinator,
    browserConfigRepo,
    browserProfilesRepo,
    browserTabsRepo,
    cloakRuntime,
  );
  sessionManagerRef = sessionManager;

  // Recover from potential crash
  sessionManager.recoverFromCrash();

  // Initialize AI analyzer
  const aiAnalyzer = new AiAnalyzer(
    sessionsRepo,
    requestsRepo,
    jsHooksRepo,
    storageSnapshotsRepo,
    reportsRepo,
    aiRequestLogRepo,
    interactionEventsRepo,
  );

  // Apply proxy config from saved settings (before IPC handlers)
  const proxyConfig = loadProxyConfig();
  if (proxyConfig && proxyConfig.type !== "none") {
    applyProxy(proxyConfig).catch((err) =>
      console.error("Failed to apply proxy config:", err),
    );
  }

  // Handle proxy authentication challenges globally.
  // Chromium proxyRules cannot carry credentials, so we respond to 407 via this event.
  app.on("login", (event, _webContents, _request, authInfo, callback) => {
    if (authInfo.isProxy) {
      const cfg = loadProxyConfig();
      if (cfg && cfg.username && cfg.password) {
        event.preventDefault();
        callback(cfg.username, cfg.password);
        return;
      }
    }
    // Non-proxy auth or no credentials — let default behavior proceed
    callback();
  });

  // Initialize auto-updater
  const updater = new Updater();
  const mainWin = windowManager.getMainWindow();
  if (mainWin) updater.setMainWindow(mainWin);

  // Inject MCP client manager into AI analyzer
  aiAnalyzer.setMCPManager(mcpManager);

  // Register IPC handlers
  registerIpcHandlers({
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
  });

  // Check for updates on startup (non-blocking, delayed 3s)
  if (!packagedTest) setTimeout(() => updater.checkForUpdates(), 3000);

  // Start MCP Server if enabled
  const mcpServerConfig = loadMCPServerConfig();
  if (mcpServerConfig.enabled) {
    initMCPServer(
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
      mcpServerConfig.port,
      mcpServerConfig.authEnabled,
      mcpServerConfig.authToken,
      mcpServerConfig.host,
    ).catch((err) => console.error("Failed to start MCP Server:", err));
  }

  // Initialize MITM Proxy
  const mitmConfig = loadMitmProxyConfig();

  // Apply upstream proxy config to MITM proxy so outbound traffic routes correctly
  if (proxyConfig && proxyConfig.type !== "none") {
    mitmProxy.setUpstreamProxy(proxyConfig);
  }

  // Wire proxy captured events → CaptureEngine (same data shape as CDP)
  mitmProxy.on("response-captured", (data) => {
    const activeCaptureId = sessionManager.getCurrentSessionId();
    if (
      !activeCaptureId ||
      sessionManager.getSession(activeCaptureId)?.browser_backend === "cloak"
    ) {
      return;
    }
    captureEngine.handleResponseCaptured({ ...data, source: "proxy" });
  });

  if (mitmConfig.enabled) {
    caManager
      .init()
      .then(() => mitmProxy.start(mitmConfig.port))
      .then(() => {
        console.log("[Main] MITM proxy auto-started on port", mitmConfig.port);
        if (mitmConfig.systemProxy) {
          SystemProxy.enable(mitmConfig.port).catch((err) =>
            console.error("[Main] Failed to enable system proxy:", err),
          );
        }
      })
      .catch((err) => console.error("[Main] Failed to auto-start MITM proxy:", err));
  }

  // Trust certificates issued by our MITM CA inside Electron.
  // Without this, HTTPS requests through the MITM proxy fail with SSL errors
  // that can crash Chromium's network stack (0xC0000005).
  app.on("certificate-error", (event, _webContents, _url, _error, certificate, callback) => {
    if (mitmProxy.isRunning() && certificate.issuerName === "Anything Analyzer CA") {
      event.preventDefault();
      callback(true);
    } else {
      callback(false);
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      windowManager.createMainWindow();
      windowManager.initTabs();
      const win = windowManager.getMainWindow();
      if (win) updater.setMainWindow(win);
    }
  });

  if (packagedSmoke) app.quit();
});

async function offerPublicDatabaseImport(): Promise<void> {
  if (BUILD_CHANNEL !== "internal") return;

  const internalUserData = app.getPath("userData");
  const destination = databasePathFor(internalUserData);
  const decisionPath = join(
    internalUserData,
    "data",
    "public-database-import-v1.json",
  );
  if (existsSync(destination) || existsSync(decisionPath)) return;

  const appData = app.getPath("appData");
  const source = [
    originalUserDataPath,
    join(appData, "anything-analyzer"),
    join(appData, "Anything Analyzer"),
  ]
    .map(databasePathFor)
    .find((candidate, index, candidates) =>
      candidates.indexOf(candidate) === index &&
      candidate !== destination &&
      existsSync(candidate),
    );
  if (!source) return;

  const choice = await dialog.showMessageBox({
    type: "question",
    title: "导入公开版数据",
    message: "检测到 Anything Analyzer 公开版数据库",
    detail:
      "是否一次性导入 Session、抓包和报告？浏览器 Binary、凭据和 Profile 目录不会被复制。",
    buttons: ["导入数据库", "使用全新数据库"],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });

  if (choice.response === 0) {
    try {
      await importDatabaseSnapshot(source, destination);
    } catch (error) {
      await dialog.showMessageBox({
        type: "error",
        title: "数据库导入失败",
        message: error instanceof Error ? error.message : String(error),
        detail: "本次不会写入导入决定，下次启动仍可重试。",
      });
      return;
    }
  }

  mkdirSync(join(internalUserData, "data"), { recursive: true });
  writeFileSync(
    decisionPath,
    JSON.stringify({
      decision: choice.response === 0 ? "imported" : "fresh",
      decidedAt: Date.now(),
    }),
    "utf-8",
  );
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (quitInProgress) return;

  // Block immediate quit and perform ordered async cleanup first.
  event.preventDefault();
  quitInProgress = true;
  flushTokenCalibration();

  (async () => {
    try {
      // Mark shutdown state early so tab destroy handlers don't recreate tabs.
      windowManager.setShuttingDown(true);

      // 1) Drain capture, persist profiles, then close all browser contexts.
      await sessionManagerRef?.shutdown().catch((error) => {
        console.error("[Main] Browser shutdown failed:", error);
      });

      // 2) Disable system proxy and persist state.
      await SystemProxy.disable().catch(() => {});
      const config = loadMitmProxyConfig();
      if (config.systemProxy) {
        saveMitmProxyConfig({ ...config, systemProxy: false });
      }

      // 3) Stop async services.
      await mitmProxy.stop().catch(() => {});
      await stopMCPServer().catch(() => {});
      await mcpManager.disconnectAll().catch(() => {});
    } finally {
      // 4) Close DB last, then let Electron finish normal quit flow.
      closeDatabase();
      app.quit();
    }
  })().catch(() => {
    // Ignore and still force-exit via finally block above.
  });
});
