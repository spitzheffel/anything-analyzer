import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type {
  BrowserContext as PlaywrightBrowserContext,
  Page,
} from "playwright-core";

vi.mock("electron", () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    isReady: () => true,
  },
}));

import {
  CloakBrowserBackend,
  CloakBrowserContext,
} from "../../../src/main/browser/cloak-backend";
import type { BrowserContextOptions } from "../../../src/main/browser/contracts";
import type {
  CloakRuntime,
  CloakRuntimeContext,
} from "../../../src/main/browser/cloak-runtime";

interface FakeBindingRegistration {
  attachName: string;
  activeRawName: string | null;
  queuedPayloads: string[];
}

function readStringConstant(source: string, name: string): string | null {
  const match = new RegExp(`const ${name} = ("(?:\\\\.|[^"\\\\])*");`).exec(
    source,
  );
  return match ? (JSON.parse(match[1]) as string) : null;
}

class FakeCdpSession extends EventEmitter {
  readonly globalBindings = new Set<string>();
  readonly subscribedBindings = new Set<string>();
  private readonly sendGates = new Map<string, Promise<void>>();
  private nextDetachError: Error | null = null;
  detached = false;

  readonly send = vi.fn(
    async (
      method: string,
      params: Record<string, unknown> = {},
    ): Promise<Record<string, unknown>> => {
      await this.sendGates.get(method);
      if (method === "Runtime.addBinding" && typeof params.name === "string") {
        this.globalBindings.add(params.name);
        this.subscribedBindings.add(params.name);
      }
      if (method === "Runtime.removeBinding" && typeof params.name === "string") {
        this.subscribedBindings.delete(params.name);
      }
      return {};
    },
  );

  readonly detach = vi.fn(async (): Promise<void> => {
    if (this.nextDetachError) {
      const error = this.nextDetachError;
      this.nextDetachError = null;
      throw error;
    }
    if (this.detached) return;
    this.detached = true;
    this.emit("close");
  });

  blockSend(method: string, gate: Promise<void>): void {
    this.sendGates.set(method, gate);
  }

  failNextDetach(error: Error): void {
    this.nextDetachError = error;
  }

  disconnectUnexpectedly(): void {
    if (this.detached) return;
    this.detached = true;
    this.clearBindings();
    this.emit("close");
  }

  clearBindings(): void {
    this.globalBindings.clear();
    this.subscribedBindings.clear();
  }

  emitBinding(name: string, payload: string): void {
    if (this.subscribedBindings.has(name)) {
      this.emit("Runtime.bindingCalled", { name, payload });
    }
  }

  emitProtocol(method: string, params: Record<string, unknown>): void {
    this.emit(method, params);
  }
}

class FakePage extends EventEmitter {
  readonly firstDocumentScripts: readonly string[];
  private closed = false;
  private readonly contextScripts: string[];
  private readonly registrations = new Map<string, FakeBindingRegistration>();
  private readonly cdpSessions: FakeCdpSession[] = [];

  constructor(
    private currentUrl: string,
    private readonly openerPage: FakePage | null,
    scripts: readonly string[],
    private readonly openerGate: Promise<void> | null = null,
  ) {
    super();
    this.firstDocumentScripts = [...scripts];
    this.contextScripts = [...scripts];
    for (const source of scripts) this.installBindingSource(source);
  }

  url(): string {
    return this.currentUrl;
  }

  async title(): Promise<string> {
    return "Fake page";
  }

  isClosed(): boolean {
    return this.closed;
  }

  async opener(): Promise<Page | null> {
    await this.openerGate;
    return this.openerPage as unknown as Page | null;
  }

  mainFrame(): this {
    return this;
  }

  frames(): this[] {
    return [this];
  }

  isDetached(): boolean {
    return false;
  }

  addContextScript(source: string): void {
    this.contextScripts.push(source);
  }

  addCdpSession(session: FakeCdpSession): void {
    this.cdpSessions.push(session);
  }

  async evaluate<T>(source: string): Promise<T> {
    const registration = this.installBindingSource(source);
    if (registration) return undefined as T;

    for (const candidate of this.registrations.values()) {
      if (source.includes(JSON.stringify(candidate.attachName))) {
        const argument = /\?\.\((null|"(?:\\.|[^"\\])*")\)/.exec(source)?.[1];
        const rawName = argument && argument !== "null"
          ? (JSON.parse(argument) as string)
          : null;
        return this.attachBinding(candidate, rawName) as T;
      }
    }
    return undefined as T;
  }

