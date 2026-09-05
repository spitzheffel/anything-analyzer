import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserBackend,
  BrowserBindingCallback,
  BrowserCapabilities,
  BrowserClearDataOptions,
  BrowserContext,
  BrowserContextEvent,
  BrowserContextOptions,
  BrowserTarget,
  BrowserTargetEvent,
  BrowserTargetState,
  CdpTransport,
  Unsubscribe,
} from "../../src/main/browser/contracts";
import { BrowserCoordinator } from "../../src/main/browser/browser-coordinator";
import type { CloakRuntime } from "../../src/main/browser/cloak-runtime";
import type { CaptureEngine } from "../../src/main/capture/capture-engine";
import type {
  BrowserProfilesRepo,
  BrowserTabsRepo,
  InteractionEventsRepo,
  SessionBrowserConfigRepo,
  SessionsRepo,
} from "../../src/main/db/repositories";
import { SessionManager } from "../../src/main/session/session-manager";
import type {
  BrowserBackendKind,
  BrowserProfile,
  BrowserProfileState,
  BrowserTabState,
  CloakRuntimeStatus,
  ProxyConfig,
  Session,
  SessionBrowserConfig,
} from "../../src/shared/types";

const electronMocks = vi.hoisted(() => ({
  on: vi.fn(),
  removeListener: vi.fn(),
}));

const captureMocks = vi.hoisted(() => ({
  cdpStart: vi.fn(),
  cdpStop: vi.fn(),
  cdpOn: vi.fn(),
  storageStart: vi.fn(),
  storageStop: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    on: electronMocks.on,
    removeListener: electronMocks.removeListener,
  },
}));

vi.mock("../../src/main/cdp/cdp-manager", () => ({
  CdpManager: class {
    async start(target: BrowserTarget, mode: string): Promise<void> {
      await captureMocks.cdpStart(target, mode);
    }

    on(event: string, listener: (...args: unknown[]) => void): this {
      captureMocks.cdpOn(event, listener);
      return this;
    }

    async stop(): Promise<void> {
      await captureMocks.cdpStop();
    }
  },
}));

vi.mock("../../src/main/capture/storage-collector", () => ({
  StorageCollector: class {
    async start(sessionId: string, target: BrowserTarget): Promise<void> {
      await captureMocks.storageStart(sessionId, target);
    }

    on(): this {
      return this;
    }

    triggerCollection(): void {}

    async stop(): Promise<void> {
      await captureMocks.storageStop();
    }
  },
}));

const CAPABILITIES: Readonly<BrowserCapabilities> = {
  presentation: "external",
  captureModes: ["passive", "deep"],
  persistentContexts: true,
  cdp: true,
  initScripts: true,
  pageBindings: true,
  screenshots: true,
  popupOpener: true,
  devtools: "backend",
  downloads: "managed",
  fileChooser: "programmatic",
  proxyUpdate: "context-restart",
};

let targetSequence = 0;

class FakeTarget implements BrowserTarget {
  readonly id: string;
  readonly tabId: string;
  readonly contextId: string;
  url = "about:blank";
  title = "Blank";
  active = true;
  closed = false;
  evaluateCalls = 0;
  readonly evaluateSources: string[] = [];
  evaluateError: Error | null = null;
  navigateError: Error | null = null;
  initScriptError: Error | null = null;

  constructor(
    readonly sessionId: string,
    readonly backendKind: BrowserBackendKind,
    private readonly owner: FakeContext,
    private readonly initScriptGate: Promise<void> | null = null,
  ) {
    targetSequence += 1;
    this.id = `target-${targetSequence}`;
    this.tabId = this.id;
    this.contextId = owner.id;
  }

  isClosed(): boolean {
    return this.closed;
  }

  getState(): BrowserTargetState {
    return {
      id: this.id,
      tabId: this.tabId,
      sessionId: this.sessionId,
      contextId: this.contextId,
      url: this.url,
      title: this.title,
      isActive: this.active,
      isLoading: false,
    };
  }

  async navigate(url: string): Promise<void> {
    this.owner.recordOperation(`navigate:${this.sessionId}:${this.tabId}:${url}`);
    if (this.navigateError) throw this.navigateError;
    this.url = url;
    this.title = url;
  }

  async goBack(): Promise<void> {}
  async goForward(): Promise<void> {}
  async reload(): Promise<void> {}

  async activate(): Promise<void> {
    await this.owner.activateTarget(this.tabId);
  }

  async close(): Promise<void> {
    await this.owner.closeTarget(this.tabId);
  }

  async evaluate<T = unknown>(source: string): Promise<T> {
    this.evaluateCalls += 1;
    this.evaluateSources.push(source);
    if (this.evaluateError) throw this.evaluateError;
    return undefined as T;
  }

  readonly addInitScript = vi.fn(async (): Promise<string | null> => {
    await this.initScriptGate;
    if (this.initScriptError) throw this.initScriptError;
    this.owner.recordOperation(`init-script:${this.sessionId}:${this.tabId}`);
    return null;
  });

  readonly exposeBinding = vi.fn(async (
    _name: string,
    _callback: BrowserBindingCallback,
  ): Promise<void> => {
    this.owner.recordOperation(`binding:${this.sessionId}:${this.tabId}`);
  });

  async captureScreenshot(): Promise<Buffer> {
    return Buffer.alloc(0);
  }

  async getCdpTransport(): Promise<CdpTransport> {
    throw new Error("CDP is mocked at the manager boundary");
  }

  onEvent(_listener: (event: BrowserTargetEvent) => void): Unsubscribe {
    return () => undefined;
  }

  getNativeHandle<T = unknown>(): T {
    return { id: targetSequence } as T;
  }
}

class FakeContext implements BrowserContext {
  readonly id: string;
  readonly sessionId: string;
  readonly backendKind: BrowserBackendKind;
  readonly options: Readonly<BrowserContextOptions>;
  lastUsedAt: number;
  closed = false;
  activateError: Error | null = null;
  failNextTargetsWith: Error | null = null;
  private readonly targetList: FakeTarget[];
  private readonly listeners = new Set<(event: BrowserContextEvent) => void>();

  constructor(
    backendKind: BrowserBackendKind,
    options: BrowserContextOptions,
    private readonly nextActivity: () => number,
    startEmpty = false,
    private readonly initScriptGate: Promise<void> | null = null,
    private readonly operationLog: string[] = [],
  ) {
    this.backendKind = backendKind;
    this.options = options;
    this.sessionId = options.sessionId;
    this.id = `${backendKind}:${options.sessionId}`;
    this.lastUsedAt = nextActivity();
    this.targetList = startEmpty
      ? []
      : [new FakeTarget(options.sessionId, backendKind, this, initScriptGate)];
  }

  isClosed(): boolean {
    return this.closed;
  }

  async activate(): Promise<void> {
    if (this.activateError) throw this.activateError;
    this.lastUsedAt = this.nextActivity();
  }

  async targets(): Promise<BrowserTarget[]> {
    if (this.failNextTargetsWith) {
      const error = this.failNextTargetsWith;
      this.failNextTargetsWith = null;
      throw error;
    }
    return this.targetList.filter((target) => !target.closed);
  }

  async listTargets(): Promise<BrowserTarget[]> {
    return this.targets();
  }

  getTarget(tabId: string): BrowserTarget | null {
    return this.targetList.find((target) => target.tabId === tabId && !target.closed) ?? null;
  }

  async createTarget(url = "about:blank"): Promise<BrowserTarget> {
    const target = new FakeTarget(
      this.sessionId,
      this.backendKind,
      this,
      this.initScriptGate,
    );
    target.url = url;
    for (const existing of this.targetList) existing.active = false;
    this.targetList.push(target);
    this.emit({
      type: "target-created",
      sessionId: this.sessionId,
      contextId: this.id,
      tabId: target.tabId,
      target,
    });
    return target;
  }

  async activateTarget(tabId: string): Promise<BrowserTarget> {
    const target = this.getTarget(tabId) as FakeTarget | null;
    if (!target) throw new Error(`Missing target ${tabId}`);
    for (const existing of this.targetList) existing.active = existing === target;
    this.lastUsedAt = this.nextActivity();
    this.emit({
      type: "target-activated",
      sessionId: this.sessionId,
      contextId: this.id,
      tabId,
    });
    return target;
  }

  async closeTarget(tabId: string): Promise<void> {
    const target = this.getTarget(tabId) as FakeTarget | null;
    if (!target) return;
    target.closed = true;
    this.emit({
      type: "target-closed",
      sessionId: this.sessionId,
      contextId: this.id,
      tabId,
    });
  }

  async clearData(_options?: BrowserClearDataOptions): Promise<void> {}

  async close(): Promise<void> {
    this.disconnect("closed by owner");
  }

