import { describe, expect, it } from "vitest";
import type { BrowserBackendKind, ProxyConfig } from "../../src/shared/types";
import {
  BrowserCoordinator,
  BrowserCoordinatorShutdownError,
} from "../../src/main/browser/browser-coordinator";
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

const CAPABILITIES: Readonly<BrowserCapabilities> = {
  presentation: "external",
  captureModes: ["deep"],
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

class FakeTarget implements BrowserTarget {
  readonly id: string;
  readonly tabId: string;
  readonly contextId: string;
  readonly backendKind: BrowserBackendKind;
  url = "about:blank";
  title = "Fake";
  active = true;
  closed = false;

  constructor(
    readonly sessionId: string,
    backendKind: BrowserBackendKind,
  ) {
    this.backendKind = backendKind;
    this.contextId = `${backendKind}:${sessionId}`;
    this.id = `${sessionId}-tab`;
    this.tabId = this.id;
  }

  isClosed(): boolean { return this.closed; }
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
  async navigate(url: string): Promise<void> { this.url = url; }
  async goBack(): Promise<void> {}
  async goForward(): Promise<void> {}
  async reload(): Promise<void> {}
  async activate(): Promise<void> { this.active = true; }
  async close(): Promise<void> { this.closed = true; }
  async evaluate<T = unknown>(): Promise<T> { return undefined as T; }
  async addInitScript(): Promise<string | null> { return null; }
  async exposeBinding(_name: string, _callback: BrowserBindingCallback): Promise<void> {}
  async captureScreenshot(): Promise<Buffer> { return Buffer.alloc(0); }
  async getCdpTransport(): Promise<CdpTransport> { throw new Error("unused"); }
  onEvent(_listener: (event: BrowserTargetEvent) => void): Unsubscribe { return () => {}; }
  getNativeHandle<T = unknown>(): T { return undefined as T; }
}

class FakeContext implements BrowserContext {
  readonly id: string;
  readonly sessionId: string;
  readonly backendKind: BrowserBackendKind;
  readonly options: Readonly<BrowserContextOptions>;
  readonly target: FakeTarget;
  closed = false;
  readonly proxyUpdates: Array<ProxyConfig | null> = [];
  failProxyUpdate = false;
  private readonly listeners = new Set<(event: BrowserContextEvent) => void>();

  constructor(
    backendKind: BrowserBackendKind,
    options: BrowserContextOptions,
    private readonly activationLog: string[],
  ) {
    this.backendKind = backendKind;
    this.options = options;
    this.sessionId = options.sessionId;
    this.id = `${backendKind}:${options.sessionId}`;
    this.target = new FakeTarget(options.sessionId, backendKind);
  }

  isClosed(): boolean { return this.closed; }
  async activate(): Promise<void> {
    this.activationLog.push(`start:${this.sessionId}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.activationLog.push(`end:${this.sessionId}`);
  }
  async targets(): Promise<BrowserTarget[]> { return [this.target]; }
  async listTargets(): Promise<BrowserTarget[]> { return this.targets(); }
  getTarget(tabId: string): BrowserTarget | null {
    return tabId === this.target.tabId ? this.target : null;
  }
  async createTarget(): Promise<BrowserTarget> { return this.target; }
  async activateTarget(tabId: string): Promise<BrowserTarget> {
    if (tabId !== this.target.tabId) throw new Error("missing target");
    await this.target.activate();
    return this.target;
  }
  async closeTarget(): Promise<void> { this.target.closed = true; }
  async clearData(_options?: BrowserClearDataOptions): Promise<void> {}
  async updateProxy(proxy: ProxyConfig | null): Promise<void> {
    this.proxyUpdates.push(proxy);
    if (this.failProxyUpdate) {
      this.failProxyUpdate = false;
      throw new Error(`proxy update failed for ${this.sessionId}`);
    }
  }
  async close(): Promise<void> { this.closed = true; }
  onEvent(listener: (event: BrowserContextEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  getNativeHandle<T = unknown>(): T { return undefined as T; }
  emit(event: BrowserContextEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

class FakeBackend implements BrowserBackend {
  readonly contexts = new Map<string, FakeContext>();
  readonly closeAttempts: string[] = [];
  started = 0;
  stopped = 0;
  closeFailuresRemaining = 0;
  shutdownFailuresRemaining: number;

  constructor(
    readonly kind: BrowserBackendKind,
    readonly capabilities: Readonly<BrowserCapabilities>,
    private readonly activationLog: string[] = [],
    failShutdown = false,
  ) {
    this.shutdownFailuresRemaining = failShutdown ? 1 : 0;
  }

  async start(): Promise<void> { this.started += 1; }
  async openContext(options: BrowserContextOptions): Promise<BrowserContext> {
    const context = new FakeContext(this.kind, options, this.activationLog);
    this.contexts.set(options.sessionId, context);
    return context;
  }
  getContext(sessionId: string): BrowserContext | null {
    return this.contexts.get(sessionId) ?? null;
  }
  async closeContext(sessionId: string): Promise<void> {
    this.closeAttempts.push(sessionId);
    if (this.closeFailuresRemaining > 0) {
      this.closeFailuresRemaining -= 1;
      throw new Error(`close failed for ${sessionId}`);
    }
    const context = this.contexts.get(sessionId);
    if (context) await context.close();
    this.contexts.delete(sessionId);
  }
  async deletePersistentProfile(): Promise<void> {}
  async shutdown(): Promise<void> {
    this.stopped += 1;
    if (this.shutdownFailuresRemaining > 0) {
      this.shutdownFailuresRemaining -= 1;
      throw new Error(`${this.kind} shutdown failed`);
    }
  }
}

describe("BrowserCoordinator", () => {
  it("opens, activates, and resolves a Session target", async () => {
    const coordinator = new BrowserCoordinator();
    const backend = new FakeBackend("cloak", CAPABILITIES);
    coordinator.registerBackend(backend);

    const context = await coordinator.openSession({
      backendKind: "cloak",
      sessionId: "session-a",
      captureMode: "deep",
    });
    await coordinator.setActiveSession("session-a");

    expect(backend.started).toBe(1);
    expect(coordinator.getActiveContext()).toBe(context);
    expect(coordinator.getActiveTarget()?.tabId).toBe("session-a-tab");
    expect(coordinator.resolveTarget("session-a").sessionId).toBe("session-a");
    expect(coordinator.getCapabilities()).toBe(CAPABILITIES);
  });

  it("serializes rapid Session transitions", async () => {
    const log: string[] = [];
    const coordinator = new BrowserCoordinator();
    coordinator.registerBackend(new FakeBackend("cloak", CAPABILITIES, log));
    await coordinator.openSession({ backendKind: "cloak", sessionId: "a" });
    await coordinator.openSession({ backendKind: "cloak", sessionId: "b" });

    await Promise.all([
      coordinator.setActiveSession("a"),
      coordinator.setActiveSession("b"),
    ]);

    expect(log).toEqual(["start:a", "end:a", "start:b", "end:b"]);
    expect(coordinator.getActiveContext()?.sessionId).toBe("b");
  });

  it("forwards only correctly scoped backend events", async () => {
    const coordinator = new BrowserCoordinator();
    const backend = new FakeBackend("cloak", CAPABILITIES);
    coordinator.registerBackend(backend);
    const context = await coordinator.openSession({
      backendKind: "cloak",
      sessionId: "session-a",
    }) as FakeContext;
    const events: BrowserContextEvent[] = [];
    coordinator.onEvent((event) => events.push(event));

    context.emit({
      type: "target-activated",
      sessionId: "other-session",
      contextId: context.id,
      tabId: context.target.tabId,
    });
    context.emit({
      type: "target-activated",
      sessionId: context.sessionId,
      contextId: context.id,
      tabId: context.target.tabId,
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sessionId: "session-a",
      tabId: "session-a-tab",
    });
  });

  it("keeps active Session routing visible while notifying a disconnect", async () => {
    const coordinator = new BrowserCoordinator();
    const backend = new FakeBackend("cloak", CAPABILITIES);
    coordinator.registerBackend(backend);
    const context = await coordinator.openSession({
      backendKind: "cloak",
      sessionId: "session-a",
    }) as FakeContext;
    await coordinator.setActiveSession("session-a");
    const activeIds: Array<string | null> = [];
    coordinator.onEvent((event) => {
      if (event.type === "disconnected") {
        activeIds.push(coordinator.getActiveSessionId());
      }
    });

    context.closed = true;
    context.emit({
      type: "disconnected",
      sessionId: context.sessionId,
      contextId: context.id,
      tabId: null,
      reason: "browser exited",
    });

    expect(activeIds).toEqual(["session-a"]);
    expect(coordinator.getActiveSessionId()).toBeNull();
    expect(coordinator.hasOpenSession("session-a")).toBe(false);
  });

  it("does not clear active routing when a background Context disconnects", async () => {
    const coordinator = new BrowserCoordinator();
    const backend = new FakeBackend("cloak", CAPABILITIES);
    coordinator.registerBackend(backend);
    const active = await coordinator.openSession({
      backendKind: "cloak",
      sessionId: "active",
    });
    const background = await coordinator.openSession({
      backendKind: "cloak",
      sessionId: "background",
    }) as FakeContext;
    await coordinator.setActiveSession("active");

    background.closed = true;
    background.emit({
      type: "disconnected",
      sessionId: background.sessionId,
      contextId: background.id,
      tabId: null,
    });

    expect(coordinator.getActiveSessionId()).toBe("active");
    expect(coordinator.getActiveContext()).toBe(active);
    expect(coordinator.hasOpenSession("background")).toBe(false);
  });

  it("retains a live Context after backend close fails so close can be retried", async () => {
    const coordinator = new BrowserCoordinator();
    const backend = new FakeBackend("cloak", CAPABILITIES);
    coordinator.registerBackend(backend);
    const context = await coordinator.openSession({
      backendKind: "cloak",
      sessionId: "retry-close",
    }) as FakeContext;
    await coordinator.setActiveSession(context.sessionId);
    backend.closeFailuresRemaining = 1;

    await expect(coordinator.closeSession(context.sessionId)).rejects.toThrow(
      "close failed for retry-close",
    );

    expect(context.isClosed()).toBe(false);
    expect(backend.contexts.get(context.sessionId)).toBe(context);
    expect(coordinator.hasOpenSession(context.sessionId)).toBe(true);
    expect(coordinator.resolveContext(context.sessionId)).toBe(context);
    expect(backend.closeAttempts).toEqual([context.sessionId]);

    await coordinator.closeSession(context.sessionId);

    expect(context.isClosed()).toBe(true);
    expect(backend.contexts.has(context.sessionId)).toBe(false);
    expect(coordinator.hasOpenSession(context.sessionId)).toBe(false);
    expect(backend.closeAttempts).toEqual([context.sessionId, context.sessionId]);
  });

  it("retains a live Context after backend close fails so shutdown retries it", async () => {
    const coordinator = new BrowserCoordinator();
    const backend = new FakeBackend("cloak", CAPABILITIES);
    coordinator.registerBackend(backend);
    const context = await coordinator.openSession({
      backendKind: "cloak",
      sessionId: "shutdown-close",
    }) as FakeContext;
    backend.closeFailuresRemaining = 1;

    await expect(coordinator.closeSession(context.sessionId)).rejects.toThrow(
      "close failed for shutdown-close",
    );
    await coordinator.shutdown();

    expect(context.isClosed()).toBe(true);
    expect(backend.contexts.has(context.sessionId)).toBe(false);
    expect(backend.closeAttempts).toEqual([context.sessionId, context.sessionId]);
    expect(backend.stopped).toBe(1);
  });

  it("updates every open runtime-proxy Context and rolls all attempts back", async () => {
    const coordinator = new BrowserCoordinator();
    const backend = new FakeBackend("electron", {
      ...CAPABILITIES,
      proxyUpdate: "runtime",
    });
    coordinator.registerBackend(backend);
    const first = await coordinator.openSession({
      backendKind: "electron",
      sessionId: "first",
    }) as FakeContext;
    const second = await coordinator.openSession({
      backendKind: "electron",
      sessionId: "second",
    }) as FakeContext;
    const previous: ProxyConfig = { type: "none", host: "", port: 0 };
    const next: ProxyConfig = {
      type: "http",
      host: "proxy.example",
      port: 8080,
    };

    second.failProxyUpdate = true;
    await expect(
      coordinator.updateOpenContextProxies("electron", next, previous),
    ).rejects.toThrow("proxy update failed for second");

    expect(first.proxyUpdates).toEqual([next, previous]);
    expect(second.proxyUpdates).toEqual([next, previous]);
  });

  it("shuts every backend down and reports aggregate failures", async () => {
    const coordinator = new BrowserCoordinator();
    const electron = new FakeBackend("electron", CAPABILITIES, [], true);
    const cloak = new FakeBackend("cloak", CAPABILITIES);
    coordinator.registerBackend(electron);
    coordinator.registerBackend(cloak);

    await expect(coordinator.shutdown()).rejects.toBeInstanceOf(
      BrowserCoordinatorShutdownError,
    );
    expect(electron.stopped).toBe(1);
    expect(cloak.stopped).toBe(1);
  });

  it("retries a failed backend shutdown instead of marking it complete", async () => {
    const coordinator = new BrowserCoordinator();
    const backend = new FakeBackend("cloak", CAPABILITIES, [], true);
    coordinator.registerBackend(backend);

    await expect(coordinator.shutdown()).rejects.toBeInstanceOf(
      BrowserCoordinatorShutdownError,
    );
    await expect(coordinator.shutdown()).resolves.toBeUndefined();

    expect(backend.stopped).toBe(2);
  });

  it("retains a live Context when shutdown close fails and retries it", async () => {
    const coordinator = new BrowserCoordinator();
    const backend = new FakeBackend("cloak", CAPABILITIES);
    coordinator.registerBackend(backend);
    const context = (await coordinator.openSession({
      backendKind: "cloak",
      sessionId: "retry-shutdown",
    })) as FakeContext;
    backend.closeFailuresRemaining = 1;

    await expect(coordinator.shutdown()).rejects.toBeInstanceOf(
      BrowserCoordinatorShutdownError,
    );
    expect(context.isClosed()).toBe(false);
    expect(coordinator.hasOpenSession(context.sessionId)).toBe(true);

    await expect(coordinator.shutdown()).resolves.toBeUndefined();
    expect(context.isClosed()).toBe(true);
    expect(backend.closeAttempts).toEqual([context.sessionId, context.sessionId]);
  });
});