  invokeBinding(name: string, ...args: unknown[]): void {
    const registration = this.registrations.get(name);
    if (!registration) throw new Error(`Binding ${name} is not installed`);
    const payload = JSON.stringify({ args });
    if (!registration.activeRawName) {
      registration.queuedPayloads.push(payload);
      return;
    }
    const session = [...this.cdpSessions]
      .reverse()
      .find(
        (candidate) =>
          !candidate.detached &&
          candidate.globalBindings.has(registration.activeRawName!),
      );
    if (session) session.emitBinding(registration.activeRawName, payload);
    else registration.queuedPayloads.push(payload);
  }

  commitNavigation(url: string): void {
    this.currentUrl = url;
    for (const session of this.cdpSessions) session.clearBindings();
    this.registrations.clear();
    for (const source of this.contextScripts) this.installBindingSource(source);
    this.emit("framenavigated", this);
  }

  domContentLoaded(): void {
    this.emit("domcontentloaded");
  }

  readonly goto = vi.fn(async (url: string): Promise<void> => {
    this.commitNavigation(url);
    this.domContentLoaded();
  });

  readonly bringToFront = vi.fn(async (): Promise<void> => undefined);

  closePage(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }

  private installBindingSource(source: string): FakeBindingRegistration | null {
    const name = readStringConstant(source, "bindingName");
    const attachName = readStringConstant(source, "attachName");
    if (!name || !attachName) return null;
    const existing = this.registrations.get(name);
    if (existing) return existing;
    const registration = {
      attachName,
      activeRawName: null,
      queuedPayloads: [],
    };
    this.registrations.set(name, registration);
    return registration;
  }

  private attachBinding(
    registration: FakeBindingRegistration,
    rawName: string | null,
  ): boolean {
    if (rawName === null) {
      registration.activeRawName = null;
      return true;
    }
    const session = [...this.cdpSessions]
      .reverse()
      .find(
        (candidate) =>
          !candidate.detached && candidate.globalBindings.has(rawName),
      );
    if (!session) return false;
    registration.activeRawName = rawName;
    while (registration.queuedPayloads.length) {
      session.emitBinding(rawName, registration.queuedPayloads.shift()!);
    }
    return true;
  }
}

class FakeContext extends EventEmitter {
  readonly installedScripts: string[] = [];
  private readonly sessionsByPage = new Map<FakePage, FakeCdpSession[]>();
  readonly addInitScript = vi.fn(async ({ content }: { content: string }) => {
    this.installedScripts.push(content);
    for (const page of this.contextPages) page.addContextScript(content);
  });
  readonly newCDPSession = vi.fn(async (page: Page): Promise<FakeCdpSession> => {
    const fakePage = page as unknown as FakePage;
    const session = new FakeCdpSession();
    fakePage.addCdpSession(session);
    const sessions = this.sessionsByPage.get(fakePage) ?? [];
    sessions.push(session);
    this.sessionsByPage.set(fakePage, sessions);
    return session;
  });
  private readonly contextPages: FakePage[];

  constructor(firstPage?: FakePage) {
    super();
    this.contextPages = firstPage ? [firstPage] : [];
  }

  pages(): Page[] {
    return this.contextPages as unknown as Page[];
  }

  readonly newPage = vi.fn(async (): Promise<Page> => {
    const page = new FakePage("about:blank", null, this.installedScripts);
    this.addPage(page);
    return page as unknown as Page;
  });

  addPage(page: FakePage): void {
    this.contextPages.push(page);
    this.emit("page", page as unknown as Page);
  }

  popup(opener: FakePage, openerGate: Promise<void> | null = null): FakePage {
    const page = new FakePage(
      "https://example.com/popup",
      opener,
      this.installedScripts,
      openerGate,
    );
    this.addPage(page);
    return page;
  }

  latestSession(page: FakePage): FakeCdpSession {
    const session = this.sessionsByPage.get(page)?.at(-1);
    if (!session) throw new Error("Page has no CDP session");
    return session;
  }
}

