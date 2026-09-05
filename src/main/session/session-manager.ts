import { randomInt } from "node:crypto";
import { ipcMain } from "electron";
import type { Session as ElectronSession, WebContents } from "electron";
import { v4 as uuidv4 } from "uuid";
import type {
  BrowserBackendKind,
  BrowserProfile,
  BrowserSessionRuntimeStatus,
  BrowserTab,
  BrowserTabState,
  CaptureMode,
  CloakRuntimePolicy,
  CloakRuntimeStatus,
  CreateSessionOptions,
  DeleteSessionOptions,
  ProxyConfig,
  RawInteractionData,
  Session,
  SessionBrowserConfig,
} from "@shared/types";
import type {
  BrowserProfilesRepo,
  BrowserTabsRepo,
  InteractionEventsRepo,
  SessionBrowserConfigRepo,
  SessionsRepo,
} from "../db/repositories";
import type { ProfileStore } from "../fingerprint/profile-store";
import type { TabManager } from "../tab-manager";
import { BrowserCoordinator } from "../browser/browser-coordinator";
import type { BrowserCoordinatorEvent } from "../browser/browser-coordinator";
import {
  BrowserBackendError,
  type BrowserContext,
  type BrowserTarget,
} from "../browser/contracts";
import type {
  CloakRuntime,
} from "../browser/cloak-runtime";
import { CaptureEngine } from "../capture/capture-engine";
import { InteractionRecorder } from "../capture/interaction-recorder";
import { JsInjector } from "../capture/js-injector";
import { StorageCollector } from "../capture/storage-collector";
import { CdpManager } from "../cdp/cdp-manager";
import { buildStealthScript } from "../../preload/stealth-script";

interface TabCaptureBundle {
  sessionId: string;
  target: BrowserTarget;
  cdp: CdpManager;
  storage: StorageCollector;
}

interface TargetScope {
  sessionId: string;
  tabId: string;
}

interface CaptureStateSnapshot {
  sessionId: string;
  status: Session["status"];
}

interface CloakCapacityAttempt {
  evictedActiveSessionId: string | null;
}

const PUBLIC_CLOAK_STATUS: CloakRuntimeStatus = {
  available: false,
  state: "unavailable",
  loggedIn: false,
  plan: null,
  seats: 0,
  policy: "strict",
  configuredVersion: null,
  actualVersion: null,
  error: "CloakBrowser is not available in this build",
  errorCode: "BACKEND_NOT_AVAILABLE",
  downloadProgress: null,
};

/**
 * Owns analysis Session lifecycle and delegates every browser operation to the
 * BrowserCoordinator. Only one analysis capture can run at a time; browser
 * contexts may remain warm subject to the Cloak seat/LRU limit.
 */
export class SessionManager {
  private currentSessionId: string | null = null;
  private activeBrowserSessionId: string | null = null;
  private rendererWebContents: WebContents | null = null;
  private lastProxyConfig: ProxyConfig | null = null;
  private readonly tabCaptures = new Map<string, TabCaptureBundle>();
  private browserLifecycleTail: Promise<void> = Promise.resolve();
  private readonly pendingCaptureAttachments = new Map<string, Promise<void>>();
  private readonly suspendingCaptureSessions = new Set<string>();
  private readonly injectors = new Map<string, JsInjector>();
  private readonly pendingTargetPreparations = new Map<string, Promise<void>>();
  private interactionRecorder: InteractionRecorder | null = null;
  private interactionRecorderSessionId: string | null = null;
  private readonly electronTargetScopes = new Map<number, TargetScope>();
  private readonly preparedElectronStealthTargets = new WeakSet<BrowserTarget>();
  private readonly openingSessions = new Set<string>();
  private readonly sessionErrors = new Map<string, string>();
  private readonly intentionalContextCloses = new Set<string>();
  private readonly crashRecoveryAttempts = new Map<string, number>();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;

  private readonly hookIpcHandler = (
    event: Electron.IpcMainEvent,
    data: unknown,
  ): void => {
    const scope = this.electronTargetScopes.get(event.sender.id);
    if (!scope || scope.sessionId !== this.currentSessionId) return;
    this.handlePageMessage(scope.sessionId, data);
  };

  private readonly unsubscribeCoordinator: () => void;

  constructor(
    private readonly sessionsRepo: SessionsRepo,
    private readonly captureEngine: CaptureEngine,
    private readonly profileStore: ProfileStore | undefined,
    private readonly interactionEventsRepo: InteractionEventsRepo | undefined,
    private readonly browserCoordinator: BrowserCoordinator,
    private readonly browserConfigRepo: SessionBrowserConfigRepo,
    private readonly browserProfilesRepo: BrowserProfilesRepo,
    private readonly browserTabsRepo: BrowserTabsRepo,
    private readonly cloakRuntime?: CloakRuntime,
  ) {
    ipcMain.on("capture:hook-data", this.hookIpcHandler);
    this.unsubscribeCoordinator = browserCoordinator.onEvent((event) => {
      void this.handleBrowserEvent(event).catch((error) => {
        this.sessionErrors.set(event.sessionId, errorMessage(error));
        console.error(
          `[SessionManager] Browser event ${event.type} failed for ${event.sessionId}:`,
          error,
        );
      });
    });
  }

  createSession(
    name: string,
    targetUrl: string,
    options: CreateSessionOptions = {},
  ): Session {
    const backend = options.backend ?? "electron";
    const captureMode = options.captureMode ?? (backend === "cloak" ? "passive" : "deep");
    this.assertBackendAndMode(backend, captureMode);

    const now = Date.now();
    const sessionId = uuidv4();
    const session: Session = {
      id: sessionId,
      name: name.trim() || "Untitled Session",
      target_url: targetUrl.trim(),
      status: "stopped",
      created_at: now,
      stopped_at: null,
    };

    let profile: BrowserProfile | null = null;
    if (backend === "cloak") {
      profile = {
        id: uuidv4(),
        display_name: session.name,
        profile_key: `profile_${uuidv4().replaceAll("-", "")}`,
        cloak_seed: String(randomInt(10_000, 2_147_483_647)),
        state: "attached",
        last_used_at: null,
        retained_at: null,
        last_error: null,
        created_at: now,
        updated_at: now,
      };
    }

    return this.sessionsRepo.transaction(() => {
      this.sessionsRepo.insert(session);
      if (profile) this.browserProfilesRepo.insert(profile);
      this.browserConfigRepo.upsert({
        session_id: sessionId,
        browser_backend: backend,
        capture_mode: captureMode,
        profile_id: profile?.id ?? null,
        last_browser_version: null,
        created_at: now,
        updated_at: now,
      });
      if (backend === "electron") this.profileStore?.getOrCreate(sessionId);
      return this.requireSession(sessionId);
    });
  }

  listSessions(): Session[] {
    return this.sessionsRepo.findAll();
  }

  getSession(sessionId: string): Session | null {
    return this.sessionsRepo.findById(sessionId) ?? null;
  }

  async activateSession(
    sessionId: string,
    rendererWebContents?: WebContents,
    proxyConfig?: ProxyConfig | null,
  ): Promise<BrowserContext> {
    return this.enqueueBrowserLifecycle(() =>
      this.activateSessionNow(sessionId, rendererWebContents, proxyConfig),
    );
  }