  onEvent(listener: (event: BrowserContextEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getNativeHandle<T = unknown>(): T {
    return undefined as T;
  }

  recordOperation(operation: string): void {
    this.operationLog.push(operation);
  }

  disconnect(reason = "browser exited"): void {
    if (this.closed) return;
    this.closed = true;
    for (const target of this.targetList) target.closed = true;
    this.emit({
      type: "disconnected",
      sessionId: this.sessionId,
      contextId: this.id,
      tabId: null,
      reason,
    });
  }

  crashTarget(tabId: string, reason = "renderer crashed"): void {
    const target = this.getTarget(tabId);
    if (!target) throw new Error(`Missing target ${tabId}`);
    this.emit({
      type: "target-crashed",
      sessionId: this.sessionId,
      contextId: this.id,
      tabId,
      reason,
    });
  }

  private emit(event: BrowserContextEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

class FakeBackend implements BrowserBackend {
  readonly contexts = new Map<string, FakeContext>();
  readonly openAttempts: BrowserContextOptions[] = [];
  readonly deleteAttempts: string[] = [];
  readonly openGates = new Map<string, Promise<void>>();
  failOpen: ((options: BrowserContextOptions) => boolean) | null = null;
  failDelete = false;
  shutdownFailuresRemaining = 0;
  shutdownAttempts = 0;
  startContextsEmpty = false;
  initScriptGate: Promise<void> | null = null;
  initialTargetUrl: string | null = null;
  initialEvaluateError: Error | null = null;
  initialActivateError: Error | null = null;
  initialInitScriptError: Error | null = null;
  initialNavigateError: Error | null = null;
  private activity = 0;

  constructor(
    readonly kind: BrowserBackendKind,
    readonly log: string[],
  ) {}

  get capabilities(): Readonly<BrowserCapabilities> {
    return {
      ...CAPABILITIES,
      presentation: this.kind === "electron" ? "embedded" : "external",
      captureModes: this.kind === "electron" ? ["deep"] : ["passive", "deep"],
      pageBindings: this.kind === "cloak",
      proxyUpdate: this.kind === "electron" ? "runtime" : "context-restart",
    };
  }

  async start(): Promise<void> {}

  async openContext(options: BrowserContextOptions): Promise<BrowserContext> {
    this.openAttempts.push({ ...options });
    this.log.push(`open:${options.sessionId}:${options.proxy?.host ?? "direct"}`);
    await this.openGates.get(options.sessionId);
    if (this.failOpen?.(options)) throw new Error("new proxy failed");
    const context = new FakeContext(
      this.kind,
      options,
      () => ++this.activity,
      this.startContextsEmpty,
      this.initScriptGate,
      this.log,
    );
    const [target] = await context.targets() as FakeTarget[];
    context.activateError = this.initialActivateError;
    if (target && this.initialTargetUrl !== null) target.url = this.initialTargetUrl;
    if (target) target.evaluateError = this.initialEvaluateError;
    if (target) target.initScriptError = this.initialInitScriptError;
    if (target) target.navigateError = this.initialNavigateError;
    this.contexts.set(options.sessionId, context);
    return context;
  }

  getContext(sessionId: string): BrowserContext | null {
    const context = this.contexts.get(sessionId);
    return context && !context.closed ? context : null;
  }

  async closeContext(sessionId: string): Promise<void> {
    const context = this.contexts.get(sessionId);
    if (!context) return;
    this.log.push(`close:${sessionId}`);
    context.disconnect("closed by backend");
    if (this.contexts.get(sessionId) === context) this.contexts.delete(sessionId);
  }

  async deletePersistentProfile(profileKey: string): Promise<void> {
    this.deleteAttempts.push(profileKey);
    if (this.failDelete) throw new Error("profile directory delete failed");
  }

  async shutdown(): Promise<void> {
    this.shutdownAttempts += 1;
    if (this.shutdownFailuresRemaining > 0) {
      this.shutdownFailuresRemaining -= 1;
      throw new Error("backend shutdown failed");
    }
  }
}

class MemoryBrowserConfigRepo {
  readonly configs = new Map<string, SessionBrowserConfig>();
  upsertError: Error | null = null;

  upsert(config: SessionBrowserConfig): void {
    if (this.upsertError) throw this.upsertError;
    this.configs.set(config.session_id, { ...config });
  }

  findBySessionId(sessionId: string): SessionBrowserConfig | null {
    return this.configs.get(sessionId) ?? null;
  }

  delete(sessionId: string): void {
    this.configs.delete(sessionId);
  }
}

class MemorySessionsRepo {
  readonly sessions = new Map<string, Session>();
  deleteError: Error | null = null;

  constructor(
    private readonly configRepo: MemoryBrowserConfigRepo,
    private readonly profilesRepo: MemoryProfilesRepo,
    private readonly tabsRepo: MemoryTabsRepo,
  ) {}

  insert(session: Session): void {
    this.sessions.set(session.id, { ...session });
  }

  findById(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    const config = this.configRepo.findBySessionId(id);
    return config
      ? {
          ...session,
          browser_backend: config.browser_backend,
          capture_mode: config.capture_mode,
          browser_profile_id: config.profile_id,
          last_browser_version: config.last_browser_version,
        }
      : { ...session };
  }

  findAll(): Session[] {
    return [...this.sessions.keys()]
      .map((id) => this.findById(id))
      .filter((session): session is Session => Boolean(session));
  }

  updateStatus(id: string, status: string, stoppedAt: number | null = null): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.status = status as Session["status"];
    session.stopped_at = stoppedAt;
  }

  delete(id: string): void {
    if (this.deleteError) throw this.deleteError;
    this.sessions.delete(id);
    this.configRepo.delete(id);
  }

  transaction<T>(operation: () => T): T {
    const sessions = [...this.sessions].map(
      ([id, session]) => [id, { ...session }] as const,
    );
    const configs = [...this.configRepo.configs].map(
      ([id, config]) => [id, { ...config }] as const,
    );
    const profiles = [...this.profilesRepo.profiles].map(
      ([id, profile]) => [id, { ...profile }] as const,
    );
    const tabs = [...this.tabsRepo.tabs].map(
      ([profileId, items]) => [
        profileId,
        items.map((item) => ({ ...item })),
      ] as const,
    );
    try {
      return operation();
    } catch (error) {
      this.sessions.clear();
      this.configRepo.configs.clear();
      this.profilesRepo.profiles.clear();
      this.tabsRepo.tabs.clear();
      for (const [id, session] of sessions) this.sessions.set(id, session);
      for (const [id, config] of configs) this.configRepo.configs.set(id, config);
      for (const [id, profile] of profiles) this.profilesRepo.profiles.set(id, profile);
      for (const [profileId, items] of tabs) this.tabsRepo.tabs.set(profileId, items);
      throw error;
    }
  }
}

class MemoryProfilesRepo {
  readonly profiles = new Map<string, BrowserProfile>();
  onDelete: ((profileId: string) => void) | null = null;
  updateStateError: Error | null = null;
  deleteError: Error | null = null;

  insert(profile: BrowserProfile): void {
    this.profiles.set(profile.id, { ...profile });
  }

  findById(id: string): BrowserProfile | null {
    return this.profiles.get(id) ?? null;
  }

  findByState(state: BrowserProfileState): BrowserProfile[] {
    return [...this.profiles.values()].filter((profile) => profile.state === state);
  }

  updateState(
    id: string,
    state: BrowserProfileState,
    lastError: string | null = null,
    updatedAt = Date.now(),
  ): void {
    if (this.updateStateError) throw this.updateStateError;
    const profile = this.profiles.get(id);
    if (!profile) return;
    profile.state = state;
    if (state === "retained") profile.retained_at = updatedAt;
    if (state === "attached") profile.retained_at = null;
    profile.last_error = lastError;
    profile.updated_at = updatedAt;
  }

  touchLastUsed(id: string, lastUsedAt = Date.now()): void {
    const profile = this.profiles.get(id);
    if (!profile) return;
    profile.last_used_at = lastUsedAt;
    profile.updated_at = lastUsedAt;
  }

  delete(id: string): void {
    if (this.deleteError) throw this.deleteError;
    this.profiles.delete(id);
    this.onDelete?.(id);
  }
}

class MemoryTabsRepo {
  readonly tabs = new Map<string, BrowserTabState[]>();
  replaceError: Error | null = null;
  replaceErrorProfileId: string | null = null;

  constructor(private readonly log: string[]) {}

  replaceForProfile(profileId: string, tabs: BrowserTabState[]): void {
    if (
      this.replaceError &&
      (!this.replaceErrorProfileId || this.replaceErrorProfileId === profileId)
    ) {
      throw this.replaceError;
    }
    this.log.push(`persist:${profileId}`);
    this.tabs.set(profileId, tabs.map((tab) => ({ ...tab })));
  }

  findByProfileId(profileId: string): BrowserTabState[] {
    return (this.tabs.get(profileId) ?? []).map((tab) => ({ ...tab }));
  }

  deleteByProfileId(profileId: string): void {
    this.tabs.delete(profileId);
  }
}

interface Fixture {
  manager: SessionManager;
  sessions: MemorySessionsRepo;
  configs: MemoryBrowserConfigRepo;
  profiles: MemoryProfilesRepo;
  tabs: MemoryTabsRepo;
  coordinator: BrowserCoordinator;
  electronBackend: FakeBackend;
  cloakBackend: FakeBackend;
  cloakRuntime: CloakRuntime;
  captureEngine: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    handleResponseCaptured: ReturnType<typeof vi.fn>;
    handleStorageCollected: ReturnType<typeof vi.fn>;
  };
  cloakCheck: ReturnType<typeof vi.fn>;
  log: string[];
}

const managers: SessionManager[] = [];

function createFixture(
  seats = 2,
  options: {
    registerCloak?: boolean;
    provideCloakRuntime?: boolean;
    withInteractionRecorder?: boolean;
  } = {},
): Fixture {
  const log: string[] = [];
  const configs = new MemoryBrowserConfigRepo();
  const profiles = new MemoryProfilesRepo();
  const tabs = new MemoryTabsRepo(log);
  const sessions = new MemorySessionsRepo(configs, profiles, tabs);
  profiles.onDelete = (profileId) => tabs.deleteByProfileId(profileId);
  const coordinator = new BrowserCoordinator();
  const electronBackend = new FakeBackend("electron", log);
  const cloakBackend = new FakeBackend("cloak", log);
  coordinator.registerBackend(electronBackend);
  if (options.registerCloak !== false) coordinator.registerBackend(cloakBackend);
  const status: CloakRuntimeStatus = {
    available: true,
    state: "ready",
    loggedIn: true,
    plan: "pro",
    seats,
    policy: "strict",
    configuredVersion: "140.0.0",
    actualVersion: "140.0.0",
    error: null,
    errorCode: null,
    downloadProgress: null,
  };
  const cloakCheck = vi.fn(async () => ({ ...status }));
  const cloakRuntime = {
    getStatus: () => ({ ...status }),
    check: cloakCheck,
    listContexts: () =>
      [...cloakBackend.contexts.values()]
        .filter((context) => !context.closed)
        .map((context) => ({
          id: context.id,
          sessionId: context.sessionId,
          profileId: context.options.profileId ?? null,
          profileKey: String(context.options.backendOptions?.profileKey ?? "profile"),
          userDataDir: `profiles/${context.sessionId}`,
          browserVersion: "140.0.0",
          createdAt: 1,
          lastUsedAt: context.lastUsedAt,
          closed: false,
        })),
  } as unknown as CloakRuntime;
  const captureEngine = {
    start: vi.fn(),
    stop: vi.fn(),
    handleResponseCaptured: vi.fn(),
    handleStorageCollected: vi.fn(),
  };
  const interactionEventsRepo = options.withInteractionRecorder
    ? {
        getNextSequence: vi.fn(() => 1),
        insert: vi.fn(),
      }
    : undefined;
  const manager = new SessionManager(
    sessions as unknown as SessionsRepo,
    captureEngine as unknown as CaptureEngine,
    undefined,
    interactionEventsRepo as unknown as InteractionEventsRepo,
    coordinator,
    configs as unknown as SessionBrowserConfigRepo,
    profiles as unknown as BrowserProfilesRepo,
    tabs as unknown as BrowserTabsRepo,
    (options.provideCloakRuntime ?? options.registerCloak !== false)
      ? cloakRuntime
      : undefined,
  );
  managers.push(manager);
  return {
    manager,
    sessions,
    configs,
    profiles,
    tabs,
    coordinator,
    electronBackend,
    cloakBackend,
    cloakRuntime,
    captureEngine,
    cloakCheck,
    log,
  };
}

async function settleBrowserEvents(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(): void {
      resolvePromise?.();
    },
  };
}

function attachedCaptureCount(manager: SessionManager): number {
  return (
    manager as unknown as {
      tabCaptures: Map<string, unknown>;
    }
  ).tabCaptures.size;
}

function interactionRecorderIsRecording(manager: SessionManager): boolean | null {
  const recorder = (
    manager as unknown as {
      interactionRecorder: { isRecording(): boolean } | null;
    }
  ).interactionRecorder;
  return recorder?.isRecording() ?? null;
}

function interactionRecorderSessionId(manager: SessionManager): string | null {
  const recorder = (
    manager as unknown as {
      interactionRecorder: { getSessionId(): string | null } | null;
    }
  ).interactionRecorder;
  return recorder?.getSessionId() ?? null;
}

beforeEach(() => {
  targetSequence = 0;
  captureMocks.cdpStart.mockReset();
  captureMocks.cdpStop.mockReset();
  captureMocks.cdpOn.mockReset();
  captureMocks.storageStart.mockReset();
  captureMocks.storageStop.mockReset();
});

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.shutdown()));
});