function createHarness(
  options: BrowserContextOptions = { sessionId: "session-1" },
  firstPage = new FakePage("https://example.com", null, []),
  startEmpty = false,
): {
  browserContext: CloakBrowserContext;
  nativeContext: FakeContext;
  firstPage: FakePage;
  didClose: ReturnType<typeof vi.fn>;
} {
  const nativeContext = new FakeContext(startEmpty ? undefined : firstPage);
  let closed = false;
  const runtimeContext = {
    id: "context-1",
    sessionId: options.sessionId,
    nativeContext: nativeContext as unknown as PlaywrightBrowserContext,
    isClosed: () => closed,
    touch: vi.fn(),
    close: async () => {
      if (closed) return;
      closed = true;
      nativeContext.emit("close");
    },
  } as unknown as CloakRuntimeContext;
  const didClose = vi.fn();
  const browserContext = new CloakBrowserContext(
    runtimeContext,
    options,
    didClose,
  );
  return { browserContext, nativeContext, firstPage, didClose };
}

describe("CloakBrowser context-wide hooks", () => {
  it("restores blank targets and tab IDs without navigating saved URLs", async () => {
    const firstPage = new FakePage("about:blank", null, []);
    const restoredTabs = [
      {
        id: "saved-first",
        profile_id: "profile-1",
        url: "https://first.example/",
        title: "First",
        position: 0,
        active: false,
        updated_at: 1,
      },
      {
        id: "saved-second",
        profile_id: "profile-1",
        url: "https://second.example/",
        title: "Second",
        position: 1,
        active: true,
        updated_at: 1,
      },
    ];
    const { browserContext, nativeContext } = createHarness(
      {
        sessionId: "session-1",
        captureMode: "deep",
        backendOptions: { restoredTabs },
      },
      firstPage,
      true,
    );

    await browserContext.initialize();

    const targets = await browserContext.targets();
    expect(targets.map((target) => target.tabId)).toEqual([
      "saved-first",
      "saved-second",
    ]);
    expect(targets.map((target) => target.url)).toEqual([
      "about:blank",
      "about:blank",
    ]);
    expect(nativeContext.newPage).toHaveBeenCalledTimes(2);
    for (const target of targets) {
      const page = target.playwrightPage as unknown as FakePage;
      expect(page.goto).not.toHaveBeenCalled();
      expect(page.bringToFront).not.toHaveBeenCalled();
    }
  });

  it("does not let a concurrent popup consume a restored tab ID", async () => {
    const firstPage = new FakePage("about:blank", null, []);
    const restoredTabs = [
      {
        id: "saved-first",
        profile_id: "profile-1",
        url: "https://first.example/",
        title: "First",
        position: 0,
        active: false,
        updated_at: 1,
      },
      {
        id: "saved-second",
        profile_id: "profile-1",
        url: "https://second.example/",
        title: "Second",
        position: 1,
        active: true,
        updated_at: 1,
      },
    ];
    const { browserContext, nativeContext } = createHarness(
      {
        sessionId: "session-1",
        captureMode: "deep",
        backendOptions: { restoredTabs },
      },
      firstPage,
    );
    let restoredPage: FakePage | null = null;
    let popupPage: FakePage | null = null;
    nativeContext.newPage.mockImplementationOnce(async (): Promise<Page> => {
      popupPage = new FakePage(
        "https://example.com/popup",
        firstPage,
        nativeContext.installedScripts,
      );
      nativeContext.addPage(popupPage);
      restoredPage = new FakePage("about:blank", null, nativeContext.installedScripts);
      nativeContext.addPage(restoredPage);
      return restoredPage as unknown as Page;
    });

    await browserContext.initialize();

    const targets = await browserContext.targets();
    const restoredTarget = targets.find(
      (target) => target.playwrightPage === (restoredPage as unknown as Page),
    );
    const popupTarget = targets.find(
      (target) => target.playwrightPage === (popupPage as unknown as Page),
    );
    expect(restoredTarget?.tabId).toBe("saved-second");
    expect(popupTarget?.tabId).not.toBe("saved-second");
  });

  it("shares one script and binding while queueing an early popup call", async () => {
    const { browserContext, nativeContext, firstPage } = createHarness();
    const [firstTarget] = await browserContext.targets();
    const firstCallback = vi.fn();
    const popupCallback = vi.fn();

    await firstTarget.addInitScript("globalThis.__hookInstalled = true;");
    await firstTarget.exposeBinding("__hook", firstCallback);

    const popupPage = nativeContext.popup(firstPage);
    const popupTarget = (await browserContext.targets()).find(
      (target) => target.playwrightPage === (popupPage as unknown as Page),
    );
    expect(popupTarget).toBeDefined();
    expect(popupPage.firstDocumentScripts).toContain(
      "globalThis.__hookInstalled = true;",
    );

    popupPage.invokeBinding("__hook", { event: "early-1" });
    popupPage.invokeBinding("__hook", { event: "early-2" });
    expect(popupCallback).not.toHaveBeenCalled();

    await popupTarget!.addInitScript("globalThis.__hookInstalled = true;");
    await popupTarget!.exposeBinding("__hook", popupCallback);

    expect(nativeContext.addInitScript).toHaveBeenCalledTimes(2);
    expect(nativeContext.newCDPSession).toHaveBeenCalledTimes(2);
    expect(firstCallback).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(popupCallback).toHaveBeenCalledTimes(2));
    expect(popupCallback).toHaveBeenLastCalledWith({
      sessionId: "session-1",
      contextId: "context-1",
      tabId: popupTarget!.tabId,
      name: "__hook",
      args: [{ event: "early-2" }],
    });
  });

  it("reinstalls a queued binding after a document navigation", async () => {
    const { browserContext, nativeContext, firstPage } = createHarness();
    const [target] = await browserContext.targets();
    const callback = vi.fn();
    await target.exposeBinding("__hook", callback);

    const session = nativeContext.latestSession(firstPage);
    expect(session.subscribedBindings.size).toBe(1);
    firstPage.commitNavigation("https://example.com/next");
    expect(session.globalBindings.size).toBe(0);
    firstPage.invokeBinding("__hook", { event: "before-dom-ready" });
    expect(callback).not.toHaveBeenCalled();

    firstPage.domContentLoaded();

    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        contextId: "context-1",
        tabId: target.tabId,
        name: "__hook",
        args: [{ event: "before-dom-ready" }],
      }),
    );
    expect(session.subscribedBindings.size).toBe(1);
    expect(nativeContext.newCDPSession).toHaveBeenCalledTimes(1);

    await browserContext.refreshTargetBindings(target);
    firstPage.invokeBinding("__hook", { event: "same-document-refresh" });
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(2));
    expect(session.globalBindings.size).toBe(2);
    expect(session.subscribedBindings.size).toBe(1);
  });

  it("forwards Playwright protocol-named CDP events to every lease", async () => {
    const { browserContext, nativeContext, firstPage } = createHarness();
    const [target] = await browserContext.targets();
    const transport = await target.getCdpTransport();
    const captureLease = await transport.acquire("capture");
    const mcpLease = await transport.acquire("mcp");
    const captureMessages: unknown[] = [];
    const mcpMessages: unknown[] = [];
    captureLease.onMessage((message) => captureMessages.push(message));
    mcpLease.onMessage((message) => mcpMessages.push(message));

    nativeContext.latestSession(firstPage).emitProtocol("Network.responseReceived", {
      requestId: "request-1",
    });

    const expected = {
      method: "Network.responseReceived",
      params: { requestId: "request-1" },
      sessionId: "session-1",
    };
    expect(captureMessages).toEqual([expected]);
    expect(mcpMessages).toEqual([expected]);
    await captureLease.release();
    await mcpLease.release();
  });

  it("disables a lease-owned domain before releasing the last CDP session", async () => {
    const { browserContext, nativeContext, firstPage } = createHarness();
    const [target] = await browserContext.targets();
    const lease = await (await target.getCdpTransport()).acquire("mcp:raw");
    const session = nativeContext.latestSession(firstPage);

    await lease.send("Fetch.enable");
    await lease.release();

    expect(session.send.mock.calls.map(([method]) => method)).toEqual([
      "Fetch.enable",
      "Fetch.disable",
    ]);
    expect(session.detach).toHaveBeenCalledTimes(1);
  });

  it("serializes an in-flight domain enable ahead of lease release", async () => {
    const { browserContext, nativeContext, firstPage } = createHarness();
    const [target] = await browserContext.targets();
    const lease = await (await target.getCdpTransport()).acquire("mcp:raw");
    const session = nativeContext.latestSession(firstPage);
    let releaseEnable: (() => void) | undefined;
    const enableGate = new Promise<void>((resolve) => {
      releaseEnable = resolve;
    });
    session.blockSend("Fetch.enable", enableGate);

    const enable = lease.send("Fetch.enable");
    const release = lease.release();
    await Promise.resolve();
    expect(session.send).toHaveBeenCalledTimes(1);

    releaseEnable?.();
    await Promise.all([enable, release]);

    expect(session.send.mock.calls.map(([method]) => method)).toEqual([
      "Fetch.enable",
      "Fetch.disable",
    ]);
    expect(session.detach).toHaveBeenCalledTimes(1);
  });

  it("retains an active CDP session when detach fails and retries release", async () => {
    const { browserContext, nativeContext, firstPage } = createHarness();
    const [target] = await browserContext.targets();
    const transport = await target.getCdpTransport();
    const lease = await transport.acquire("mcp:raw");
    const session = nativeContext.latestSession(firstPage);
    session.failNextDetach(new Error("detach failed"));

    await expect(lease.release()).rejects.toMatchObject({
      code: "CDP_UNAVAILABLE",
    });
    expect(transport.connected).toBe(true);
    expect(lease.connected).toBe(true);

    await expect(lease.release()).resolves.toBeUndefined();
    expect(session.detach).toHaveBeenCalledTimes(2);
  });

  it("rebuilds a binding channel after an unexpected CDP disconnect", async () => {
    const { browserContext, nativeContext, firstPage } = createHarness();
    const [target] = await browserContext.targets();
    const callback = vi.fn();
    await target.exposeBinding("__hook", callback);
    const firstSession = nativeContext.latestSession(firstPage);

    firstSession.disconnectUnexpectedly();
    firstPage.invokeBinding("__hook", { event: "during-reconnect" });

    await vi.waitFor(() =>
      expect(nativeContext.newCDPSession).toHaveBeenCalledTimes(2),
    );
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({
        tabId: target.tabId,
        args: [{ event: "during-reconnect" }],
      }),
    );
  });

  it("invalidates the target and its CDP transport after a renderer crash", async () => {
    const { browserContext, nativeContext, firstPage } = createHarness();
    const [target] = await browserContext.targets();
    const lease = await (await target.getCdpTransport()).acquire("capture");
    const events: string[] = [];
    browserContext.onEvent((event) => events.push(event.type));

    firstPage.emit("crash");

    expect(target.isClosed()).toBe(true);
    expect(lease.connected).toBe(false);
    await expect(target.navigate("https://example.com/after-crash")).rejects.toMatchObject({
      code: "TARGET_CLOSED",
    });
    await expect(browserContext.targets()).resolves.toEqual([]);
    expect(events).toContain("target-crashed");
    await vi.waitFor(() =>
      expect(nativeContext.latestSession(firstPage).detach).toHaveBeenCalledTimes(1),
    );
  });

  it("prevents raw CDP callers from disabling Runtime while bindings use it", async () => {
    const { browserContext } = createHarness();
    const [target] = await browserContext.targets();
    await target.exposeBinding("__hook", vi.fn());
    const mcpLease = await (await target.getCdpTransport()).acquire("mcp:raw");

    await expect(mcpLease.send("Runtime.disable")).rejects.toMatchObject({
      code: "CDP_DOMAIN_CONFLICT",
    });

    await mcpLease.release();
    await browserContext.close();
  });

  it("clears hook routing state when the context closes", async () => {
    const { browserContext, nativeContext, firstPage } = createHarness();
    const [target] = await browserContext.targets();
    await target.addInitScript("globalThis.__hookInstalled = true;");
    await target.exposeBinding("__hook", vi.fn());

    await browserContext.close();

    const state = browserContext as unknown as {
      initScriptInstallations: Map<unknown, unknown>;
      bindingInstallations: Map<unknown, unknown>;
      bindingRegistrations: Map<unknown, unknown>;
      bindingChannels: Map<unknown, unknown>;
      bindingRefreshes: Map<unknown, unknown>;
      bindingCallbacks: Map<unknown, unknown>;
      pendingBindingCalls: Map<unknown, unknown>;
      targetsById: Map<unknown, unknown>;
    };
    expect(state.initScriptInstallations.size).toBe(0);
    expect(state.bindingInstallations.size).toBe(0);
    expect(state.bindingRegistrations.size).toBe(0);
    expect(state.bindingChannels.size).toBe(0);
    expect(state.bindingRefreshes.size).toBe(0);
    expect(state.bindingCallbacks.size).toBe(0);
    expect(state.pendingBindingCalls.size).toBe(0);
    expect(state.targetsById.size).toBe(0);
    expect(nativeContext.listenerCount("page")).toBe(0);
    await vi.waitFor(() =>
      expect(nativeContext.latestSession(firstPage).detach).toHaveBeenCalledTimes(1),
    );
  });

  it("announces a popup before its close when opener resolution is delayed", async () => {
    const { browserContext, nativeContext, firstPage } = createHarness();
    let releaseOpener: (() => void) | undefined;
    const openerGate = new Promise<void>((resolve) => {
      releaseOpener = resolve;
    });
    const events: string[] = [];
    browserContext.onEvent((event) => {
      if (event.type === "target-created" || event.type === "target-closed") {
        events.push(event.type);
      }
    });

    const popupPage = nativeContext.popup(firstPage, openerGate);
    popupPage.closePage();
    await Promise.resolve();
    expect(events).toEqual([]);

    releaseOpener?.();
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events).toEqual(["target-created", "target-closed"]);
    const state = browserContext as unknown as {
      announcements: Map<unknown, unknown>;
    };
    expect(state.announcements.size).toBe(0);
  });

  it("retains popup opener identity after the opener target closes", async () => {
    const { browserContext, nativeContext, firstPage } = createHarness();
    const [openerTarget] = await browserContext.targets();
    let releaseOpener: (() => void) | undefined;
    const openerGate = new Promise<void>((resolve) => {
      releaseOpener = resolve;
    });
    const createdEvents: Array<{ tabId: string; openerTabId?: string }> = [];
    browserContext.onEvent((event) => {
      if (event.type === "target-created") createdEvents.push(event);
    });

    const popupPage = nativeContext.popup(firstPage, openerGate);
    firstPage.closePage();
    releaseOpener?.();

    await vi.waitFor(() => expect(createdEvents).toHaveLength(1));
    const popupTarget = (await browserContext.targets()).find(
      (target) => target.playwrightPage === (popupPage as unknown as Page),
    );
    expect(createdEvents[0]).toMatchObject({
      tabId: popupTarget?.tabId,
      openerTabId: openerTarget.tabId,
    });
  });

  it("does not return a target when its Context closes during newPage", async () => {
    const { browserContext, nativeContext } = createHarness(
      { sessionId: "session-1" },
      new FakePage("about:blank", null, []),
      true,
    );
    let finishNewPage: (() => void) | undefined;
    const newPageGate = new Promise<void>((resolve) => {
      finishNewPage = resolve;
    });
    nativeContext.newPage.mockImplementationOnce(async (): Promise<Page> => {
      await newPageGate;
      const page = new FakePage("about:blank", null, nativeContext.installedScripts);
      nativeContext.addPage(page);
      return page as unknown as Page;
    });

    const creation = browserContext.createTarget();
    await vi.waitFor(() => expect(nativeContext.newPage).toHaveBeenCalledTimes(1));
    await browserContext.close();
    finishNewPage?.();

    await expect(creation).rejects.toMatchObject({ code: "CONTEXT_CLOSED" });
    await expect(browserContext.targets()).resolves.toEqual([]);
  });
});

describe("CloakBrowser backend lifecycle", () => {
  it("retains shutdown state and Context tracking until Runtime shutdown succeeds", async () => {
    const runtime = {
      start: vi.fn(),
      shutdown: vi
        .fn()
        .mockRejectedValueOnce(new Error("native close failed"))
        .mockResolvedValueOnce(undefined),
    } as unknown as CloakRuntime;
    const backend = new CloakBrowserBackend({ runtime });
    const internal = backend as unknown as {
      state: string;
      contexts: Map<string, unknown>;
    };
    internal.contexts.set("session-1", {});
    await backend.start();

    await expect(backend.shutdown()).rejects.toThrow("native close failed");
    expect(internal.state).toBe("shutting-down");
    expect(internal.contexts.has("session-1")).toBe(true);

    await expect(backend.shutdown()).resolves.toBeUndefined();
    expect(runtime.shutdown).toHaveBeenCalledTimes(2);
    expect(internal.state).toBe("stopped");
    expect(internal.contexts.size).toBe(0);
  });
});