  private async activateSessionNow(
    sessionId: string,
    rendererWebContents?: WebContents,
    proxyConfig?: ProxyConfig | null,
  ): Promise<BrowserContext> {
    const session = this.requireSession(sessionId);
    const interruptedCapture =
      this.currentSessionId && this.currentSessionId !== sessionId
        ? {
            sessionId: this.currentSessionId,
            status: this.requireSession(this.currentSessionId).status,
          } satisfies CaptureStateSnapshot
        : null;
    if (
      this.currentSessionId &&
      this.currentSessionId !== sessionId
    ) {
      await this.stopCaptureNow(this.currentSessionId);
    }
    if (rendererWebContents) this.rendererWebContents = rendererWebContents;
    if (proxyConfig !== undefined) this.lastProxyConfig = proxyConfig;

    const wasOpen = this.browserCoordinator.hasOpenSession(sessionId);
    const previouslyActiveSessionId = wasOpen
      ? null
      : this.browserCoordinator.getActiveSessionId();
    const capacityAttempt: CloakCapacityAttempt = {
      evictedActiveSessionId: null,
    };
    let context: BrowserContext;

    try {
      context = wasOpen
        ? this.browserCoordinator.resolveContext(sessionId)
        : await this.openBrowserContext(
            session,
            this.lastProxyConfig,
            capacityAttempt,
          );
    } catch (error) {
      await this.restoreEvictedActiveCloakSession(
        capacityAttempt.evictedActiveSessionId,
        interruptedCapture,
        this.lastProxyConfig,
      );
      throw error;
    }

    try {
      await this.browserCoordinator.setActiveSession(sessionId);
      this.activeBrowserSessionId = sessionId;
      this.sessionErrors.delete(sessionId);
      if (!wasOpen) {
        await this.initializeOpenedContext(session, context);
      } else {
        await this.prepareTargetsForMode(session, await context.targets());
      }
      await this.persistTabsBestEffort(sessionId);
      if (!wasOpen) await this.sendTabsReset(sessionId, context);
      return context;
    } catch (error) {
      if (!wasOpen && (session.browser_backend ?? "electron") === "cloak") {
        await this.rollbackOpenedCloakContext(
          sessionId,
          context,
          previouslyActiveSessionId,
          error,
        );
      }
      await this.restoreEvictedActiveCloakSession(
        capacityAttempt.evictedActiveSessionId,
        interruptedCapture,
        this.lastProxyConfig,
      );
      throw error;
    }
  }

  async deactivateBrowser(): Promise<void> {
    return this.enqueueBrowserLifecycle(() => this.deactivateBrowserNow());
  }

  private async deactivateBrowserNow(): Promise<void> {
    await this.browserCoordinator.setActiveSession(null);
    this.activeBrowserSessionId = null;
    await this.stopPreparedInteractionRecorder();
  }

  /**
   * Kept as the selection entry point used by the current renderer. For Cloak
   * it opens/focuses the external context and deliberately applies no Electron
   * fingerprint overrides.
   */
  async enableStealth(
    sessionId: string,
    _tabManager?: TabManager,
    proxyConfig?: ProxyConfig | null,
    rendererWebContents?: WebContents,
  ): Promise<void> {
    await this.activateSession(
      sessionId,
      rendererWebContents,
      proxyConfig,
    );
  }

  async disableStealth(): Promise<void> {
    await this.deactivateBrowser();
  }

  getStealthSessionId(): string | null {
    return this.activeBrowserSessionId;
  }

  startCapture(
    sessionId: string,
    _tabManager: TabManager | undefined,
    rendererWebContents: WebContents,
    proxyConfig?: ProxyConfig | null,
  ): Promise<void> {
    return this.enqueueBrowserLifecycle(() =>
      this.startCaptureNow(
        sessionId,
        rendererWebContents,
        proxyConfig,
      ),
    );
  }