describe("SessionManager browser lifecycle", () => {
  it("keeps historical defaults and gives new Cloak Sessions passive capture", async () => {
    const fixture = createFixture();
    fixture.sessions.insert({
      id: "legacy",
      name: "Legacy",
      target_url: "https://legacy.test",
      status: "stopped",
      created_at: 1,
      stopped_at: null,
    });

    await fixture.manager.activateSession("legacy");
    expect(fixture.electronBackend.openAttempts[0]).toMatchObject({
      sessionId: "legacy",
      captureMode: "deep",
    });

    const electron = fixture.manager.createSession("Electron", "electron.test");
    const cloak = fixture.manager.createSession("Cloak", "cloak.test", {
      backend: "cloak",
    });
    expect(electron).toMatchObject({
      browser_backend: "electron",
      capture_mode: "deep",
    });
    expect(cloak).toMatchObject({
      browser_backend: "cloak",
      capture_mode: "passive",
    });
    expect(cloak.browser_profile_id).toBeTruthy();
  });

  it("closes a newly opened Cloak Context when Context activation fails", async () => {
    const fixture = createFixture();
    const retained = fixture.manager.createSession("Retained", "retained.test", {
      backend: "cloak",
    });
    await fixture.manager.activateSession(retained.id);

    fixture.cloakBackend.initialActivateError = new Error("context activation failed");
    const failing = fixture.manager.createSession("Failing", "failing.test", {
      backend: "cloak",
    });
    fixture.sessions.updateStatus(failing.id, "paused");

    await expect(fixture.manager.activateSession(failing.id)).rejects.toThrow(
      "context activation failed",
    );

    expect(fixture.cloakBackend.openAttempts.filter(
      (attempt) => attempt.sessionId === failing.id,
    )).toHaveLength(1);
    expect(fixture.log).toContain(`close:${failing.id}`);
    expect(fixture.cloakBackend.contexts.has(failing.id)).toBe(false);
    expect(fixture.coordinator.hasOpenSession(failing.id)).toBe(false);
    expect(fixture.cloakRuntime.listContexts().some(
      (context) => context.sessionId === failing.id,
    )).toBe(false);
    expect(fixture.manager.getSession(failing.id)?.status).toBe("stopped");
    expect(fixture.coordinator.getActiveSessionId()).toBe(retained.id);
    expect(fixture.manager.getActiveBrowserSessionId()).toBe(retained.id);
  });

  it("closes a newly opened Cloak Context when Deep hook setup fails", async () => {
    const fixture = createFixture();
    fixture.cloakBackend.initialInitScriptError = new Error("init script failed");
    const session = fixture.manager.createSession("Deep failure", "deep-failure.test", {
      backend: "cloak",
      captureMode: "deep",
    });

    await expect(fixture.manager.activateSession(session.id)).rejects.toThrow(
      "init script failed",
    );

    expect(fixture.cloakBackend.openAttempts).toHaveLength(1);
    expect(fixture.log).toContain(`close:${session.id}`);
    expect(fixture.cloakBackend.contexts.has(session.id)).toBe(false);
    expect(fixture.coordinator.hasOpenSession(session.id)).toBe(false);
    expect(fixture.cloakRuntime.listContexts()).toEqual([]);
    expect(fixture.manager.getSession(session.id)?.status).toBe("stopped");
    expect(fixture.manager.getActiveBrowserSessionId()).toBeNull();
    expect(fixture.coordinator.getActiveSessionId()).toBeNull();
    const preparationState = fixture.manager as unknown as {
      injectors: Map<string, unknown>;
      pendingTargetPreparations: Map<string, unknown>;
    };
    expect([...preparationState.injectors.keys()].some(
      (key) => key.startsWith(`${session.id}:`),
    )).toBe(false);
    expect([...preparationState.pendingTargetPreparations.keys()].some(
      (key) => key.startsWith(`${session.id}:`),
    )).toBe(false);
  });

  it("closes a newly opened Cloak Context when its first navigation fails", async () => {
    const fixture = createFixture();
    fixture.cloakBackend.initialNavigateError = new Error("first navigation failed");
    const session = fixture.manager.createSession("Navigation failure", "navigation-failure.test", {
      backend: "cloak",
      captureMode: "passive",
    });

    await expect(fixture.manager.activateSession(session.id)).rejects.toThrow(
      "first navigation failed",
    );

    expect(fixture.cloakBackend.openAttempts).toHaveLength(1);
    expect(fixture.log).toContain(
      `navigate:${session.id}:target-1:${session.target_url}`,
    );
    expect(fixture.log).toContain(`close:${session.id}`);
    expect(fixture.cloakBackend.contexts.has(session.id)).toBe(false);
    expect(fixture.coordinator.hasOpenSession(session.id)).toBe(false);
    expect(fixture.cloakRuntime.listContexts()).toEqual([]);
    expect(fixture.manager.getSession(session.id)?.status).toBe("stopped");
    expect(fixture.manager.getCurrentSessionId()).toBeNull();
    expect(fixture.manager.getActiveBrowserSessionId()).toBeNull();
    expect(fixture.coordinator.getActiveSessionId()).toBeNull();
  });

  it("rejects capture-mode changes while a Session is running", async () => {
    const fixture = createFixture();
    const session = fixture.manager.createSession("Cloak", "cloak.test", {
      backend: "cloak",
    });
    fixture.sessions.updateStatus(session.id, "running");

    await expect(fixture.manager.setCaptureMode(session.id, "deep")).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(fixture.configs.findBySessionId(session.id)?.capture_mode).toBe("passive");
    expect(fixture.cloakBackend.openAttempts).toHaveLength(0);
  });

  it.each([1, 2])(
    "enforces the Cloak LRU limit for %i seat(s) and persists before eviction",
    async (seats) => {
      const fixture = createFixture(seats);
      const sessions = Array.from({ length: seats + 1 }, (_, index) =>
        fixture.manager.createSession(`Cloak ${index}`, `https://site-${index}.test`, {
          backend: "cloak",
        }),
      );
      for (const session of sessions) {
        await fixture.manager.activateSession(session.id);
      }
      await settleBrowserEvents();

      const victim = sessions[0];
      const retained = sessions.slice(1).map((session) => session.id);
      expect([...fixture.cloakBackend.contexts.keys()].sort()).toEqual(retained.sort());
      expect(
        fixture.cloakBackend.openAttempts.filter(
          (attempt) => attempt.sessionId === victim.id,
        ),
      ).toHaveLength(1);

      const closeIndex = fixture.log.indexOf(`close:${victim.id}`);
      const persistIndex = fixture.log.lastIndexOf(
        `persist:${victim.browser_profile_id}`,
        closeIndex,
      );
      expect(persistIndex).toBeGreaterThanOrEqual(0);
      expect(persistIndex).toBeLessThan(closeIndex);
    },
  );

  it("does not treat an active intentional Context rebuild as a crash", async () => {
    const fixture = createFixture();
    const session = fixture.manager.createSession("Cloak", "cloak.test", {
      backend: "cloak",
    });
    await fixture.manager.activateSession(session.id);

    await fixture.manager.setCaptureMode(session.id, "deep");
    await settleBrowserEvents();

    expect(fixture.cloakBackend.openAttempts).toHaveLength(2);
    expect(fixture.manager.getSession(session.id)).toMatchObject({
      capture_mode: "deep",
      status: "stopped",
    });
    expect(fixture.manager.getBrowserSessionStatus(session.id)).toMatchObject({
      state: "ready",
      error: null,
    });
  });

  it("installs Deep hooks before the first target navigation", async () => {
    const fixture = createFixture();
    const session = fixture.manager.createSession(
      "Deep first navigation",
      "https://first-navigation.test/",
      { backend: "cloak", captureMode: "deep" },
    );

    await fixture.manager.activateSession(session.id);

    const target = (await fixture.cloakBackend.contexts
      .get(session.id)!
      .targets())[0];
    const bindingIndex = fixture.log.indexOf(
      `binding:${session.id}:${target.tabId}`,
    );
    const initScriptIndex = fixture.log.indexOf(
      `init-script:${session.id}:${target.tabId}`,
    );
    const navigationIndex = fixture.log.indexOf(
      `navigate:${session.id}:${target.tabId}:${session.target_url}`,
    );
    expect(bindingIndex).toBeGreaterThanOrEqual(0);
    expect(initScriptIndex).toBeGreaterThan(bindingIndex);
    expect(navigationIndex).toBeGreaterThan(initScriptIndex);
  });

  it("primes a pristine Electron target before installing scripts and navigating", async () => {
    const fixture = createFixture();
    fixture.electronBackend.initialTargetUrl = "";
    fixture.electronBackend.initialEvaluateError = new Error(
      "executeJavaScript waits for the first document",
    );
    const session = fixture.manager.createSession(
      "Pristine Electron target",
      "https://first-electron-navigation.test/",
      { backend: "electron", captureMode: "deep" },
    );

    await fixture.manager.activateSession(session.id);

    const [target] = await fixture.electronBackend.contexts
      .get(session.id)!
      .targets() as FakeTarget[];
    const blankNavigationIndex = fixture.log.indexOf(
      `navigate:${session.id}:${target.tabId}:about:blank`,
    );
    const initScriptIndex = fixture.log.indexOf(
      `init-script:${session.id}:${target.tabId}`,
    );
    const targetNavigationIndex = fixture.log.indexOf(
      `navigate:${session.id}:${target.tabId}:${session.target_url}`,
    );
    expect(target.url).toBe(session.target_url);
    expect(blankNavigationIndex).toBeGreaterThanOrEqual(0);
    expect(initScriptIndex).toBeGreaterThan(blankNavigationIndex);
    expect(targetNavigationIndex).toBeGreaterThan(initScriptIndex);
  });

  it("returns fully scoped tabs from create and list operations", async () => {
    const fixture = createFixture();
    const session = fixture.manager.createSession("Scoped tabs", "scope.test", {
      backend: "cloak",
    });
    await fixture.manager.activateSession(session.id);
    const context = fixture.cloakBackend.contexts.get(session.id)!;

    const created = await fixture.manager.createBrowserTab("https://scope.test/next");
    expect(created).toMatchObject({
      id: created.tabId,
      sessionId: session.id,
      contextId: context.id,
    });

    const listed = await fixture.manager.listBrowserTabs(session.id);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((tab) =>
      tab.sessionId === session.id &&
      tab.contextId === context.id &&
      tab.id === tab.tabId
    )).toBe(true);
  });

  it("keeps browser events best-effort when tab persistence fails", async () => {
    const fixture = createFixture();
    const session = fixture.manager.createSession("Cloak", "cloak.test", {
      backend: "cloak",
    });
    await fixture.manager.activateSession(session.id);
    const context = fixture.cloakBackend.contexts.get(session.id)!;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fixture.tabs.replaceError = new Error("tab persistence failed");

    await context.createTarget("https://event.test");
    await vi.waitFor(() => {
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("Failed to persist tabs"),
        "tab persistence failed",
      );
    });

    expect(fixture.manager.getBrowserSessionStatus(session.id).state).toBe("ready");
    fixture.tabs.replaceError = null;
    warning.mockRestore();
  });

  it("does not reject committed browser actions when tab persistence fails", async () => {
    const fixture = createFixture();
    const session = fixture.manager.createSession("Cloak", "cloak.test", {
      backend: "cloak",
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fixture.tabs.replaceError = new Error("tab persistence failed");

    try {
      await expect(fixture.manager.activateSession(session.id)).resolves.toBeTruthy();
      const created = await fixture.manager.createBrowserTab("https://created.test");
      await expect(
        fixture.manager.activateBrowserTab(created.tabId),
      ).resolves.toBeUndefined();
      await expect(
        fixture.manager.closeBrowserTab(created.tabId),
      ).resolves.toBeUndefined();
      const renderer = { isDestroyed: () => false, send: vi.fn() };
      await fixture.manager.startCapture(
        session.id,
        undefined,
        renderer as never,
      );
      await expect(
        fixture.manager.stopCapture(session.id),
      ).resolves.toBeUndefined();

      expect(fixture.manager.getSession(session.id)?.status).toBe("stopped");
      expect(
        fixture.cloakBackend.contexts.get(session.id)?.getTarget(created.tabId),
      ).toBeNull();
      expect(warning).toHaveBeenCalled();
    } finally {
      fixture.tabs.replaceError = null;
      await settleBrowserEvents();
      warning.mockRestore();
    }
  });

  it("restores Deep interaction recording state after a target navigation", async () => {
    const fixture = createFixture(2, { withInteractionRecorder: true });
    const session = fixture.manager.createSession("Deep", "deep.test", {
      backend: "cloak",
      captureMode: "deep",
    });
    const renderer = { isDestroyed: () => false, send: vi.fn() };
    await fixture.manager.startCapture(
      session.id,
      undefined,
      renderer as never,
    );
    const context = fixture.cloakBackend.contexts.get(session.id)!;
    const [target] = await context.targets() as FakeTarget[];
    const navigationListener = captureMocks.cdpOn.mock.calls.find(
      ([event]) => event === "frame-navigated",
    )?.[1] as (() => void) | undefined;
    expect(navigationListener).toBeTypeOf("function");
    const previousEvaluationCount = target.evaluateSources.length;

    navigationListener!();

    await vi.waitFor(() => {
      expect(target.evaluateSources.length).toBeGreaterThan(
        previousEvaluationCount,
      );
    });
    expect(target.evaluateSources.at(-1)).toContain("recording:true");
  });

  it("stops a running Deep capture when its target crashes", async () => {
    const fixture = createFixture(2, { withInteractionRecorder: true });
    const session = fixture.manager.createSession("Deep crash", "crash.test", {
      backend: "cloak",
      captureMode: "deep",
    });
    const renderer = { isDestroyed: () => false, send: vi.fn() };
    await fixture.manager.startCapture(
      session.id,
      undefined,
      renderer as never,
    );
    const context = fixture.cloakBackend.contexts.get(session.id)!;
    const [target] = await context.targets() as FakeTarget[];

    context.crashTarget(target.tabId, "renderer process crashed");

    await vi.waitFor(() => {
      expect(fixture.manager.getCurrentSessionId()).toBeNull();
    });
    expect(target.isClosed()).toBe(false);
    expect(fixture.manager.getSession(session.id)?.status).toBe("stopped");
    expect(fixture.manager.getBrowserSessionStatus(session.id)).toMatchObject({
      state: "error",
      error: "renderer process crashed",
    });
    expect(attachedCaptureCount(fixture.manager)).toBe(0);
    expect(interactionRecorderIsRecording(fixture.manager)).toBe(false);
    expect(fixture.captureEngine.stop).toHaveBeenCalledOnce();
  });

  it("fully stops Deep capture after a second Cloak Context disconnect", async () => {
    const fixture = createFixture(2, { withInteractionRecorder: true });
    const session = fixture.manager.createSession("Deep", "deep.test", {
      backend: "cloak",
      captureMode: "deep",
    });
    const renderer = { isDestroyed: () => false, send: vi.fn() };
    await fixture.manager.startCapture(
      session.id,
      undefined,
      renderer as never,
    );
    const firstContext = fixture.cloakBackend.contexts.get(session.id)!;

    firstContext.disconnect("first crash");
    await vi.waitFor(() => {
      expect(fixture.cloakBackend.openAttempts).toHaveLength(2);
      expect(attachedCaptureCount(fixture.manager)).toBe(1);
    });
    expect(interactionRecorderIsRecording(fixture.manager)).toBe(true);

    fixture.cloakBackend.contexts.get(session.id)!.disconnect("second crash");

    await vi.waitFor(() => {
      expect(fixture.manager.getCurrentSessionId()).toBeNull();
    });
    expect(fixture.manager.getSession(session.id)?.status).toBe("stopped");
    expect(fixture.manager.getBrowserSessionStatus(session.id)).toMatchObject({
      state: "error",
      error: "CloakBrowser exited again after one automatic recovery",
    });
    expect(attachedCaptureCount(fixture.manager)).toBe(0);
    expect(interactionRecorderIsRecording(fixture.manager)).toBe(false);
    expect(fixture.captureEngine.stop).toHaveBeenCalledOnce();
  });

  it("rolls back partial target attachments when Cloak recovery fails", async () => {
    const fixture = createFixture(2, { withInteractionRecorder: true });
    const session = fixture.manager.createSession("Recovery", "first.test", {
      backend: "cloak",
      captureMode: "deep",
    });
    const renderer = { isDestroyed: () => false, send: vi.fn() };
    await fixture.manager.activateSession(session.id, renderer as never);
    await fixture.manager.createBrowserTab("https://second.test");
    await settleBrowserEvents();
    await fixture.manager.startCapture(
      session.id,
      undefined,
      renderer as never,
    );
    expect(fixture.tabs.findByProfileId(session.browser_profile_id!)).toHaveLength(2);
    let successfulRecoveryAttachment = false;
    captureMocks.storageStart.mockReset();
    captureMocks.storageStart.mockImplementation(async () => {
      if (!successfulRecoveryAttachment) {
        successfulRecoveryAttachment = true;
        return;
      }
      throw new Error("recovery target attach failed");
    });

    fixture.cloakBackend.contexts.get(session.id)!.disconnect("crash");

    await vi.waitFor(() => {
      expect(fixture.manager.getCurrentSessionId()).toBeNull();
    });
    expect(successfulRecoveryAttachment).toBe(true);
    expect(fixture.manager.getSession(session.id)?.status).toBe("stopped");
    expect(fixture.manager.getBrowserSessionStatus(session.id)).toMatchObject({
      state: "error",
      error: "recovery target attach failed",
    });
    expect(attachedCaptureCount(fixture.manager)).toBe(0);
    expect(interactionRecorderIsRecording(fixture.manager)).toBe(false);
    expect(fixture.captureEngine.stop).toHaveBeenCalledOnce();
  });

  it("recovers one unexpected Cloak exit but never starts a second recovery", async () => {
    const fixture = createFixture();
    const session = fixture.manager.createSession("Cloak", "cloak.test", {
      backend: "cloak",
    });
    await fixture.manager.activateSession(session.id);
    const firstContext = fixture.cloakBackend.contexts.get(session.id)!;

    firstContext.disconnect("first crash");
    await vi.waitFor(() => {
      expect(fixture.cloakBackend.openAttempts).toHaveLength(2);
    });
    const recoveredContext = fixture.cloakBackend.contexts.get(session.id)!;
    expect(recoveredContext).not.toBe(firstContext);
    expect(fixture.manager.getBrowserSessionStatus(session.id).state).toBe("ready");

    recoveredContext.disconnect("second crash");
    await vi.waitFor(() => {
      expect(fixture.manager.getBrowserSessionStatus(session.id)).toMatchObject({
        state: "error",
        error: "CloakBrowser exited again after one automatic recovery",
      });
    });
    expect(fixture.cloakBackend.openAttempts).toHaveLength(2);
  });

  it("recovers an inactive Cloak Context once without changing active routing", async () => {
    const fixture = createFixture(2);
    const background = fixture.manager.createSession("Background", "background.test", {
      backend: "cloak",
    });
    const foreground = fixture.manager.createSession("Foreground", "foreground.test", {
      backend: "cloak",
    });
    await fixture.manager.activateSession(background.id);
    await fixture.manager.activateSession(foreground.id);
    const originalBackgroundContext = fixture.cloakBackend.contexts.get(background.id)!;

    originalBackgroundContext.disconnect("first background crash");
    await vi.waitFor(() => {
      expect(
        fixture.cloakBackend.openAttempts.filter(
          (attempt) => attempt.sessionId === background.id,
        ),
      ).toHaveLength(2);
    });

    const recoveredBackgroundContext = fixture.cloakBackend.contexts.get(background.id)!;
    expect(recoveredBackgroundContext).not.toBe(originalBackgroundContext);
    expect(fixture.coordinator.getActiveSessionId()).toBe(foreground.id);
    expect(fixture.manager.getActiveBrowserSessionId()).toBe(foreground.id);
    expect(fixture.manager.getBrowserSessionStatus(background.id).state).toBe("ready");

    recoveredBackgroundContext.disconnect("second background crash");
    await vi.waitFor(() => {
      expect(fixture.manager.getBrowserSessionStatus(background.id)).toMatchObject({
        state: "error",
        error: "CloakBrowser exited again after one automatic recovery",
      });
    });
    expect(
      fixture.cloakBackend.openAttempts.filter(
        (attempt) => attempt.sessionId === background.id,
      ),
    ).toHaveLength(2);
    expect(fixture.coordinator.getActiveSessionId()).toBe(foreground.id);
    expect(fixture.manager.getActiveBrowserSessionId()).toBe(foreground.id);
  });

  it("installs Deep hooks before restoring URLs after a crash", async () => {
    const fixture = createFixture();
    const session = fixture.manager.createSession(
      "Deep recovery",
      "https://recovery-navigation.test/",
      { backend: "cloak", captureMode: "deep" },
    );
    await fixture.manager.activateSession(session.id);
    await fixture.manager.createBrowserTab(
      "https://recovery-navigation.test/second",
    );
    fixture.log.length = 0;

    fixture.cloakBackend.contexts.get(session.id)!.disconnect("crash");
    await vi.waitFor(() => {
      expect(
        fixture.log.some((entry) =>
          entry.startsWith(`navigate:${session.id}:`),
        ),
      ).toBe(true);
    });

    const bindingIndexes = fixture.log.flatMap((entry, index) =>
      entry.startsWith(`binding:${session.id}:`) ? [index] : [],
    );
    const initScriptIndexes = fixture.log.flatMap((entry, index) =>
      entry.startsWith(`init-script:${session.id}:`) ? [index] : [],
    );
    const navigationIndexes = fixture.log.flatMap((entry, index) =>
      entry.startsWith(`navigate:${session.id}:`) ? [index] : [],
    );
    expect(bindingIndexes).toHaveLength(2);
    expect(initScriptIndexes).toHaveLength(2);
    expect(navigationIndexes).toHaveLength(2);
    expect(Math.max(...bindingIndexes, ...initScriptIndexes)).toBeLessThan(
      Math.min(...navigationIndexes),
    );
  });

  it("sends an authoritative tab reset after recovering a Cloak Context", async () => {
    const fixture = createFixture();
    const session = fixture.manager.createSession("Recover tabs", "recover.test", {
      backend: "cloak",
    });
    const renderer = { isDestroyed: () => false, send: vi.fn() };
    await fixture.manager.activateSession(session.id, renderer as never);
    const originalContext = fixture.cloakBackend.contexts.get(session.id)!;
    renderer.send.mockClear();

    originalContext.disconnect("crash");
    await vi.waitFor(() => {
      expect(
        renderer.send.mock.calls.some(([channel]) => channel === "tabs:reset"),
      ).toBe(true);
    });

    const reset = renderer.send.mock.calls.find(
      ([channel]) => channel === "tabs:reset",
    );
    const payload = reset?.[1] as {
      sessionId: string;
      contextId: string;
      tabId: null;
      tabs: Array<{
        id: string;
        sessionId: string;
        contextId: string;
        tabId: string;
      }>;
    };
    const tabs = payload.tabs;
    const recoveredContext = fixture.cloakBackend.contexts.get(session.id)!;
    const recoveredTabId = (await recoveredContext.targets())[0].tabId;
    expect(tabs).toHaveLength(1);
    expect(payload).toMatchObject({
      sessionId: session.id,
      contextId: recoveredContext.id,
      tabId: null,
    });
    expect(recoveredContext).not.toBe(originalContext);
    expect(tabs[0]).toMatchObject({
      id: recoveredTabId,
      sessionId: session.id,
      contextId: recoveredContext.id,
      tabId: recoveredTabId,
    });
    expect(fixture.coordinator.getActiveSessionId()).toBe(session.id);
  });

  it("does not leave a recovered Context when deletion races crash recovery", async () => {
    const fixture = createFixture();
    const session = fixture.manager.createSession("Recovery race", "race.test", {
      backend: "cloak",
    });
    await fixture.manager.activateSession(session.id);
    const recoveryGate = deferred();
    fixture.cloakBackend.openGates.set(session.id, recoveryGate.promise);

    fixture.cloakBackend.contexts.get(session.id)!.disconnect("crash");
    await vi.waitFor(() => {
      expect(fixture.cloakBackend.openAttempts).toHaveLength(2);
    });
    const deleting = fixture.manager.deleteSession(session.id, undefined, {
      retainProfile: true,
    });

    recoveryGate.resolve();
    await deleting;

    expect(fixture.manager.getSession(session.id)).toBeNull();
    expect(fixture.coordinator.hasOpenSession(session.id)).toBe(false);
    expect(fixture.cloakBackend.contexts.has(session.id)).toBe(false);
  });

  it("rolls proxy failures back to the old Context, tabs, and running capture", async () => {
    const fixture = createFixture();
    const session = fixture.manager.createSession("Cloak", "cloak.test", {
      backend: "cloak",
    });
    const previousProxy: ProxyConfig = {
      type: "http",
      host: "old.proxy",
      port: 8080,
    };
    const nextProxy: ProxyConfig = {
      type: "http",
      host: "new.proxy",
      port: 9090,
    };
    const renderer = {
      isDestroyed: () => false,
      send: vi.fn(),
    };

    await fixture.manager.startCapture(
      session.id,
      undefined,
      renderer as never,
      previousProxy,
    );
    await vi.waitFor(() => expect(captureMocks.storageStart).toHaveBeenCalledOnce());
    await Promise.resolve();
    const originalContext = fixture.cloakBackend.contexts.get(session.id)!;
    const originalTarget = (await originalContext.targets())[0] as FakeTarget;
    expect(originalTarget.url).toBe("cloak.test");
    fixture.cloakBackend.failOpen = (options) =>
      options.proxy?.host === nextProxy.host;

    await expect(
      fixture.manager.restartOpenCloakContexts(nextProxy, previousProxy),
    ).rejects.toThrow("new proxy failed");
    await vi.waitFor(() => expect(captureMocks.storageStart).toHaveBeenCalledTimes(2));

    const restoredContext = fixture.cloakBackend.contexts.get(session.id)!;
    const restoredTarget = (await restoredContext.targets())[0] as FakeTarget;
    expect(restoredContext).not.toBe(originalContext);
    expect(restoredContext.options.proxy).toEqual(previousProxy);
    expect(restoredTarget.url).toBe(originalTarget.url);
    expect(fixture.manager.getActiveBrowserSessionId()).toBe(session.id);
    expect(fixture.manager.getCurrentSessionId()).toBe(session.id);
    expect(fixture.manager.getSession(session.id)?.status).toBe("running");
    expect(fixture.captureEngine.start).toHaveBeenCalledTimes(2);
    expect(fixture.captureEngine.stop).toHaveBeenCalledOnce();
    expect(fixture.cloakBackend.openAttempts.map((attempt) => attempt.proxy?.host)).toEqual([
      "old.proxy",
      "new.proxy",
      "old.proxy",
    ]);

    const closeIndex = fixture.log.indexOf(`close:${session.id}`);
    const persistIndex = fixture.log.lastIndexOf(
      `persist:${session.browser_profile_id}`,
      closeIndex,
    );
    expect(persistIndex).toBeGreaterThanOrEqual(0);
    expect(persistIndex).toBeLessThan(closeIndex);
  });

  it("does not close Contexts for a proxy rebuild when tab persistence fails", async () => {
    const fixture = createFixture(2);
    const first = fixture.manager.createSession("First", "first.test", {
      backend: "cloak",
    });
    const second = fixture.manager.createSession("Second", "second.test", {
      backend: "cloak",
    });
    await fixture.manager.activateSession(first.id);
    await fixture.manager.activateSession(second.id);
    const firstContext = fixture.cloakBackend.contexts.get(first.id)!;
    const secondContext = fixture.cloakBackend.contexts.get(second.id)!;
    const originalOpenAttempts = fixture.cloakBackend.openAttempts.length;
    fixture.tabs.replaceError = new Error("tab persistence failed");
    fixture.tabs.replaceErrorProfileId = second.browser_profile_id!;

    await expect(
      fixture.manager.restartOpenCloakContexts(
        { type: "http", host: "new.proxy", port: 9090 },
        null,
      ),
    ).rejects.toThrow("tab persistence failed");

    expect(fixture.cloakBackend.contexts.get(first.id)).toBe(firstContext);
    expect(fixture.cloakBackend.contexts.get(second.id)).toBe(secondContext);
    expect(firstContext.isClosed()).toBe(false);
    expect(secondContext.isClosed()).toBe(false);
    expect(fixture.cloakBackend.openAttempts).toHaveLength(originalOpenAttempts);
    expect(fixture.log).not.toContain(`close:${first.id}`);
    expect(fixture.log).not.toContain(`close:${second.id}`);
    fixture.tabs.replaceError = null;
    fixture.tabs.replaceErrorProfileId = null;
  });

  it("keeps the last activation request active when an earlier launch is slow", async () => {
    const fixture = createFixture();
    const slow = fixture.manager.createSession("Slow", "slow.test", {
      backend: "cloak",
    });
    const warm = fixture.manager.createSession("Warm", "warm.test", {
      backend: "cloak",
    });
    await fixture.manager.activateSession(warm.id);
    await fixture.manager.deactivateBrowser();

    const openGate = deferred();
    fixture.cloakBackend.openGates.set(slow.id, openGate.promise);
    const activateSlow = fixture.manager.activateSession(slow.id);
    await vi.waitFor(() => {
      expect(
        fixture.cloakBackend.openAttempts.some(
          (attempt) => attempt.sessionId === slow.id,
        ),
      ).toBe(true);
    });
    const activateWarm = fixture.manager.activateSession(warm.id);

    openGate.resolve();
    await Promise.all([activateSlow, activateWarm]);

    expect(fixture.coordinator.getActiveSessionId()).toBe(warm.id);
    expect(fixture.manager.getActiveBrowserSessionId()).toBe(warm.id);
  });

  it("closes a Context opened concurrently with Session deletion", async () => {
    const fixture = createFixture();
    const session = fixture.manager.createSession("Delete race", "delete.test", {
      backend: "cloak",
    });
    const openGate = deferred();
    fixture.cloakBackend.openGates.set(session.id, openGate.promise);

    const activating = fixture.manager.activateSession(session.id);
    await vi.waitFor(() => {
      expect(fixture.cloakBackend.openAttempts).toHaveLength(1);
    });
    const deleting = fixture.manager.deleteSession(session.id, undefined, {
      retainProfile: true,
    });

    openGate.resolve();
    await Promise.all([activating, deleting]);

    expect(fixture.manager.getSession(session.id)).toBeNull();
    expect(fixture.coordinator.hasOpenSession(session.id)).toBe(false);
    expect(fixture.cloakBackend.contexts.has(session.id)).toBe(false);
    expect(fixture.coordinator.getActiveSessionId()).toBeNull();
  });

  it("rebuilds a slow-opening active Context with the requested capture mode", async () => {
    const fixture = createFixture();
    const session = fixture.manager.createSession("Mode race", "mode.test", {
      backend: "cloak",
    });
    const openGate = deferred();
    fixture.cloakBackend.openGates.set(session.id, openGate.promise);

    const activating = fixture.manager.activateSession(session.id);
    await vi.waitFor(() => {
      expect(fixture.cloakBackend.openAttempts).toHaveLength(1);
    });
    const changingMode = fixture.manager.setCaptureMode(session.id, "deep");

    openGate.resolve();
    await Promise.all([activating, changingMode]);

    expect(fixture.cloakBackend.openAttempts).toHaveLength(2);
    expect(fixture.cloakBackend.contexts.get(session.id)?.options.captureMode).toBe(
      "deep",
    );
    expect(fixture.manager.getSession(session.id)?.capture_mode).toBe("deep");
    expect(fixture.coordinator.getActiveSessionId()).toBe(session.id);
  });

  it("evicts only an inactive Cloak Context and preserves active routing on launch failure", async () => {
    const fixture = createFixture(2);
    const active = fixture.manager.createSession("Active", "active.test", {
      backend: "cloak",
    });
    const inactive = fixture.manager.createSession("Inactive", "inactive.test", {
      backend: "cloak",
    });
    const failing = fixture.manager.createSession("Failing", "failing.test", {
      backend: "cloak",
    });
    await fixture.manager.activateSession(inactive.id);
    await fixture.manager.activateSession(active.id);
    const activeContext = fixture.cloakBackend.contexts.get(active.id)!;
    const inactiveContext = fixture.cloakBackend.contexts.get(inactive.id)!;
    activeContext.lastUsedAt = 0;
    inactiveContext.lastUsedAt = 100;
    fixture.cloakBackend.failOpen = (options) => options.sessionId === failing.id;

    await expect(fixture.manager.activateSession(failing.id)).rejects.toThrow(
      "new proxy failed",
    );

    expect(fixture.cloakBackend.contexts.get(active.id)).toBe(activeContext);
    expect(fixture.cloakBackend.contexts.has(inactive.id)).toBe(false);
    expect(fixture.coordinator.getActiveSessionId()).toBe(active.id);
    expect(fixture.manager.getActiveBrowserSessionId()).toBe(active.id);
    expect(fixture.log).toContain(`close:${inactive.id}`);
    expect(fixture.log).not.toContain(`close:${active.id}`);
  });

  it.each(["running", "paused"] as const)(
    "restores the evicted active Context, tabs, and %s capture after a single-seat launch failure",
    async (captureStatus) => {
      const fixture = createFixture(1);
      const active = fixture.manager.createSession("Active", "https://active.test/one", {
        backend: "cloak",
      });
      const failing = fixture.manager.createSession("Failing", "https://failing.test", {
        backend: "cloak",
      });
      const renderer = { isDestroyed: () => false, send: vi.fn() };

      await fixture.manager.activateSession(active.id);
      await fixture.manager.createBrowserTab("https://active.test/two", active.id);
      await fixture.manager.startCapture(
        active.id,
        undefined,
        renderer as never,
      );
      if (captureStatus === "paused") {
        await fixture.manager.pauseCapture(active.id);
      }
      const originalContext = fixture.cloakBackend.contexts.get(active.id)!;
      fixture.cloakBackend.failOpen = (options) => options.sessionId === failing.id;

      await expect(fixture.manager.activateSession(failing.id)).rejects.toThrow(
        "new proxy failed",
      );

      const restoredContext = fixture.cloakBackend.contexts.get(active.id)!;
      const restoredTargets = await restoredContext.targets();
      expect(restoredContext).not.toBe(originalContext);
      expect(restoredTargets.map((target) => target.url)).toEqual([
        "https://active.test/one",
        "https://active.test/two",
      ]);
      expect(restoredTargets.find((target) => target.getState().isActive)?.url).toBe(
        "https://active.test/two",
      );
      expect(fixture.coordinator.getActiveSessionId()).toBe(active.id);
      expect(fixture.manager.getActiveBrowserSessionId()).toBe(active.id);
      expect(fixture.manager.getCurrentSessionId()).toBe(active.id);
      expect(fixture.manager.getSession(active.id)?.status).toBe(captureStatus);
      expect(
        fixture.cloakBackend.openAttempts.filter(
          (attempt) => attempt.sessionId === active.id,
        ),
      ).toHaveLength(2);
      expect(fixture.cloakBackend.contexts.has(failing.id)).toBe(false);
    },
  );

  it("does not evict an LRU Context when its tabs cannot be persisted", async () => {
    const fixture = createFixture(1);
    const active = fixture.manager.createSession("Active", "active.test", {
      backend: "cloak",
    });
    const pending = fixture.manager.createSession("Pending", "pending.test", {
      backend: "cloak",
    });
    await fixture.manager.activateSession(active.id);
    const activeContext = fixture.cloakBackend.contexts.get(active.id)!;
    fixture.tabs.replaceError = new Error("tab persistence failed");

    await expect(fixture.manager.activateSession(pending.id)).rejects.toThrow(
      "tab persistence failed",
    );

    expect(fixture.cloakBackend.contexts.get(active.id)).toBe(activeContext);
    expect(activeContext.isClosed()).toBe(false);
    expect(
      fixture.cloakBackend.openAttempts.filter(
        (attempt) => attempt.sessionId === pending.id,
      ),
    ).toHaveLength(0);
    expect(fixture.coordinator.getActiveSessionId()).toBe(active.id);
    expect(fixture.manager.getActiveBrowserSessionId()).toBe(active.id);
    expect(fixture.log).not.toContain(`close:${active.id}`);
    fixture.tabs.replaceError = null;
  });

  it("allows shutdown to retry after a backend shutdown failure", async () => {
    const fixture = createFixture();
    fixture.cloakBackend.shutdownFailuresRemaining = 1;

    const firstAttempt = fixture.manager.shutdown();
    const concurrentAttempt = fixture.manager.shutdown();
    expect(concurrentAttempt).toBe(firstAttempt);
    await expect(firstAttempt).rejects.toThrow();
    const secondAttempt = fixture.manager.shutdown();

    expect(secondAttempt).not.toBe(firstAttempt);
    await expect(secondAttempt).resolves.toBeUndefined();
    expect(fixture.cloakBackend.shutdownAttempts).toBe(2);
    expect(fixture.manager.shutdown()).toBe(secondAttempt);
  });

  it("continues shutdown when the final tab snapshot cannot be persisted", async () => {
    const fixture = createFixture();
    const session = fixture.manager.createSession("Cloak", "cloak.test", {
      backend: "cloak",
    });
    await fixture.manager.activateSession(session.id);
    const context = fixture.cloakBackend.contexts.get(session.id)!;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fixture.tabs.replaceError = new Error("tab persistence failed");

    await expect(fixture.manager.shutdown()).resolves.toBeUndefined();

    expect(context.isClosed()).toBe(true);
    expect(fixture.cloakBackend.shutdownAttempts).toBe(1);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("Failed to persist tabs"),
      "tab persistence failed",
    );
    fixture.tabs.replaceError = null;
    warning.mockRestore();
  });

  it("does not move the recorder to a background Deep Session popup", async () => {
    const fixture = createFixture(2, { withInteractionRecorder: true });
    const foreground = fixture.manager.createSession("Foreground", "front.test", {
      backend: "cloak",
      captureMode: "deep",
    });
    const background = fixture.manager.createSession("Background", "back.test", {
      backend: "cloak",
      captureMode: "deep",
    });
    const renderer = { isDestroyed: () => false, send: vi.fn() };
    await fixture.manager.activateSession(background.id, renderer as never);
    await fixture.manager.startCapture(
      foreground.id,
      undefined,
      renderer as never,
    );
    expect(interactionRecorderSessionId(fixture.manager)).toBe(foreground.id);

    await fixture.cloakBackend.contexts.get(background.id)!.createTarget();
    await settleBrowserEvents();

    expect(interactionRecorderSessionId(fixture.manager)).toBe(foreground.id);
    expect(interactionRecorderIsRecording(fixture.manager)).toBe(true);
  });
});

describe("SessionManager Cloak Profile lifecycle", () => {
  it("creates a Session, Profile, and browser config atomically", () => {
    const fixture = createFixture();
    fixture.configs.upsertError = new Error("config insert failed");
    fixture.sessions.deleteError = new Error("session cleanup failed");
    fixture.profiles.deleteError = new Error("profile cleanup failed");

    expect(() =>
      fixture.manager.createSession("Cloak", "cloak.test", {
        backend: "cloak",
      }),
    ).toThrow("config insert failed");

    expect(fixture.sessions.findAll()).toEqual([]);
    expect(fixture.configs.configs.size).toBe(0);
    expect(fixture.profiles.profiles.size).toBe(0);
    fixture.configs.upsertError = null;
    fixture.sessions.deleteError = null;
    fixture.profiles.deleteError = null;
  });

  it("makes Profile deletion interrupted by a crash retryable on startup", () => {
    const fixture = createFixture();
    const profile: BrowserProfile = {
      id: "interrupted-profile",
      display_name: "Interrupted deletion",
      profile_key: "interrupted-profile-key",
      cloak_seed: "1234",
      state: "deleting",
      last_used_at: 1,
      retained_at: null,
      last_error: null,
      created_at: 1,
      updated_at: 1,
    };
    fixture.profiles.insert(profile);

    fixture.manager.recoverFromCrash();

    expect(fixture.profiles.findById(profile.id)).toMatchObject({
      state: "delete_failed",
      last_error: "Profile deletion was interrupted; retry permanent deletion",
    });
    expect(fixture.manager.listRetainedProfiles()).toContainEqual(
      expect.objectContaining({ id: profile.id, state: "delete_failed" }),
    );
  });

  it("repairs interrupted Profile attachment state during startup recovery", () => {
    const fixture = createFixture();
    const referencedSession = fixture.manager.createSession(
      "Referenced",
      "referenced.test",
      { backend: "cloak" },
    );
    const referencedProfileId = referencedSession.browser_profile_id!;
    fixture.profiles.updateState(
      referencedProfileId,
      "retained",
      "stale retained state",
      2,
    );
    const deletingSession = fixture.manager.createSession(
      "Deleting",
      "deleting.test",
      { backend: "cloak" },
    );
    const deletingProfileId = deletingSession.browser_profile_id!;
    fixture.profiles.updateState(
      deletingProfileId,
      "deleting",
      "stale deleting state",
      2,
    );
    const orphan: BrowserProfile = {
      id: "orphan-attached-profile",
      display_name: "Orphan",
      profile_key: "orphan-attached-profile-key",
      cloak_seed: "4321",
      state: "attached",
      last_used_at: 1,
      retained_at: null,
      last_error: null,
      created_at: 1,
      updated_at: 1,
    };
    fixture.profiles.insert(orphan);

    fixture.manager.recoverFromCrash();

    expect(fixture.profiles.findById(orphan.id)).toMatchObject({
      state: "retained",
      last_error: "Profile attachment was interrupted; retained for recovery",
    });
    expect(fixture.profiles.findById(referencedProfileId)).toMatchObject({
      state: "attached",
      retained_at: null,
      last_error: null,
    });
    expect(fixture.profiles.findById(deletingProfileId)).toMatchObject({
      state: "attached",
      retained_at: null,
      last_error: null,
    });
  });

  it("rolls startup recovery back when a Profile repair fails", () => {
    const fixture = createFixture();
    const session = fixture.manager.createSession("Running", "running.test");
    fixture.sessions.updateStatus(session.id, "running");
    const profile: BrowserProfile = {
      id: "recovery-rollback-profile",
      display_name: "Recovery rollback",
      profile_key: "recovery-rollback-profile-key",
      cloak_seed: "9876",
      state: "deleting",
      last_used_at: 1,
      retained_at: null,
      last_error: null,
      created_at: 1,
      updated_at: 1,
    };
    fixture.profiles.insert(profile);
    fixture.profiles.updateStateError = new Error("profile recovery failed");

    expect(() => fixture.manager.recoverFromCrash()).toThrow(
      "profile recovery failed",
    );

    expect(fixture.sessions.findById(session.id)?.status).toBe("running");
    expect(fixture.profiles.findById(profile.id)).toMatchObject({
      state: "deleting",
      last_error: null,
    });
    fixture.profiles.updateStateError = null;
  });

  it.each([
    ["retain", true],
    ["permanently delete", false],
  ])(
    "rolls back Profile state when Session deletion fails during %s",
    async (_label, retainProfile) => {
      const fixture = createFixture();
      const session = fixture.manager.createSession("Cloak", "cloak.test", {
        backend: "cloak",
      });
      const profileId = session.browser_profile_id!;
      fixture.sessions.deleteError = new Error("session delete failed");

      await expect(
        fixture.manager.deleteSession(session.id, undefined, { retainProfile }),
      ).rejects.toThrow("session delete failed");

      expect(fixture.sessions.findById(session.id)).toBeTruthy();
      expect(fixture.configs.findBySessionId(session.id)).toBeTruthy();
      expect(fixture.profiles.findById(profileId)).toMatchObject({
        state: "attached",
        retained_at: null,
        last_error: null,
      });
      expect(fixture.cloakBackend.deleteAttempts).toEqual([]);
      fixture.sessions.deleteError = null;
    },
  );

  it.each([
    ["retain", true],
    ["permanently delete", false],
  ])(
    "does not %s a Profile when its open tabs cannot be persisted",
    async (_label, retainProfile) => {
      const fixture = createFixture();
      const session = fixture.manager.createSession("Cloak", "cloak.test", {
        backend: "cloak",
      });
      const profileId = session.browser_profile_id!;
      await fixture.manager.activateSession(session.id);
      const context = fixture.cloakBackend.contexts.get(session.id)!;
      fixture.tabs.replaceError = new Error("tab persistence failed");

      await expect(
        fixture.manager.deleteSession(session.id, undefined, { retainProfile }),
      ).rejects.toThrow("tab persistence failed");

      expect(fixture.sessions.findById(session.id)).toBeTruthy();
      expect(fixture.profiles.findById(profileId)?.state).toBe("attached");
      expect(fixture.cloakBackend.contexts.get(session.id)).toBe(context);
      expect(context.isClosed()).toBe(false);
      expect(fixture.cloakBackend.deleteAttempts).toEqual([]);
      fixture.tabs.replaceError = null;
    },
  );

  it.each([
    ["ordinary delete", false],
    ["MCP-style explicit delete", true],
  ])(
    "%s removes the Session config, Profile, and Profile-owned tabs",
    async (_label, explicitOptions) => {
      const fixture = createFixture();
      const session = fixture.manager.createSession("Cloak", "cloak.test", {
        backend: "cloak",
      });
      const profileId = session.browser_profile_id!;
      const profileKey = fixture.profiles.findById(profileId)!.profile_key;
      fixture.tabs.tabs.set(profileId, [
        {
          id: "saved-tab",
          profile_id: profileId,
          url: "https://saved.test",
          title: "Saved",
          position: 0,
          active: true,
          updated_at: 1,
        },
      ]);

      if (explicitOptions) {
        await fixture.manager.deleteSession(session.id, undefined, {
          retainProfile: false,
        });
      } else {
        await fixture.manager.deleteSession(session.id);
      }

      expect(fixture.sessions.findById(session.id)).toBeUndefined();
      expect(fixture.configs.findBySessionId(session.id)).toBeNull();
      expect(fixture.profiles.findById(profileId)).toBeNull();
      expect(fixture.tabs.findByProfileId(profileId)).toEqual([]);
      expect(fixture.cloakBackend.deleteAttempts).toEqual([profileKey]);
    },
  );

  it("keeps a failed directory deletion retryable but never restorable", async () => {
    const fixture = createFixture();
    const session = fixture.manager.createSession("Cloak", "cloak.test", {
      backend: "cloak",
    });
    const profileId = session.browser_profile_id!;
    const profileKey = fixture.profiles.findById(profileId)!.profile_key;
    fixture.tabs.tabs.set(profileId, [
      {
        id: "saved-tab",
        profile_id: profileId,
        url: "https://saved.test",
        title: "Saved",
        position: 0,
        active: true,
        updated_at: 1,
      },
    ]);
    fixture.cloakBackend.failDelete = true;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await fixture.manager.deleteSession(session.id, undefined, {
      retainProfile: false,
    });

    expect(fixture.sessions.findById(session.id)).toBeUndefined();
    expect(fixture.configs.findBySessionId(session.id)).toBeNull();
    expect(fixture.profiles.findById(profileId)).toMatchObject({
      state: "delete_failed",
      last_error: "profile directory delete failed",
    });
    expect(fixture.tabs.findByProfileId(profileId)).toHaveLength(1);
    expect(() => fixture.manager.restoreBrowserProfile(profileId)).toThrow(
      /not recoverable/i,
    );

    fixture.cloakBackend.failDelete = false;
    await fixture.manager.deleteBrowserProfile(profileId);

    expect(fixture.cloakBackend.deleteAttempts).toEqual([profileKey, profileKey]);
    expect(fixture.profiles.findById(profileId)).toBeNull();
    expect(fixture.tabs.findByProfileId(profileId)).toEqual([]);
    warning.mockRestore();
  });

  it("retains Profile tabs and restores them into a stopped passive Cloak Session", async () => {
    const fixture = createFixture();
    const session = fixture.manager.createSession(
      "Checkout",
      "https://first.test",
      { backend: "cloak" },
    );
    const profileId = session.browser_profile_id!;
    await fixture.manager.activateSession(session.id);
    const activeTab = await fixture.manager.createBrowserTab("https://second.test/\u8d2d\u7269\ud83d\uded2");

    await fixture.manager.deleteSession(session.id, undefined, {
      retainProfile: true,
    });

    const retainedTabs = fixture.tabs.findByProfileId(profileId);
    expect(fixture.sessions.findById(session.id)).toBeUndefined();
    expect(fixture.configs.findBySessionId(session.id)).toBeNull();
    expect(fixture.profiles.findById(profileId)?.state).toBe("retained");
    expect(retainedTabs.map((tab) => tab.url)).toEqual([
      "https://first.test",
      "https://second.test/\u8d2d\u7269\ud83d\uded2",
    ]);
    expect(retainedTabs.find((tab) => tab.active)?.id).toBe(activeTab.id);

    const restored = fixture.manager.restoreBrowserProfile(profileId);

    expect(restored).toMatchObject({
      status: "stopped",
      browser_backend: "cloak",
      capture_mode: "passive",
      browser_profile_id: profileId,
      target_url: "https://second.test/\u8d2d\u7269\ud83d\uded2",
    });
    expect(fixture.configs.findBySessionId(restored.id)).toMatchObject({
      browser_backend: "cloak",
      capture_mode: "passive",
      profile_id: profileId,
    });
    expect(fixture.profiles.findById(profileId)?.state).toBe("attached");
    expect(fixture.tabs.findByProfileId(profileId)).toEqual(retainedTabs);
  });

  it("restores a retained Profile atomically when its state update fails", async () => {
    const fixture = createFixture();
    const session = fixture.manager.createSession("Cloak", "cloak.test", {
      backend: "cloak",
    });
    const profileId = session.browser_profile_id!;
    await fixture.manager.deleteSession(session.id, undefined, {
      retainProfile: true,
    });
    fixture.profiles.updateStateError = new Error("profile attach failed");
    fixture.sessions.deleteError = new Error("session cleanup failed");

    expect(() => fixture.manager.restoreBrowserProfile(profileId)).toThrow(
      "profile attach failed",
    );

    expect(fixture.sessions.findAll()).toEqual([]);
    expect(fixture.configs.configs.size).toBe(0);
    expect(fixture.profiles.findById(profileId)).toMatchObject({
      state: "retained",
      last_error: null,
    });
    fixture.profiles.updateStateError = null;
    fixture.sessions.deleteError = null;
  });

  it("rejects a missing Profile for both restore and Session activation before backend open", async () => {
    const fixture = createFixture();
    const session = fixture.manager.createSession("Missing", "missing.test", {
      backend: "cloak",
    });
    const profileId = session.browser_profile_id!;
    fixture.profiles.updateState(profileId, "missing", "directory disappeared");

    expect(() => fixture.manager.restoreBrowserProfile(profileId)).toThrow(
      /not recoverable/i,
    );
    await expect(fixture.manager.activateSession(session.id)).rejects.toMatchObject({
      code: "PROFILE_MISSING",
    });
    expect(fixture.cloakBackend.openAttempts).toHaveLength(0);
    expect(fixture.manager.getBrowserSessionStatus(session.id)).toMatchObject({
      state: "closed",
      backend: "cloak",
    });
  });
});