  private async startCaptureNow(
    sessionId: string,
    rendererWebContents: WebContents,
    proxyConfig?: ProxyConfig | null,
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    if (this.currentSessionId === sessionId && session.status === "running") {
      return;
    }
    this.suspendingCaptureSessions.delete(sessionId);
    if (this.currentSessionId && this.currentSessionId !== sessionId) {
      await this.stopCaptureNow(this.currentSessionId);
    }

    // Opening and runtime preparation happen before the DB state transition.
    // A license, binary, or profile failure therefore leaves the Session stopped.
    const context = await this.activateSessionNow(
      sessionId,
      rendererWebContents,
      proxyConfig,
    );
    this.currentSessionId = sessionId;
    try {
      this.rendererWebContents = rendererWebContents;
      this.captureEngine.start(sessionId, rendererWebContents);
      this.sessionsRepo.updateStatus(sessionId, "running");

      const targets = await context.targets();
      await this.prepareTargetsForMode(session, targets);
      if (session.capture_mode === "deep") {
        await this.interactionRecorder?.resume();
      }
      const results = await Promise.allSettled(
        targets.map((target) => this.attachCaptureToTarget(session, target)),
      );
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if (result.status === "rejected") {
          console.warn(
            `[SessionManager] Capture attach failed for ${targets[index].tabId}:`,
            errorMessage(result.reason),
          );
        }
      }
      if (
        targets.length > 0 &&
        results.every((result) => result.status === "rejected")
      ) {
        throw (results[0] as PromiseRejectedResult).reason;
      }
    } catch (error) {
      if (this.currentSessionId === sessionId) {
        await this.rollbackFailedCaptureStart(sessionId);
      }
      throw error;
    }
  }

  async pauseCapture(sessionId: string): Promise<void> {
    return this.enqueueBrowserLifecycle(() => this.pauseCaptureNow(sessionId));
  }

  private async pauseCaptureNow(sessionId: string): Promise<void> {
    if (this.currentSessionId !== sessionId) return;
    this.suspendingCaptureSessions.add(sessionId);
    try {
      await this.detachSessionCaptures(sessionId);
      await this.interactionRecorder?.pause();
      this.sessionsRepo.updateStatus(sessionId, "paused");
    } finally {
      this.suspendingCaptureSessions.delete(sessionId);
    }
  }

  async resumeCapture(sessionId: string): Promise<void> {
    return this.enqueueBrowserLifecycle(() => this.resumeCaptureNow(sessionId));
  }

  private async resumeCaptureNow(sessionId: string): Promise<void> {
    if (this.currentSessionId !== sessionId) return;
    const session = this.requireSession(sessionId);
    if (session.status !== "paused") return;
    this.suspendingCaptureSessions.delete(sessionId);
    try {
      const context = this.browserCoordinator.resolveContext(sessionId);
      const targets = await context.targets();
      await this.prepareTargetsForMode(session, targets);
      for (const target of targets) {
        await this.attachCaptureToTarget(session, target);
      }
      await this.interactionRecorder?.resume();
      this.sessionsRepo.updateStatus(sessionId, "running");
    } catch (error) {
      await this.rollbackFailedCaptureResume(sessionId);
      throw error;
    }
  }

  async stopCapture(sessionId: string): Promise<void> {
    return this.enqueueBrowserLifecycle(() => this.stopCaptureNow(sessionId));
  }

  private async stopCaptureNow(sessionId: string): Promise<void> {
    if (this.currentSessionId !== sessionId) return;
    this.suspendingCaptureSessions.add(sessionId);
    let detachError: unknown;
    try {
      await this.detachSessionCaptures(sessionId);
    } catch (error) {
      detachError = error;
    } finally {
      await this.interactionRecorder?.pause();
      this.captureEngine.stop();
      this.sessionsRepo.updateStatus(sessionId, "stopped", Date.now());
      this.currentSessionId = null;
      this.suspendingCaptureSessions.delete(sessionId);
    }
    await this.persistTabsBestEffort(sessionId);
    if (detachError) throw detachError;
  }

  async setCaptureMode(sessionId: string, mode: CaptureMode): Promise<Session> {
    return this.enqueueBrowserLifecycle(() =>
      this.setCaptureModeNow(sessionId, mode),
    );
  }

  private async setCaptureModeNow(
    sessionId: string,
    mode: CaptureMode,
  ): Promise<Session> {
    const session = this.requireSession(sessionId);
    if (session.status !== "stopped") {
      throw new BrowserBackendError(
        "INVALID_ARGUMENT",
        "Capture mode can only be changed while the Session is stopped",
        { backendKind: session.browser_backend, sessionId },
      );
    }
    const backend = session.browser_backend ?? "electron";
    this.assertBackendAndMode(backend, mode);
    const config = this.requireBrowserConfig(session);
    if (config.capture_mode === mode) return session;

    const wasActive = this.activeBrowserSessionId === sessionId;
    await this.persistTabs(sessionId);
    await this.closeBrowserContext(sessionId);
    await this.clearPreparedTargets(sessionId);
    this.browserConfigRepo.upsert({
      ...config,
      capture_mode: mode,
      updated_at: Date.now(),
    });
    const updated = this.requireSession(sessionId);
    if (wasActive) {
      await this.activateSessionNow(
        sessionId,
        this.rendererWebContents ?? undefined,
        this.lastProxyConfig,
      );
    }
    return updated;
  }

  async deleteSession(
    sessionId: string,
    _tabManager?: TabManager,
    options: DeleteSessionOptions = {},
  ): Promise<void> {
    return this.enqueueBrowserLifecycle(() =>
      this.deleteSessionNow(sessionId, options),
    );
  }

  private async deleteSessionNow(
    sessionId: string,
    options: DeleteSessionOptions,
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    if (this.currentSessionId === sessionId) await this.stopCaptureNow(sessionId);
    await this.persistTabs(sessionId);
    await this.closeBrowserContext(sessionId);
    await this.clearPreparedTargets(sessionId);

    const backend = session.browser_backend ?? "electron";
    const profile =
      session.browser_profile_id
        ? this.browserProfilesRepo.findById(session.browser_profile_id)
        : null;
    if (backend === "cloak" && profile) {
      if (options.retainProfile) {
        this.sessionsRepo.transaction(() => {
          this.browserProfilesRepo.updateState(profile.id, "retained");
          this.sessionsRepo.delete(sessionId);
        });
      } else {
        this.sessionsRepo.transaction(() => {
          this.browserProfilesRepo.updateState(profile.id, "deleting");
          this.sessionsRepo.delete(sessionId);
        });
        try {
          await this.browserCoordinator.deletePersistentProfile(
            "cloak",
            profile.profile_key,
          );
          this.browserProfilesRepo.delete(profile.id);
        } catch (error) {
          this.browserProfilesRepo.updateState(
            profile.id,
            "delete_failed",
            errorMessage(error),
          );
          console.warn(
            `[SessionManager] Profile ${profile.id} deletion failed and can be retried:`,
            errorMessage(error),
          );
        }
      }
    } else {
      await this.browserCoordinator
        .deletePersistentProfile("electron", sessionId)
        .catch((error) => {
          console.warn("[SessionManager] Electron profile cleanup failed:", errorMessage(error));
        });
      this.sessionsRepo.delete(sessionId);
    }

    if (this.activeBrowserSessionId === sessionId) {
      this.activeBrowserSessionId = null;
    }
  }

  listRetainedProfiles(): BrowserProfile[] {
    return [
      ...this.browserProfilesRepo.findByState("retained"),
      ...this.browserProfilesRepo.findByState("delete_failed"),
    ];
  }

  restoreBrowserProfile(profileId: string): Session {
    this.assertCloakAvailable();
    const profile = this.browserProfilesRepo.findById(profileId);
    if (!profile || profile.state !== "retained") {
      throw new BrowserBackendError(
        "INVALID_ARGUMENT",
        `Browser Profile ${profileId} is not recoverable`,
        { backendKind: "cloak" },
      );
    }
    const tabs = this.browserTabsRepo.findByProfileId(profileId);
    const activeTab = tabs.find((tab) => tab.active) ?? tabs[0];
    const sessionId = uuidv4();
    const now = Date.now();
    const session: Session = {
      id: sessionId,
      name: `${profile.display_name} (restored)`,
      target_url: activeTab?.url ?? "",
      status: "stopped",
      created_at: now,
      stopped_at: null,
    };
    return this.sessionsRepo.transaction(() => {
      this.sessionsRepo.insert(session);
      this.browserConfigRepo.upsert({
        session_id: sessionId,
        browser_backend: "cloak",
        capture_mode: "passive",
        profile_id: profile.id,
        last_browser_version: null,
        created_at: now,
        updated_at: now,
      });
      this.browserProfilesRepo.updateState(profile.id, "attached");
      return this.requireSession(sessionId);
    });
  }

  async deleteBrowserProfile(profileId: string): Promise<void> {
    this.assertCloakAvailable();
    const profile = this.browserProfilesRepo.findById(profileId);
    if (!profile) return;
    if (profile.state === "attached") {
      throw new BrowserBackendError(
        "INVALID_ARGUMENT",
        "An attached browser Profile must be detached by deleting its Session first",
        { backendKind: "cloak" },
      );
    }
    this.browserProfilesRepo.updateState(profile.id, "deleting");
    try {
      await this.browserCoordinator.deletePersistentProfile(
        "cloak",
        profile.profile_key,
      );
      this.browserProfilesRepo.delete(profile.id);
    } catch (error) {
      this.browserProfilesRepo.updateState(
        profile.id,
        "delete_failed",
        errorMessage(error),
      );
      throw error;
    }
  }

  getBrowserSessionStatus(sessionId?: string): BrowserSessionRuntimeStatus {
    const resolvedId = sessionId ?? this.activeBrowserSessionId;
    if (!resolvedId) {
      return {
        sessionId: null,
        backend: null,
        state: "closed",
        presentation: null,
        version: null,
        error: null,
      };
    }
    const session = this.sessionsRepo.findById(resolvedId);
    if (!session) {
      return {
        sessionId: resolvedId,
        backend: null,
        state: "error",
        presentation: null,
        version: null,
        error: `Session ${resolvedId} was not found`,
      };
    }
    const backend = session.browser_backend ?? "electron";
    const error = this.sessionErrors.get(resolvedId) ?? null;
    return {
      sessionId: resolvedId,
      backend,
      state: this.openingSessions.has(resolvedId)
        ? "opening"
        : error
          ? "error"
          : this.browserCoordinator.hasOpenSession(resolvedId)
            ? "ready"
            : "closed",
      presentation: backend === "cloak" ? "external" : "embedded",
      version:
        backend === "cloak"
          ? session.last_browser_version ?? this.cloakRuntime?.getStatus().actualVersion ?? null
          : process.versions.chrome ?? null,
      error,
    };
  }

  async focusBrowser(sessionId?: string): Promise<void> {
    return this.enqueueBrowserLifecycle(() => this.focusBrowserNow(sessionId));
  }

  private async focusBrowserNow(sessionId?: string): Promise<void> {
    const resolvedId = sessionId ?? this.activeBrowserSessionId;
    if (!resolvedId) {
      throw new BrowserBackendError("CONTEXT_NOT_FOUND", "No browser Session is active");
    }
    if (!this.browserCoordinator.hasOpenSession(resolvedId)) {
      await this.activateSessionNow(
        resolvedId,
        this.rendererWebContents ?? undefined,
        this.lastProxyConfig,
      );
    } else {
      await this.browserCoordinator.setActiveSession(resolvedId);
      this.activeBrowserSessionId = resolvedId;
    }
    const target = this.browserCoordinator.resolveTarget(resolvedId);
    await target.activate();
  }

  async getCloakStatus(): Promise<CloakRuntimeStatus> {
    if (
      !this.cloakRuntime ||
      !this.browserCoordinator.hasBackend("cloak")
    ) {
      return { ...PUBLIC_CLOAK_STATUS };
    }
    return this.cloakRuntime.check();
  }

  async prepareCloakRuntime(
    policy?: CloakRuntimePolicy,
  ): Promise<CloakRuntimeStatus> {
    this.assertCloakAvailable();
    return this.cloakRuntime!.prepare(policy);
  }

  async setCloakRuntimePolicy(
    policy: CloakRuntimePolicy,
  ): Promise<CloakRuntimeStatus> {
    this.assertCloakAvailable();
    if (this.cloakRuntime!.listContexts().length > 0) {
      throw new BrowserBackendError(
        "INVALID_ARGUMENT",
        "Close all Cloak Sessions before changing the runtime policy",
        { backendKind: "cloak" },
      );
    }
    return this.cloakRuntime!.setPolicy(policy);
  }

  getOpenCloakSessions(): Session[] {
    if (!this.cloakRuntime) return [];
    return this.cloakRuntime
      .listContexts()
      .map((context) => this.sessionsRepo.findById(context.sessionId))
      .filter((session): session is Session => Boolean(session));
  }

  async restartOpenCloakContexts(
    nextProxy: ProxyConfig | null,
    previousProxy: ProxyConfig | null,
  ): Promise<void> {
    return this.enqueueBrowserLifecycle(() =>
      this.restartOpenCloakContextsNow(nextProxy, previousProxy),
    );
  }

  private async restartOpenCloakContextsNow(
    nextProxy: ProxyConfig | null,
    previousProxy: ProxyConfig | null,
  ): Promise<void> {
    if (!this.cloakRuntime) return;
    const snapshots = [...this.cloakRuntime.listContexts()];
    if (snapshots.length === 0) {
      this.lastProxyConfig = nextProxy;
      return;
    }
    const activeId = this.activeBrowserSessionId;
    const captureId = this.currentSessionId;
    const captureStatus = captureId
      ? this.sessionsRepo.findById(captureId)?.status
      : null;

    if (captureId && captureStatus !== "stopped") {
      await this.stopCaptureNow(captureId);
    }
    for (const snapshot of snapshots) {
      await this.persistTabs(snapshot.sessionId);
    }
    for (const snapshot of snapshots) {
      await this.closeBrowserContext(snapshot.sessionId);
    }

    try {
      this.lastProxyConfig = nextProxy;
      for (const snapshot of snapshots) {
        const session = this.requireSession(snapshot.sessionId);
        const context = await this.openBrowserContext(session, nextProxy);
        await this.initializeOpenedContext(session, context);
      }
      if (activeId) {
        await this.activateSessionNow(
          activeId,
          this.rendererWebContents ?? undefined,
          nextProxy,
        );
      }
      await this.restoreCaptureState(captureId, captureStatus, nextProxy);
    } catch (error) {
      for (const snapshot of snapshots) {
        await this.closeBrowserContext(snapshot.sessionId).catch(() => undefined);
      }
      this.lastProxyConfig = previousProxy;
      for (const snapshot of snapshots) {
        const session = this.sessionsRepo.findById(snapshot.sessionId);
        if (session) {
          try {
            const context = await this.openBrowserContext(session, previousProxy);
            await this.initializeOpenedContext(session, context);
          } catch (rollbackError) {
            console.error(
              `[SessionManager] Failed to restore Cloak Session ${snapshot.sessionId} after proxy rollback:`,
              rollbackError,
            );
          }
        }
      }
      if (activeId && this.browserCoordinator.hasOpenSession(activeId)) {
        await this.browserCoordinator.setActiveSession(activeId).catch(() => undefined);
        this.activeBrowserSessionId = activeId;
      }
      await this.restoreCaptureState(captureId, captureStatus, previousProxy).catch(
        (rollbackError) => {
          console.error(
            "[SessionManager] Failed to restore capture state after proxy rollback:",
            rollbackError,
          );
        },
      );
      throw error;
    }
  }

  async createBrowserTab(
    url?: string,
    sessionId?: string,
  ): Promise<BrowserTab> {
    const context = sessionId
      ? this.browserCoordinator.resolveContext(sessionId)
      : this.requireActiveContext();
    const session = this.requireSession(context.sessionId);
    const target = await context.createTarget();
    await this.prepareTargetForMode(session, target);
    if (url) await target.navigate(url);
    await this.browserCoordinator.setActiveTarget(context.sessionId, target.tabId);
    this.activeBrowserSessionId = context.sessionId;
    await this.persistTabsBestEffort(session.id);
    return toBrowserTab(target);
  }

  async closeBrowserTab(tabId: string): Promise<void> {
    const context = this.requireActiveContext();
    await context.closeTarget(tabId);
    await this.persistTabsBestEffort(context.sessionId);
  }

  async activateBrowserTab(tabId: string): Promise<void> {
    const context = this.requireActiveContext();
    await this.browserCoordinator.setActiveTarget(context.sessionId, tabId);
    await this.persistTabsBestEffort(context.sessionId);
  }

  async listBrowserTabs(sessionId?: string): Promise<BrowserTab[]> {
    const context = sessionId
      ? this.browserCoordinator.resolveContext(sessionId)
      : this.requireActiveContext();
    return (await context.targets()).map(toBrowserTab);
  }

  async navigate(url: string, sessionId?: string, tabId?: string): Promise<void> {
    const target = this.resolveTarget(sessionId, tabId);
    await target.navigate(url);
  }

  async goBack(sessionId?: string, tabId?: string): Promise<void> {
    await this.resolveTarget(sessionId, tabId).goBack();
  }

  async goForward(sessionId?: string, tabId?: string): Promise<void> {
    await this.resolveTarget(sessionId, tabId).goForward();
  }

  async reload(sessionId?: string, tabId?: string): Promise<void> {
    await this.resolveTarget(sessionId, tabId).reload();
  }

  async clearBrowserEnvironment(sessionId?: string): Promise<void> {
    const context = sessionId
      ? this.browserCoordinator.resolveContext(sessionId)
      : this.requireActiveContext();
    await context.clearData({ storage: true, cache: true, reloadTargets: true });
  }

  async toggleDevTools(): Promise<void> {
    const target = this.resolveTarget();
    if (!target.toggleDevTools) {
      throw new BrowserBackendError(
        "CAPABILITY_UNSUPPORTED",
        "DevTools are managed by the selected browser backend",
        {
          backendKind: target.backendKind,
          sessionId: target.sessionId,
          contextId: target.contextId,
          tabId: target.tabId,
        },
      );
    }
    await target.toggleDevTools();
  }

  getActiveElectronSession(): ElectronSession | null {
    const context = this.browserCoordinator.getActiveContext();
    if (!context || context.backendKind !== "electron") return null;
    return context.getNativeHandle<ElectronSession>();
  }

  recoverFromCrash(): void {
    this.sessionsRepo.transaction(() => {
      const sessions = this.sessionsRepo.findAll();
      const referencedProfileIds = new Set(
        sessions
          .map((session) => session.browser_profile_id)
          .filter((profileId): profileId is string => Boolean(profileId)),
      );
      for (const session of sessions) {
        if (session.status !== "stopped") {
          this.sessionsRepo.updateStatus(session.id, "stopped", Date.now());
        }
      }
      for (const profile of this.browserProfilesRepo.findByState("deleting")) {
        if (referencedProfileIds.has(profile.id)) {
          this.browserProfilesRepo.updateState(profile.id, "attached");
          continue;
        }
        this.browserProfilesRepo.updateState(
          profile.id,
          "delete_failed",
          "Profile deletion was interrupted; retry permanent deletion",
        );
      }
      for (const profile of this.browserProfilesRepo.findByState("attached")) {
        if (referencedProfileIds.has(profile.id)) continue;
        this.browserProfilesRepo.updateState(
          profile.id,
          "retained",
          "Profile attachment was interrupted; retained for recovery",
        );
      }
      for (const profile of this.browserProfilesRepo.findByState("retained")) {
        if (!referencedProfileIds.has(profile.id)) continue;
        this.browserProfilesRepo.updateState(profile.id, "attached");
      }
    });
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  getActiveBrowserSessionId(): string | null {
    return this.activeBrowserSessionId;
  }

  async sendCdpCommand(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    tabId?: string,
  ): Promise<Record<string, unknown>> {
    const target = this.resolveTarget(sessionId, tabId);
    const lease = await (await target.getCdpTransport()).acquire("mcp:raw");
    try {
      return await lease.send(method, params);
    } finally {
      await lease.release();
    }
  }

  recordBrowserVersion(sessionId: string, version: string): void {
    const session = this.sessionsRepo.findById(sessionId);
    if (!session) return;
    const config = this.requireBrowserConfig(session);
    this.browserConfigRepo.upsert({
      ...config,
      last_browser_version: version,
      updated_at: Date.now(),
    });
  }

  touchBrowserProfile(profileId: string, lastUsedAt = Date.now()): void {
    this.browserProfilesRepo.touchLastUsed(profileId, lastUsedAt);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    const attempt = this.enqueueBrowserLifecycle(async () => {
      if (this.currentSessionId) await this.stopCaptureNow(this.currentSessionId);
      if (this.cloakRuntime) {
        for (const context of this.cloakRuntime.listContexts()) {
          await this.persistTabsBestEffort(context.sessionId);
        }
      }
      await this.stopPreparedInteractionRecorder();
      this.unsubscribeCoordinator();
      ipcMain.removeListener("capture:hook-data", this.hookIpcHandler);
      await this.browserCoordinator.shutdown();
    });
    const trackedAttempt = attempt.catch((error) => {
      if (this.shutdownPromise === trackedAttempt) this.shutdownPromise = null;
      throw error;
    });
    this.shutdownPromise = trackedAttempt;
    return trackedAttempt;
  }

  private async openBrowserContext(
    session: Session,
    proxy: ProxyConfig | null,
    capacityAttempt?: CloakCapacityAttempt,
  ): Promise<BrowserContext> {
    const backend = session.browser_backend ?? "electron";
    const mode = session.capture_mode ?? "deep";
    this.assertBackendAndMode(backend, mode);
    const previouslyActiveSessionId =
      backend === "cloak" ? this.browserCoordinator.getActiveSessionId() : null;
    if (backend === "cloak") {
      const evictedActiveSessionId = await this.ensureCloakCapacity(session.id);
      if (capacityAttempt) {
        capacityAttempt.evictedActiveSessionId = evictedActiveSessionId;
      }
    }

    const profile =
      session.browser_profile_id
        ? this.browserProfilesRepo.findById(session.browser_profile_id)
        : null;
    const restoredTabs = profile
      ? this.browserTabsRepo.findByProfileId(profile.id)
      : [];
    if (backend === "cloak" && !profile) {
      throw new BrowserBackendError(
        "BACKEND_FAILURE",
        "The Cloak browser Profile is missing",
        { backendKind: backend, sessionId: session.id },
      );
    }
    if (backend === "cloak" && profile?.state === "missing") {
      throw new BrowserBackendError(
        "PROFILE_MISSING",
        `The saved Cloak profile ${profile.profile_key} is missing`,
        { backendKind: backend, sessionId: session.id },
      );
    }
    if (backend === "cloak" && profile?.state !== "attached") {
      throw new BrowserBackendError(
        "BACKEND_FAILURE",
        `Cloak profile ${profile?.profile_key ?? "unknown"} is not attached to this Session`,
        { backendKind: backend, sessionId: session.id },
      );
    }

    this.openingSessions.add(session.id);
    this.sessionErrors.delete(session.id);
    try {
      return await this.browserCoordinator.openSession({
        backendKind: backend,
        sessionId: session.id,
        profileId: profile?.id ?? null,
        proxy,
        captureMode: mode,
        fingerprint:
          backend === "electron"
            ? this.profileStore?.getOrCreate(session.id) ?? null
            : null,
        backendOptions: profile
          ? {
              profileKey: profile.profile_key,
              cloakSeed: profile.cloak_seed,
              requireExistingProfile: profile.last_used_at !== null,
              restoredTabs,
            }
          : undefined,
      });
    } catch (error) {
      if (
        previouslyActiveSessionId &&
        this.browserCoordinator.hasOpenSession(previouslyActiveSessionId) &&
        this.browserCoordinator.getActiveSessionId() !== previouslyActiveSessionId
      ) {
        try {
          await this.browserCoordinator.setActiveSession(previouslyActiveSessionId);
          this.activeBrowserSessionId = previouslyActiveSessionId;
        } catch (restoreError) {
          console.warn(
            `[SessionManager] Failed to restore active Session ${previouslyActiveSessionId} after launch failure:`,
            errorMessage(restoreError),
          );
        }
      }
      if (
        backend === "cloak" &&
        profile &&
        error instanceof BrowserBackendError &&
        error.code === "PROFILE_MISSING"
      ) {
        this.browserProfilesRepo.updateState(
          profile.id,
          "missing",
          errorMessage(error),
        );
      }
      this.sessionErrors.set(session.id, errorMessage(error));
      throw error;
    } finally {
      this.openingSessions.delete(session.id);
    }
  }

  private async initializeOpenedContext(
    session: Session,
    context: BrowserContext,
  ): Promise<void> {
    let targets = await context.targets();
    if (targets.length === 0) targets = [await context.createTarget()];
    await this.prepareTargetsForMode(session, targets);

    if ((session.browser_backend ?? "electron") === "cloak") {
      const savedTabs = session.browser_profile_id
        ? this.browserTabsRepo.findByProfileId(session.browser_profile_id)
        : [];
      if (savedTabs.length > 0) {
        while (targets.length < savedTabs.length) {
          const target = await context.createTarget();
          targets.push(target);
          await this.prepareTargetForMode(session, target);
        }
        for (let index = 0; index < savedTabs.length; index += 1) {
          const saved = savedTabs[index];
          const target = targets[index];
          if (saved.url && target.url !== saved.url) await target.navigate(saved.url);
        }
        for (const extra of targets.slice(savedTabs.length)) {
          await extra.close();
        }
        const activeIndex = Math.max(
          0,
          savedTabs.findIndex((tab) => tab.active),
        );
        const activeTarget = targets[activeIndex] ?? targets[0];
        if (activeTarget) await context.activateTarget(activeTarget.tabId);
        return;
      }
    }

    const target =
      targets.find((candidate) => candidate.getState().isActive) ?? targets[0];
    if (
      target &&
      session.target_url &&
      (!target.url || target.url === "about:blank")
    ) {
      await target.navigate(session.target_url);
    }
  }

  private async prepareTargetsForMode(
    session: Session,
    targets: BrowserTarget[],
  ): Promise<void> {
    for (const target of targets) {
      await this.prepareTargetForMode(session, target);
    }
  }

  private async prepareTargetForMode(
    session: Session,
    target: BrowserTarget,
  ): Promise<void> {
    const key = targetKey(session.id, target.tabId);
    const pending = this.pendingTargetPreparations.get(key);
    if (pending) return pending;
    const preparation = this.performTargetPreparation(session, target, key);
    this.pendingTargetPreparations.set(key, preparation);
    try {
      await preparation;
    } finally {
      if (this.pendingTargetPreparations.get(key) === preparation) {
        this.pendingTargetPreparations.delete(key);
      }
    }
  }

  private async performTargetPreparation(
    session: Session,
    target: BrowserTarget,
    key: string,
  ): Promise<void> {
    this.registerElectronTarget(target);
    if ((session.capture_mode ?? "deep") !== "deep") return;

    // A fresh Electron WebContentsView has no document at all. Prime it with an
    // internal blank page so CDP init-script registration and immediate script
    // evaluation cannot wait forever for the first navigation.
    if (target.backendKind === "electron" && !target.url) {
      await target.navigate("about:blank");
    }

    if (
      target.backendKind === "electron" &&
      !this.preparedElectronStealthTargets.has(target)
    ) {
      const profile = this.profileStore?.getOrCreate(session.id);
      if (profile) {
        const source = buildStealthScript(JSON.stringify(profile));
        await target.addInitScript(source);
        this.preparedElectronStealthTargets.add(target);
        // A newly-created WebContentsView has no document yet. Electron keeps
        // executeJavaScript() pending in that state, which would block the first
        // navigation (and shutdown behind the same lifecycle queue). The init
        // script above is sufficient for that first document; only patch an
        // already-loaded target in place.
        if (target.url) await target.evaluate(source).catch(() => undefined);
      }
    }

    let injector = this.injectors.get(key);
    if (!injector) {
      injector = new JsInjector();
      this.injectors.set(key, injector);
    }
    await injector.start(target, (data) => this.handlePageMessage(session.id, data));

    if (
      this.interactionEventsRepo &&
      this.rendererWebContents &&
      (this.activeBrowserSessionId === session.id ||
        this.currentSessionId === session.id)
    ) {
      await this.ensureInteractionRecorder(session.id);
      await this.interactionRecorder?.attachTarget(target);
    }
  }

  private async ensureInteractionRecorder(sessionId: string): Promise<void> {
    if (!this.interactionEventsRepo || !this.rendererWebContents) return;
    if (
      this.interactionRecorder &&
      this.interactionRecorderSessionId !== sessionId
    ) {
      await this.interactionRecorder.stop();
      this.interactionRecorder = null;
      this.interactionRecorderSessionId = null;
    }
    if (!this.interactionRecorder) {
      this.interactionRecorder = new InteractionRecorder(
        this.interactionEventsRepo,
      );
      this.interactionRecorder.start(sessionId, this.rendererWebContents);
      this.interactionRecorderSessionId = sessionId;
      if (this.currentSessionId !== sessionId) {
        await this.interactionRecorder.pause();
      }
    }
  }

  private async stopPreparedInteractionRecorder(): Promise<void> {
    if (this.interactionRecorder) await this.interactionRecorder.stop();
    this.interactionRecorder = null;
    this.interactionRecorderSessionId = null;
  }

  private async attachCaptureToTarget(
    session: Session,
    target: BrowserTarget,
  ): Promise<void> {
    const key = targetKey(session.id, target.tabId);
    if (this.tabCaptures.has(key)) return;
    const pending = this.pendingCaptureAttachments.get(key);
    if (pending) return pending;
    const attachment = this.performCaptureAttachment(session, target, key);
    this.pendingCaptureAttachments.set(key, attachment);
    try {
      await attachment;
    } finally {
      if (this.pendingCaptureAttachments.get(key) === attachment) {
        this.pendingCaptureAttachments.delete(key);
      }
    }
  }

  private async performCaptureAttachment(
    session: Session,
    target: BrowserTarget,
    key: string,
  ): Promise<void> {
    if (!this.canAttachCapture(session.id, target)) return;
    await this.prepareTargetForMode(session, target);
    if (!this.canAttachCapture(session.id, target)) return;

    const cdp = new CdpManager();
    const storage = new StorageCollector();
    let cdpStarted = false;
    let storageStarted = false;
    try {
      await cdp.start(target, session.capture_mode ?? "deep");
      cdpStarted = true;
      cdp.on("response-captured", (data) => {
        if (this.currentSessionId === session.id) {
          this.captureEngine.handleResponseCaptured(data);
        }
      });
      cdp.on("frame-navigated", () => {
        storage.triggerCollection();
        void this.syncInteractionRecordingAfterNavigation(session.id, target);
      });
      storage.on("storage-collected", (data) => {
        if (this.currentSessionId === session.id) {
          this.captureEngine.handleStorageCollected(data);
        }
      });
      await storage.start(session.id, target);
      storageStarted = true;
      if (!this.canAttachCapture(session.id, target)) {
        await storage.stop();
        storageStarted = false;
        await cdp.stop();
        cdpStarted = false;
        return;
      }
      this.tabCaptures.set(key, {
        sessionId: session.id,
        target,
        cdp,
        storage,
      });
    } catch (error) {
      if (storageStarted) await storage.stop().catch(() => undefined);
      if (cdpStarted) await cdp.stop().catch(() => undefined);
      throw error;
    }
  }

  private canAttachCapture(sessionId: string, target: BrowserTarget): boolean {
    return (
      this.currentSessionId === sessionId &&
      !this.suspendingCaptureSessions.has(sessionId) &&
      !target.isClosed()
    );
  }

  private async detachCapture(sessionId: string, tabId: string): Promise<void> {
    const key = targetKey(sessionId, tabId);
    const bundle = this.tabCaptures.get(key);
    if (!bundle) return;
    this.tabCaptures.delete(key);
    let storageError: unknown;
    try {
      await bundle.storage.stop();
    } catch (error) {
      storageError = error;
    }
    try {
      await bundle.cdp.stop();
    } catch (error) {
      if (!storageError) storageError = error;
    }
    if (storageError) throw storageError;
  }

  private async rollbackFailedCaptureStart(sessionId: string): Promise<void> {
    this.suspendingCaptureSessions.add(sessionId);
    try {
      await this.detachSessionCaptures(sessionId).catch((error) => {
        console.warn(
          `[SessionManager] Failed to fully detach capture after Session ${sessionId} start failed:`,
          errorMessage(error),
        );
      });
      await this.interactionRecorder?.pause();
      this.captureEngine.stop();
      if (this.sessionsRepo.findById(sessionId)) {
        this.sessionsRepo.updateStatus(sessionId, "stopped", Date.now());
      }
      this.currentSessionId = null;
    } finally {
      this.suspendingCaptureSessions.delete(sessionId);
    }
  }

  private async rollbackFailedCaptureResume(sessionId: string): Promise<void> {
    this.suspendingCaptureSessions.add(sessionId);
    try {
      await this.detachSessionCaptures(sessionId).catch((error) => {
        console.warn(
          `[SessionManager] Failed to fully detach capture after Session ${sessionId} resume failed:`,
          errorMessage(error),
        );
      });
      await this.interactionRecorder?.pause();
      if (this.sessionsRepo.findById(sessionId)) {
        this.sessionsRepo.updateStatus(sessionId, "paused");
      }
    } finally {
      this.suspendingCaptureSessions.delete(sessionId);
    }
  }

  private async detachSessionCaptures(sessionId: string): Promise<void> {
    const pending = [...this.pendingCaptureAttachments.entries()]
      .filter(([key]) => key.startsWith(`${sessionId}:`))
      .map(([, attachment]) => attachment);
    if (pending.length > 0) await Promise.allSettled(pending);
    const bundles = [...this.tabCaptures.values()].filter(
      (bundle) => bundle.sessionId === sessionId,
    );
    await Promise.all(
      bundles.map((bundle) =>
        this.detachCapture(bundle.sessionId, bundle.target.tabId),
      ),
    );
  }

  private async syncInteractionRecordingAfterNavigation(
    sessionId: string,
    target: BrowserTarget,
  ): Promise<void> {
    const recorder = this.interactionRecorder;
    if (
      this.currentSessionId !== sessionId ||
      recorder?.getSessionId() !== sessionId ||
      !recorder.isRecording()
    ) {
      return;
    }
    try {
      await recorder.syncTargetRecordingState(target);
    } catch (error) {
      console.warn(
        `[SessionManager] Failed to restore interaction recording after navigation for ${target.tabId}:`,
        errorMessage(error),
      );
    }
  }

  private async handleBrowserEvent(
    event: BrowserCoordinatorEvent,
  ): Promise<void> {
    if (this.shuttingDown) return;
    if (event.type === "target-created") {
      if (this.intentionalContextCloses.has(event.sessionId)) return;
      const session = this.sessionsRepo.findById(event.sessionId);
      if (session) {
        await this.prepareTargetForMode(session, event.target);
        if (
          this.currentSessionId === event.sessionId &&
          session.status === "running"
        ) {
          await this.attachCaptureToTarget(session, event.target);
        }
      }
    } else if (event.type === "target-crashed") {
      await this.enqueueBrowserLifecycle(() =>
        this.handleTargetCrash(
          event.sessionId,
          event.tabId,
          event.reason,
        ),
      );
      return;
    } else if (event.type === "target-closed") {
      await this.detachCapture(event.sessionId, event.tabId);
      this.injectors.get(targetKey(event.sessionId, event.tabId))?.stop();
      this.injectors.delete(targetKey(event.sessionId, event.tabId));
      this.interactionRecorder?.detachTarget(event.tabId);
      for (const [id, scope] of this.electronTargetScopes) {
        if (scope.sessionId === event.sessionId && scope.tabId === event.tabId) {
          this.electronTargetScopes.delete(id);
        }
      }
    } else if (
      event.type === "disconnected" &&
      event.backendKind === "cloak"
    ) {
      const intentional = this.intentionalContextCloses.delete(event.sessionId);
      await this.enqueueBrowserLifecycle(() =>
        this.handleUnexpectedCloakDisconnect(event.sessionId, intentional),
      );
      return;
    }

    if (event.backendKind === "cloak") {
      await this.persistTabsBestEffort(event.sessionId);
    }
  }

  private async handleUnexpectedCloakDisconnect(
    sessionId: string,
    intentional = false,
  ): Promise<void> {
    await this.detachSessionCaptures(sessionId).catch((error) => {
      console.warn(
        `[SessionManager] Failed to detach capture after Cloak Session ${sessionId} disconnected:`,
        errorMessage(error),
      );
    });
    if (intentional || this.shuttingDown) return;
    const wasActive = this.activeBrowserSessionId === sessionId;
    const attempts = this.crashRecoveryAttempts.get(sessionId) ?? 0;
    if (attempts >= 1) {
      this.sessionErrors.set(
        sessionId,
        "CloakBrowser exited again after one automatic recovery",
      );
      if (this.currentSessionId === sessionId) {
        await this.rollbackFailedCaptureStart(sessionId);
      }
      return;
    }
    this.crashRecoveryAttempts.set(sessionId, attempts + 1);
    try {
      const session = this.requireSession(sessionId);
      const context = await this.openBrowserContext(session, this.lastProxyConfig);
      if (wasActive) {
        await this.browserCoordinator.setActiveSession(sessionId);
        this.activeBrowserSessionId = sessionId;
      }
      await this.initializeOpenedContext(session, context);
      await this.persistTabsBestEffort(sessionId);
      if (wasActive) await this.sendTabsReset(sessionId, context);
      if (this.currentSessionId === sessionId && session.status === "running") {
        for (const target of await context.targets()) {
          await this.attachCaptureToTarget(session, target);
        }
      }
    } catch (error) {
      this.sessionErrors.set(sessionId, errorMessage(error));
      if (this.currentSessionId === sessionId) {
        await this.rollbackFailedCaptureStart(sessionId);
      }
    }
  }

  private async handleTargetCrash(
    sessionId: string,
    tabId: string,
    reason?: string,
  ): Promise<void> {
    this.sessionErrors.set(sessionId, reason ?? "Browser target crashed");
    try {
      if (this.currentSessionId === sessionId) {
        await this.rollbackFailedCaptureStart(sessionId);
      } else {
        await this.detachCapture(sessionId, tabId);
      }
    } finally {
      const key = targetKey(sessionId, tabId);
      this.injectors.get(key)?.stop();
      this.injectors.delete(key);
      this.interactionRecorder?.detachTarget(tabId);
      for (const [id, scope] of this.electronTargetScopes) {
        if (scope.sessionId === sessionId && scope.tabId === tabId) {
          this.electronTargetScopes.delete(id);
        }
      }
    }
  }

  private async ensureCloakCapacity(
    openingSessionId: string,
  ): Promise<string | null> {
    if (!this.cloakRuntime) this.assertCloakAvailable();
    const contexts = [...this.cloakRuntime!.listContexts()].filter(
      (context) => context.sessionId !== openingSessionId,
    );
    const seatLimit = Math.min(
      2,
      Math.max(1, this.cloakRuntime!.getStatus().seats || 1),
    );
    if (contexts.length < seatLimit) return null;

    const evictionCount = contexts.length - seatLimit + 1;
    const activeSessionId = this.browserCoordinator.getActiveSessionId();
    const candidates = contexts.filter(
      (context) => context.sessionId !== activeSessionId,
    );
    if (candidates.length < evictionCount && activeSessionId) {
      const activeContext = contexts.find(
        (context) => context.sessionId === activeSessionId,
      );
      if (activeContext) candidates.push(activeContext);
    }
    candidates.sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    const victims = candidates.slice(0, evictionCount);
    for (const victim of victims) {
      await this.persistTabs(victim.sessionId);
    }
    if (
      activeSessionId &&
      victims.some((victim) => victim.sessionId === activeSessionId)
    ) {
      await this.browserCoordinator.setActiveSession(null);
    }
    for (const victim of victims) {
      await this.closeBrowserContext(victim.sessionId);
    }
    return activeSessionId && victims.some(
      (victim) => victim.sessionId === activeSessionId,
    )
      ? activeSessionId
      : null;
  }

  private async restoreEvictedActiveCloakSession(
    sessionId: string | null,
    interruptedCapture: CaptureStateSnapshot | null,
    proxy: ProxyConfig | null,
  ): Promise<void> {
    if (!sessionId) return;

    try {
      const session = this.requireSession(sessionId);
      let context = this.browserCoordinator.hasOpenSession(sessionId)
        ? this.browserCoordinator.resolveContext(sessionId)
        : null;
      if (!context) {
        context = await this.openBrowserContext(session, proxy);
      }
      await this.browserCoordinator.setActiveSession(sessionId);
      this.activeBrowserSessionId = sessionId;
      await this.initializeOpenedContext(session, context);
      await this.persistTabsBestEffort(sessionId);
      await this.sendTabsReset(sessionId, context);

      if (interruptedCapture?.sessionId === sessionId) {
        await this.restoreCaptureState(
          interruptedCapture.sessionId,
          interruptedCapture.status,
          proxy,
        );
      }
    } catch (restoreError) {
      console.error(
        `[SessionManager] Failed to restore evicted active Cloak Session ${sessionId}:`,
        restoreError,
      );
    }
  }

  private async persistTabs(sessionId: string): Promise<void> {
    const session = this.sessionsRepo.findById(sessionId);
    if (
      !session ||
      session.browser_backend !== "cloak" ||
      !session.browser_profile_id ||
      !this.browserCoordinator.hasOpenSession(sessionId)
    ) {
      return;
    }
    const context = this.browserCoordinator.resolveContext(sessionId);
    const targets = await context.targets();
    const now = Date.now();
    this.browserTabsRepo.replaceForProfile(
      session.browser_profile_id,
      targets.map((target, position) => {
        const state = target.getState();
        return {
          id: state.tabId,
          profile_id: session.browser_profile_id!,
          url: state.url,
          title: state.title,
          position,
          active: state.isActive,
          updated_at: now,
        } satisfies BrowserTabState;
      }),
    );
    this.browserProfilesRepo.touchLastUsed(session.browser_profile_id, now);
  }

  private async persistTabsBestEffort(sessionId: string): Promise<void> {
    try {
      await this.persistTabs(sessionId);
    } catch (error) {
      console.warn(
        `[SessionManager] Failed to persist tabs for ${sessionId}:`,
        errorMessage(error),
      );
    }
  }

  private async sendTabsReset(
    sessionId: string,
    context: BrowserContext,
  ): Promise<void> {
    if (
      this.activeBrowserSessionId !== sessionId ||
      this.browserCoordinator.getActiveSessionId() !== sessionId ||
      !this.rendererWebContents ||
      this.rendererWebContents.isDestroyed()
    ) {
      return;
    }
    this.rendererWebContents.send(
      "tabs:reset",
      {
        sessionId,
        contextId: context.id,
        tabId: null,
        tabs: (await context.targets()).map(toBrowserTab),
      },
    );
  }

  private async closeBrowserContext(sessionId: string): Promise<void> {
    if (!this.browserCoordinator.hasOpenSession(sessionId)) return;
    this.intentionalContextCloses.add(sessionId);
    try {
      await this.detachSessionCaptures(sessionId);
      await this.clearPreparedTargets(sessionId);
      await this.browserCoordinator.closeSession(sessionId);
    } finally {
      this.intentionalContextCloses.delete(sessionId);
      if (this.activeBrowserSessionId === sessionId) {
        this.activeBrowserSessionId = null;
      }
    }
  }

  private async rollbackOpenedCloakContext(
    sessionId: string,
    context: BrowserContext,
    previouslyActiveSessionId: string | null,
    cause: unknown,
  ): Promise<void> {
    this.sessionErrors.set(sessionId, errorMessage(cause));

    try {
      await this.closeBrowserContext(sessionId);
    } catch (cleanupError) {
      console.warn(
        `[SessionManager] Failed to close newly opened Cloak Context for ${sessionId}:`,
        errorMessage(cleanupError),
      );
      await this.clearPreparedTargets(sessionId).catch(() => undefined);
      if (!context.isClosed()) {
        await context.close().catch((fallbackError) => {
          console.warn(
            `[SessionManager] Direct Cloak Context close also failed for ${sessionId}:`,
            errorMessage(fallbackError),
          );
        });
      }
    }

    if (this.currentSessionId === sessionId) {
      await this.rollbackFailedCaptureStart(sessionId);
    } else {
      const persisted = this.sessionsRepo.findById(sessionId);
      if (persisted && persisted.status !== "stopped") {
        this.sessionsRepo.updateStatus(sessionId, "stopped", Date.now());
      }
    }

    if (
      previouslyActiveSessionId &&
      this.browserCoordinator.hasOpenSession(previouslyActiveSessionId)
    ) {
      try {
        await this.browserCoordinator.setActiveSession(previouslyActiveSessionId);
        this.activeBrowserSessionId = previouslyActiveSessionId;
      } catch (restoreError) {
        console.warn(
          `[SessionManager] Failed to restore active Session ${previouslyActiveSessionId} after Cloak initialization failed:`,
          errorMessage(restoreError),
        );
      }
    }
  }

  private async clearPreparedTargets(sessionId: string): Promise<void> {
    const pending = [...this.pendingTargetPreparations.entries()]
      .filter(([key]) => key.startsWith(`${sessionId}:`))
      .map(([, preparation]) => preparation);
    if (pending.length > 0) await Promise.allSettled(pending);
    for (const [key, injector] of this.injectors) {
      if (!key.startsWith(`${sessionId}:`)) continue;
      injector.stop();
      this.injectors.delete(key);
    }
    for (const [id, scope] of this.electronTargetScopes) {
      if (scope.sessionId === sessionId) this.electronTargetScopes.delete(id);
    }
    if (this.interactionRecorderSessionId === sessionId) {
      await this.stopPreparedInteractionRecorder();
    }
  }

  private async restoreCaptureState(
    sessionId: string | null,
    status: Session["status"] | null | undefined,
    proxy: ProxyConfig | null,
  ): Promise<void> {
    if (
      !sessionId ||
      (status !== "running" && status !== "paused") ||
      !this.rendererWebContents
    ) {
      return;
    }
    await this.startCaptureNow(
      sessionId,
      this.rendererWebContents,
      proxy,
    );
    if (status === "paused") await this.pauseCaptureNow(sessionId);
  }

  private enqueueBrowserLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.browserLifecycleTail.then(operation, operation);
    this.browserLifecycleTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private registerElectronTarget(target: BrowserTarget): void {
    if (target.backendKind !== "electron" || target.isClosed()) return;
    try {
      const webContents = target.getNativeHandle<WebContents>();
      this.electronTargetScopes.set(webContents.id, {
        sessionId: target.sessionId,
        tabId: target.tabId,
      });
    } catch {
      // Target closed between event delivery and registration.
    }
  }

  private handlePageMessage(sessionId: string, data: unknown): void {
    if (this.currentSessionId !== sessionId || !data || typeof data !== "object") {
      return;
    }
    const message = data as Record<string, unknown>;
    if (message.type === "ar-hook") {
      this.captureEngine.handleHookCaptured({
        hookType: String(message.hookType ?? ""),
        functionName: String(message.functionName ?? ""),
        arguments: String(message.arguments ?? ""),
        result: message.result == null ? null : String(message.result),
        callStack: message.callStack == null ? null : String(message.callStack),
        timestamp:
          typeof message.timestamp === "number" ? message.timestamp : Date.now(),
      });
    } else if (
      message.type === "ar-interaction" &&
      this.interactionRecorder &&
      isRawInteractionMessage(message)
    ) {
      this.interactionRecorder.handleInteraction({
        type: message.interactionType as RawInteractionData["type"],
        timestamp: message.timestamp as number,
        x: message.x as number | undefined,
        y: message.y as number | undefined,
        viewportX: message.viewportX as number | undefined,
        viewportY: message.viewportY as number | undefined,
        selector: message.selector as string | undefined,
        xpath: message.xpath as string | undefined,
        tagName: message.tagName as string | undefined,
        elementText: message.elementText as string | undefined,
        attributes: message.attributes as Record<string, string> | undefined,
        boundingRect: message.boundingRect as RawInteractionData["boundingRect"],
        inputValue: message.inputValue as string | undefined,
        key: message.key as string | undefined,
        scrollX: message.scrollX as number | undefined,
        scrollY: message.scrollY as number | undefined,
        scrollDX: message.scrollDX as number | undefined,
        scrollDY: message.scrollDY as number | undefined,
        url: message.url as string,
        pageTitle: message.pageTitle as string | undefined,
        path: message.path as RawInteractionData["path"],
      });
    }
  }

  private resolveTarget(
    sessionId?: string,
    tabId?: string,
  ): BrowserTarget {
    if (sessionId) return this.browserCoordinator.resolveTarget(sessionId, tabId);
    if (tabId) {
      const activeId = this.browserCoordinator.getActiveSessionId();
      if (!activeId) {
        throw new BrowserBackendError(
          "CONTEXT_NOT_FOUND",
          "No browser Session is active",
        );
      }
      return this.browserCoordinator.resolveTarget(activeId, tabId);
    }
    const target = this.browserCoordinator.getActiveTarget();
    if (!target) {
      throw new BrowserBackendError("TARGET_NOT_FOUND", "No active browser tab");
    }
    return target;
  }

  private requireActiveContext(): BrowserContext {
    const context = this.browserCoordinator.getActiveContext();
    if (!context) {
      throw new BrowserBackendError(
        "CONTEXT_NOT_FOUND",
        "No browser Session is active",
      );
    }
    return context;
  }

  private requireSession(sessionId: string): Session {
    const session = this.sessionsRepo.findById(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    return session;
  }

  private requireBrowserConfig(session: Session): SessionBrowserConfig {
    const config = this.browserConfigRepo.findBySessionId(session.id);
    if (config) return config;
    const now = Date.now();
    return {
      session_id: session.id,
      browser_backend: session.browser_backend ?? "electron",
      capture_mode: session.capture_mode ?? "deep",
      profile_id: session.browser_profile_id ?? null,
      last_browser_version: session.last_browser_version ?? null,
      created_at: now,
      updated_at: now,
    };
  }

  private assertBackendAndMode(
    backend: BrowserBackendKind,
    mode: CaptureMode,
  ): void {
    if (!this.browserCoordinator.hasBackend(backend)) {
      throw new BrowserBackendError(
        "BACKEND_NOT_AVAILABLE",
        `Browser backend ${backend} is not available in this build`,
        { backendKind: backend },
      );
    }
    const capabilities = this.browserCoordinator.getCapabilities(backend);
    if (!capabilities.captureModes.includes(mode)) {
      throw new BrowserBackendError(
        "CAPABILITY_UNSUPPORTED",
        `${backend} does not support ${mode} capture`,
        { backendKind: backend },
      );
    }
  }

  private assertCloakAvailable(): void {
    if (!this.cloakRuntime || !this.browserCoordinator.hasBackend("cloak")) {
      throw new BrowserBackendError(
        "BACKEND_NOT_AVAILABLE",
        "CloakBrowser is not available in this build",
        { backendKind: "cloak" },
      );
    }
  }
}

function targetKey(sessionId: string, tabId: string): string {
  return `${sessionId}:${tabId}`;
}

function toBrowserTab(target: BrowserTarget): BrowserTab {
  const state = target.getState();
  return {
    id: state.tabId,
    sessionId: target.sessionId,
    contextId: target.contextId,
    tabId: target.tabId,
    url: state.url,
    title: state.title,
    isActive: state.isActive,
    isLoading: state.isLoading,
  };
}

function isRawInteractionMessage(
  message: Record<string, unknown>,
): boolean {
  return (
    typeof message.interactionType === "string" &&
    ["click", "dblclick", "input", "scroll", "navigate", "hover"].includes(
      message.interactionType,
    ) &&
    typeof message.timestamp === "number" &&
    typeof message.url === "string"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