describe("SessionManager capture concurrency", () => {
  it.each(["stop", "pause", "delete"] as const)(
    "does not retain a capture when %s races a pending Storage start",
    async (operation) => {
      const fixture = createFixture();
      const session = fixture.manager.createSession("Concurrent", "race.test", {
        backend: "cloak",
      });
      const startGate = deferred();
      captureMocks.storageStart.mockImplementationOnce(() => startGate.promise);
      const renderer = { isDestroyed: () => false, send: vi.fn() };

      const starting = fixture.manager.startCapture(
        session.id,
        undefined,
        renderer as never,
      );
      await vi.waitFor(() => {
        expect(captureMocks.storageStart).toHaveBeenCalledOnce();
      });

      const ending =
        operation === "stop"
          ? fixture.manager.stopCapture(session.id)
          : operation === "pause"
            ? fixture.manager.pauseCapture(session.id)
            : fixture.manager.deleteSession(session.id, undefined, {
                retainProfile: true,
              });
      await Promise.resolve();
      startGate.resolve();
      await Promise.all([starting, ending]);

      expect(attachedCaptureCount(fixture.manager)).toBe(0);
      expect(captureMocks.storageStop).toHaveBeenCalledOnce();
      expect(captureMocks.cdpStop).toHaveBeenCalledOnce();
      if (operation === "pause") {
        expect(fixture.manager.getSession(session.id)?.status).toBe("paused");
      } else if (operation === "stop") {
        expect(fixture.manager.getSession(session.id)?.status).toBe("stopped");
      } else {
        expect(fixture.manager.getSession(session.id)).toBeNull();
      }
    },
  );

  it("finishes Storage.stop before stopping the shared CDP consumer", async () => {
    const fixture = createFixture();
    const session = fixture.manager.createSession("Ordering", "order.test", {
      backend: "cloak",
    });
    const renderer = { isDestroyed: () => false, send: vi.fn() };
    await fixture.manager.startCapture(
      session.id,
      undefined,
      renderer as never,
    );
    expect(attachedCaptureCount(fixture.manager)).toBe(1);

    const stopGate = deferred();
    const order: string[] = [];
    captureMocks.storageStop.mockImplementationOnce(async () => {
      order.push("storage:start");
      await stopGate.promise;
      order.push("storage:done");
    });
    captureMocks.cdpStop.mockImplementationOnce(() => {
      order.push("cdp:stop");
    });

    const pausing = fixture.manager.pauseCapture(session.id);
    await vi.waitFor(() => {
      expect(captureMocks.storageStop).toHaveBeenCalledOnce();
    });
    expect(order).toEqual(["storage:start"]);
    expect(captureMocks.cdpStop).not.toHaveBeenCalled();

    stopGate.resolve();
    await pausing;

    expect(order).toEqual(["storage:start", "storage:done", "cdp:stop"]);
    expect(attachedCaptureCount(fixture.manager)).toBe(0);
  });

  it("deduplicates target-created and initial Context preparation", async () => {
    const fixture = createFixture();
    const initGate = deferred();
    fixture.cloakBackend.startContextsEmpty = true;
    fixture.cloakBackend.initScriptGate = initGate.promise;
    const session = fixture.manager.createSession("Deep", "deep.test", {
      backend: "cloak",
      captureMode: "deep",
    });

    const activating = fixture.manager.activateSession(session.id);
    await vi.waitFor(() => {
      expect(fixture.cloakBackend.contexts.has(session.id)).toBe(true);
    });
    const context = fixture.cloakBackend.contexts.get(session.id)!;
    await vi.waitFor(async () => {
      expect(await context.targets()).toHaveLength(1);
    });
    const target = (await context.targets())[0] as FakeTarget;

    try {
      await settleBrowserEvents();
      expect(target.exposeBinding).toHaveBeenCalledOnce();
      expect(target.addInitScript).toHaveBeenCalledOnce();
    } finally {
      initGate.resolve();
      await activating;
    }

    expect(target.exposeBinding).toHaveBeenCalledOnce();
    expect(target.addInitScript).toHaveBeenCalledOnce();
  });

  it("serializes concurrent starts so only the newest Session remains running", async () => {
    const fixture = createFixture();
    const first = fixture.manager.createSession("First", "first.test", {
      backend: "cloak",
    });
    const second = fixture.manager.createSession("Second", "second.test", {
      backend: "cloak",
    });
    const firstOpenGate = deferred();
    fixture.cloakBackend.openGates.set(first.id, firstOpenGate.promise);
    const renderer = { isDestroyed: () => false, send: vi.fn() };

    const firstStart = fixture.manager.startCapture(
      first.id,
      undefined,
      renderer as never,
    );
    await vi.waitFor(() => {
      expect(
        fixture.cloakBackend.openAttempts.some(
          (attempt) => attempt.sessionId === first.id,
        ),
      ).toBe(true);
    });
    const secondStart = fixture.manager.startCapture(
      second.id,
      undefined,
      renderer as never,
    );

    firstOpenGate.resolve();
    await Promise.all([firstStart, secondStart]);

    expect(fixture.manager.getSession(first.id)?.status).toBe("stopped");
    expect(fixture.manager.getSession(second.id)?.status).toBe("running");
    expect(fixture.manager.getCurrentSessionId()).toBe(second.id);
    expect(attachedCaptureCount(fixture.manager)).toBe(1);
    expect(fixture.captureEngine.start.mock.calls.map(([id]) => id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(fixture.captureEngine.stop).toHaveBeenCalledOnce();
    const [firstStartOrder, secondStartOrder] =
      fixture.captureEngine.start.mock.invocationCallOrder;
    expect(firstStartOrder).toBeLessThan(
      fixture.captureEngine.stop.mock.invocationCallOrder[0],
    );
    expect(fixture.captureEngine.stop.mock.invocationCallOrder[0]).toBeLessThan(
      secondStartOrder,
    );
  });

  it("rolls a mid-start failure back to a stopped Session and recorder", async () => {
    const fixture = createFixture(2, { withInteractionRecorder: true });
    const session = fixture.manager.createSession("Start failure", "start.test", {
      backend: "cloak",
      captureMode: "deep",
    });
    const renderer = { isDestroyed: () => false, send: vi.fn() };
    await fixture.manager.activateSession(
      session.id,
      renderer as never,
    );
    const context = fixture.cloakBackend.contexts.get(session.id)!;
    fixture.captureEngine.start.mockImplementationOnce(() => {
      context.failNextTargetsWith = new Error("targets failed after start");
    });

    await expect(
      fixture.manager.startCapture(
        session.id,
        undefined,
        renderer as never,
      ),
    ).rejects.toThrow("targets failed after start");

    expect(fixture.manager.getSession(session.id)?.status).toBe("stopped");
    expect(fixture.manager.getCurrentSessionId()).toBeNull();
    expect(attachedCaptureCount(fixture.manager)).toBe(0);
    expect(fixture.captureEngine.start).toHaveBeenCalledOnce();
    expect(fixture.captureEngine.stop).toHaveBeenCalledOnce();
    expect(interactionRecorderIsRecording(fixture.manager)).toBe(false);

    await fixture.manager.startCapture(
      session.id,
      undefined,
      renderer as never,
    );
    expect(fixture.manager.getSession(session.id)?.status).toBe("running");
    expect(fixture.manager.getCurrentSessionId()).toBe(session.id);
    expect(attachedCaptureCount(fixture.manager)).toBe(1);
    expect(fixture.captureEngine.start).toHaveBeenCalledTimes(2);
    expect(interactionRecorderIsRecording(fixture.manager)).toBe(true);
  });

  it("rolls partial target attachments back when resume fails", async () => {
    const fixture = createFixture(2, { withInteractionRecorder: true });
    const session = fixture.manager.createSession("Resume failure", "resume.test", {
      backend: "cloak",
      captureMode: "deep",
    });
    const renderer = { isDestroyed: () => false, send: vi.fn() };
    await fixture.manager.activateSession(session.id, renderer as never);
    await fixture.manager.createBrowserTab("https://second.test");
    await fixture.manager.startCapture(
      session.id,
      undefined,
      renderer as never,
    );
    await fixture.manager.pauseCapture(session.id);
    expect(attachedCaptureCount(fixture.manager)).toBe(0);
    expect(interactionRecorderIsRecording(fixture.manager)).toBe(false);
    captureMocks.cdpStart.mockClear();
    captureMocks.cdpStop.mockClear();
    captureMocks.storageStart.mockReset();
    captureMocks.storageStop.mockClear();
    captureMocks.storageStart
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second target storage failed"));

    await expect(fixture.manager.resumeCapture(session.id)).rejects.toThrow(
      "second target storage failed",
    );

    expect(fixture.manager.getSession(session.id)?.status).toBe("paused");
    expect(fixture.manager.getCurrentSessionId()).toBe(session.id);
    expect(attachedCaptureCount(fixture.manager)).toBe(0);
    expect(interactionRecorderIsRecording(fixture.manager)).toBe(false);
    expect(captureMocks.storageStop).toHaveBeenCalledOnce();
    expect(captureMocks.cdpStop).toHaveBeenCalledTimes(2);

    captureMocks.storageStart.mockReset();
    await fixture.manager.resumeCapture(session.id);
    expect(fixture.manager.getSession(session.id)?.status).toBe("running");
    expect(attachedCaptureCount(fixture.manager)).toBe(2);
    expect(interactionRecorderIsRecording(fixture.manager)).toBe(true);
  });
});

describe("SessionManager public backend gates", () => {
  it("actively refreshes status only when the Cloak backend is available", async () => {
    const fixture = createFixture();
    fixture.cloakCheck.mockResolvedValueOnce({
      available: true,
      state: "login-required",
      loggedIn: false,
      plan: null,
      seats: 1,
      policy: "strict",
      configuredVersion: "140.0.0",
      actualVersion: null,
      error: "Sign in first",
      errorCode: null,
      downloadProgress: null,
    });

    await expect(fixture.manager.getCloakStatus()).resolves.toMatchObject({
      state: "login-required",
      loggedIn: false,
      error: "Sign in first",
    });
    expect(fixture.cloakCheck).toHaveBeenCalledOnce();
  });

  it("returns unavailable without touching a dormant runtime in public builds", async () => {
    const fixture = createFixture(2, {
      registerCloak: false,
      provideCloakRuntime: true,
    });

    await expect(fixture.manager.getCloakStatus()).resolves.toMatchObject({
      available: false,
      state: "unavailable",
      error: "CloakBrowser is not available in this build",
      errorCode: "BACKEND_NOT_AVAILABLE",
    });
    expect(fixture.cloakCheck).not.toHaveBeenCalled();
    await expect(fixture.manager.prepareCloakRuntime()).rejects.toMatchObject({
      code: "BACKEND_NOT_AVAILABLE",
    });
    expect(fixture.cloakBackend.openAttempts).toHaveLength(0);
  });

  it("rejects unavailable backends and unsupported modes before writing state", () => {
    const fixture = createFixture(2, { registerCloak: false });

    expect(() =>
      fixture.manager.createSession("Cloak", "cloak.test", {
        backend: "cloak",
      }),
    ).toThrow(expect.objectContaining({ code: "BACKEND_NOT_AVAILABLE" }));
    expect(() =>
      fixture.manager.createSession("Passive Electron", "electron.test", {
        backend: "electron",
        captureMode: "passive",
      }),
    ).toThrow(expect.objectContaining({ code: "CAPABILITY_UNSUPPORTED" }));

    expect(fixture.sessions.findAll()).toEqual([]);
    expect(fixture.configs.configs.size).toBe(0);
    expect(fixture.profiles.profiles.size).toBe(0);
    expect(fixture.electronBackend.openAttempts).toHaveLength(0);
    expect(fixture.cloakBackend.openAttempts).toHaveLength(0);
  });
});
