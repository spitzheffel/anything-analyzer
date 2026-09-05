import { randomUUID } from "node:crypto";
import type {
  BrowserContext as PlaywrightBrowserContext,
  CDPSession,
  Disposable,
  Download,
  Frame,
  Page,
  Request,
} from "playwright-core";
import type { BrowserTabState } from "@shared/types";
import {
  BrowserBackendError,
  normalizeBrowserUrl,
  type BrowserBackend,
  type BrowserBindingCallback,
  type BrowserCapabilities,
  type BrowserClearDataOptions,
  type BrowserContext,
  type BrowserContextEvent,
  type BrowserContextOptions,
  type BrowserDownloadEvent,
  type BrowserErrorCode,
  type BrowserTarget,
  type BrowserTargetEvent,
  type BrowserTargetState,
  type CdpLease,
  type CdpMessage,
  type CdpTransport,
  type Unsubscribe,
} from "./contracts";
import {
  CloakRuntime,
  type CloakRuntimeContext,
  type CloakRuntimeOptions,
} from "./cloak-runtime";

export const CLOAK_BROWSER_CAPABILITIES: Readonly<BrowserCapabilities> =
  Object.freeze({
    presentation: "external",
    captureModes: Object.freeze(["passive", "deep"] as const),
    persistentContexts: true,
    cdp: true,
    initScripts: true,
    pageBindings: true,
    screenshots: true,
    popupOpener: true,
    devtools: "none",
    downloads: "native",
    fileChooser: "native",
    proxyUpdate: "context-restart",
  });

export interface CloakBrowserBackendOptions extends CloakRuntimeOptions {
  runtime?: CloakRuntime;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emitSafely<T>(listeners: ReadonlySet<(event: T) => void>, event: T): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      console.error("Browser event listener failed", error);
    }
  }
}

function targetError(
  code: BrowserErrorCode,
  message: string,
  target: CloakBrowserTarget,
  cause?: unknown,
): BrowserBackendError {
  return new BrowserBackendError(code, message, {
    backendKind: "cloak",
    sessionId: target.sessionId,
    contextId: target.contextId,
    targetId: target.id,
    cause,
  });
}

function normalizeTargetUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed === "about:blank") return trimmed;
  return normalizeBrowserUrl(trimmed);
}

function restoredTabsFrom(options: BrowserContextOptions): BrowserTabState[] {
  const value = options.backendOptions?.restoredTabs;
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is BrowserTabState => {
      if (!item || typeof item !== "object") return false;
      const tab = item as Partial<BrowserTabState>;
      return (
        typeof tab.id === "string" &&
        tab.id.length > 0 &&
        typeof tab.url === "string" &&
        typeof tab.position === "number" &&
        typeof tab.active === "boolean"
      );
    })
    .sort((left, right) => left.position - right.position);
}

interface CloakBindingRegistration {
  readonly name: string;
  readonly attachName: string;
  readonly source: string;
}

interface CloakTargetBindingChannel {
  readonly lease: CdpLease;
  readonly unsubscribeMessage: Unsubscribe;
  readonly unsubscribeDisconnect: Unsubscribe;
}

function createBindingRegistration(name: string): CloakBindingRegistration {
  const suffix = randomUUID().replaceAll("-", "");
  const attachName = `__aaAttachBinding${suffix}`;
  const serializedName = JSON.stringify(name);
  const serializedAttachName = JSON.stringify(attachName);
  const source = `
    (() => {
      const bindingName = ${serializedName};
      const attachName = ${serializedAttachName};
      if (typeof globalThis[attachName] === "function") return;
      const queue = [];
      let activeRawName = null;
      const send = (...args) => {
        let payload;
        try {
          payload = JSON.stringify({ args });
        } catch {
          return undefined;
        }
        const rawBinding = activeRawName && globalThis[activeRawName];
        if (typeof rawBinding === "function") {
          try {
            rawBinding(payload);
            return undefined;
          } catch {
            // Cloak removes CDP bindings while committing a new document.
          }
        }
        if (queue.length < 1000) queue.push(payload);
        return undefined;
      };
      Object.defineProperty(globalThis, bindingName, {
        value: send,
        configurable: false,
        enumerable: false,
        writable: false
      });
      Object.defineProperty(globalThis, attachName, {
        value: (nextRawName) => {
          if (nextRawName === null) {
            activeRawName = null;
            return true;
          }
          if (typeof nextRawName !== "string") return false;
          const rawBinding = globalThis[nextRawName];
          if (typeof rawBinding !== "function") return false;
          activeRawName = nextRawName;
          while (queue.length) {
            try {
              rawBinding(queue[0]);
              queue.shift();
            } catch {
              return false;
            }
          }
          return true;
        },
        configurable: false,
        enumerable: false,
        writable: false
      });
    })();
  `;
  return { name, attachName, source };
}

function createRawBindingName(): string {
  return `__aaCdpBinding${randomUUID().replaceAll("-", "")}`;
}

export class CloakCdpTransport implements CdpTransport {
  readonly targetId: string;

  private session: CDPSession | null = null;
  private sessionCloseHandler: (() => void) | null = null;
  private connectPromise: Promise<void> | null = null;
  private detachPromise: Promise<void> | null = null;
  private forceClosePromise: Promise<void> | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private compatibilityHold = false;
  private forceClosed = false;
  private pendingAcquires = 0;
  private readonly leases = new Set<CloakCdpLease>();
  private readonly compatibilityDomains = new Set<CdpDomain>();
  private readonly sessionEventHandlers = new Map<
    string,
    (params: Record<string, unknown>) => void
  >();
  private messageListeners = new Set<(message: CdpMessage) => void>();
  private disconnectListeners = new Set<(reason?: string) => void>();

  constructor(private readonly target: CloakBrowserTarget) {
    this.targetId = target.id;
  }

  get connected(): boolean {
    return this.session !== null && !this.forceClosed;
  }

  get sessionId(): string {
    return this.target.sessionId;
  }

  async acquire(owner: string): Promise<CdpLease> {
    const normalizedOwner = owner.trim();
    if (!normalizedOwner) {
      throw targetError(
        "INVALID_ARGUMENT",
        "A CDP lease owner name is required",
        this.target,
      );
    }
    this.pendingAcquires += 1;
    try {
      await this.ensureConnected();
      if (!this.connected) {
        throw targetError("CDP_DETACHED", "CDP session detached during acquire", this.target);
      }
      const lease = new CloakCdpLease(this, normalizedOwner);
      this.leases.add(lease);
      return lease;
    } finally {
      this.pendingAcquires -= 1;
    }
  }

  async connect(): Promise<void> {
    this.compatibilityHold = true;
    try {
      await this.ensureConnected();
    } catch (error) {
      this.compatibilityHold = false;
      throw error;
    }
  }

  async send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    return this.enqueueOperation(async () => {
      await this.ensureConnected();
      return this.sendForOwner<T>(null, method, params);
    });
  }

  onMessage(listener: (message: CdpMessage) => void): Unsubscribe {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onDisconnect(listener: (reason?: string) => void): Unsubscribe {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.leases.size > 0 || this.pendingAcquires > 0) {
      throw targetError(
        "CDP_IN_USE",
        `Cannot close CDP while ${this.leases.size} lease(s) and ${this.pendingAcquires} acquire(s) are active`,
        this.target,
      );
    }
    this.compatibilityHold = false;
    if (this.connectPromise) await this.connectPromise.catch(() => undefined);
    await this.operationTail.catch(() => undefined);
    await this.detach("CDP session closed");
  }

  async forceClose(): Promise<void> {
    if (this.forceClosePromise) return this.forceClosePromise;
    if (this.forceClosed) return;
    this.forceClosed = true;
    this.compatibilityHold = false;
    for (const lease of [...this.leases]) {
      lease.forceRelease("CDP transport was force-closed");
    }
    this.leases.clear();
    const pendingConnection = this.connectPromise;
    const pendingOperations = this.operationTail;
    this.forceClosePromise = (async () => {
      if (pendingConnection) await pendingConnection.catch(() => undefined);
      await pendingOperations.catch(() => undefined);
      await this.detach("CDP transport was force-closed");
      this.messageListeners.clear();
      this.disconnectListeners.clear();
    })();
    return this.forceClosePromise;
  }

  async sendForLease<T = Record<string, unknown>>(
    lease: CloakCdpLease,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    if (!this.leases.has(lease) || !lease.acceptsCommands()) {
      throw targetError("CDP_DETACHED", "CDP lease has been released", this.target);
    }
    return this.enqueueOperation(() => this.sendForOwner<T>(lease, method, params));
  }

  async releaseLease(lease: CloakCdpLease): Promise<void> {
    await this.enqueueOperation(() => this.releaseLeaseNow(lease));
  }

  private async releaseLeaseNow(lease: CloakCdpLease): Promise<void> {
    if (!this.leases.has(lease)) return;
    const session = this.session;
    for (const domain of lease.claimedDomains()) {
      const hasOtherClaim = [...this.leases].some(
        (candidate) =>
          candidate !== lease &&
          !candidate.released &&
          candidate.hasDomain(domain),
      );
      if (!hasOtherClaim && !this.compatibilityDomains.has(domain) && session) {
        try {
          const send = session.send as unknown as (
            command: string,
            parameters?: Record<string, unknown>,
          ) => Promise<unknown>;
          await send.call(session, `${domain}.disable`, {});
        } catch (error) {
          if (!this.target.isClosed() && !this.forceClosed) {
            throw targetError(
              "CDP_UNAVAILABLE",
              `Failed to release ${domain} domain: ${errorMessage(error)}`,
              this.target,
              error,
            );
          }
        }
      }
      lease.removeDomain(domain);
    }

    const isLastLease = this.leases.size === 1;
    if (
      isLastLease &&
      this.pendingAcquires === 0 &&
      !this.compatibilityHold
    ) {
      await this.detach("Last CDP lease released");
    }
    this.leases.delete(lease);
    lease.clearDomains();
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async ensureConnected(): Promise<void> {
    if (this.detachPromise) {
      await this.detachPromise;
      return this.ensureConnected();
    }
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;
    if (this.forceClosed) {
      throw targetError(
        "CDP_DETACHED",
        "CDP transport has been permanently closed",
        this.target,
      );
    }
    if (this.target.isClosed()) {
      throw targetError("TARGET_CLOSED", "Cannot attach CDP to a closed target", this.target);
    }

    this.connectPromise = (async () => {
      let session: CDPSession | null = null;
      try {
        session = await this.target.playwrightContext.newCDPSession(
          this.target.playwrightPage,
        );
        if (this.target.isClosed() || this.forceClosed) {
          await session.detach().catch(() => undefined);
          throw targetError(
            this.target.isClosed() ? "TARGET_CLOSED" : "CDP_DETACHED",
            this.target.isClosed()
              ? "Target closed while its CDP session was attaching"
              : "CDP transport closed while its session was attaching",
            this.target,
          );
        }

        this.session = session;
        this.subscribeProtocolEvents(session);
        const closeHandler = (): void => this.handleSessionClose(session!);
        this.sessionCloseHandler = closeHandler;
        session.once("close", closeHandler);
      } catch (error) {
        if (session) {
          this.unsubscribeProtocolEvents(session);
          if (this.sessionCloseHandler) {
            session.off("close", this.sessionCloseHandler);
          }
          await session.detach().catch(() => undefined);
        }
        this.session = null;
        this.sessionCloseHandler = null;
        if (error instanceof BrowserBackendError) throw error;
        throw targetError(
          "CDP_UNAVAILABLE",
          `Failed to attach passive CDP: ${errorMessage(error)}`,
          this.target,
          error,
        );
      } finally {
        this.connectPromise = null;
      }
    })();
    return this.connectPromise;
  }

  private async sendForOwner<T = Record<string, unknown>>(
    lease: CloakCdpLease | null,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const session = this.session;
    if (!session || this.forceClosed) {
      throw targetError("CDP_DETACHED", "CDP session is not connected", this.target);
    }

    const domainCommand = parseDomainCommand(method);
    if (domainCommand?.action === "disable") {
      const conflictingOwners = new Set(
        [...this.leases]
          .filter(
            (candidate) =>
              candidate !== lease &&
              !candidate.released &&
              candidate.hasDomain(domainCommand.domain) &&
              candidate.owner !== lease?.owner,
          )
          .map((candidate) => candidate.owner),
      );
      if (
        lease !== null &&
        this.compatibilityDomains.has(domainCommand.domain)
      ) {
        conflictingOwners.add("compatibility");
      }
      if (lease === null) {
        for (const candidate of this.leases) {
          if (!candidate.released && candidate.hasDomain(domainCommand.domain)) {
            conflictingOwners.add(candidate.owner);
          }
        }
      }
      if (conflictingOwners.size) {
        throw targetError(
          "CDP_DOMAIN_CONFLICT",
          `${domainCommand.domain}.disable conflicts with active owner(s): ${[
            ...conflictingOwners,
          ].join(", ")}`,
          this.target,
        );
      }
    }

    try {
      const send = session.send as unknown as (
        command: string,
        parameters?: Record<string, unknown>,
      ) => Promise<unknown>;
      const result = (await send.call(session, method, params)) as T;
      if (domainCommand?.action === "enable") {
        if (lease) lease.addDomain(domainCommand.domain);
        else this.compatibilityDomains.add(domainCommand.domain);
      } else if (domainCommand?.action === "disable") {
        if (lease) {
          for (const candidate of this.leases) {
            if (candidate.owner === lease.owner) {
              candidate.removeDomain(domainCommand.domain);
            }
          }
        } else {
          this.compatibilityDomains.delete(domainCommand.domain);
        }
      }
      return result;
    } catch (error) {
      if (this.target.isClosed()) {
        throw targetError("TARGET_CLOSED", "Target closed during CDP command", this.target, error);
      }
      throw targetError(
        "CDP_UNAVAILABLE",
        `CDP command ${method} failed: ${errorMessage(error)}`,
        this.target,
        error,
      );
    }
  }

  private async detach(reason: string): Promise<void> {
    if (this.detachPromise) return this.detachPromise;
    const session = this.session;
    if (!session) return;

    const closeHandler = this.sessionCloseHandler;
    if (closeHandler) session.off("close", closeHandler);
    const detachPromise = (async () => {
      try {
        await session.detach();
      } catch (error) {
        if (!this.target.isClosed() && !this.forceClosed) {
          if (this.session === session && closeHandler) {
            session.once("close", closeHandler);
          }
          throw targetError(
            "CDP_UNAVAILABLE",
            `Failed to detach CDP session: ${errorMessage(error)}`,
            this.target,
            error,
          );
        }
        // Closing the target or transport can detach before Playwright observes it.
      }

      if (this.session === session) {
        this.unsubscribeProtocolEvents(session);
        this.session = null;
        this.sessionCloseHandler = null;
        this.clearDomains();
        this.emitDisconnect(reason);
      }
    })().finally(() => {
      if (this.detachPromise === detachPromise) this.detachPromise = null;
    });
    this.detachPromise = detachPromise;
    return detachPromise;
  }

  private subscribeProtocolEvents(session: CDPSession): void {
    const emitter = session as unknown as {
      on(event: string, listener: (params: Record<string, unknown>) => void): void;
    };
    for (const method of FORWARDED_CDP_EVENTS) {
      const handler = (params: Record<string, unknown>): void => {
        this.handleProtocolEvent(method, params);
      };
      this.sessionEventHandlers.set(method, handler);
      emitter.on(method, handler);
    }
  }

  private unsubscribeProtocolEvents(session: CDPSession): void {
    const emitter = session as unknown as {
      off(event: string, listener: (params: Record<string, unknown>) => void): void;
    };
    for (const [method, handler] of this.sessionEventHandlers) {
      emitter.off(method, handler);
    }
    this.sessionEventHandlers.clear();
  }

  private handleProtocolEvent(
    method: string,
    params: Record<string, unknown> = {},
  ): void {
    emitSafely(this.messageListeners, {
      method,
      params,
      sessionId: this.target.sessionId,
    });
    for (const lease of this.leases) lease.emitMessage(method, params);
  }

  private handleSessionClose(session: CDPSession): void {
    if (this.session !== session) return;
    this.unsubscribeProtocolEvents(session);
    this.session = null;
    this.sessionCloseHandler = null;
    this.clearDomains();
    this.emitDisconnect("CDP session detached");
  }

  private emitDisconnect(reason: string): void {
    for (const listener of this.disconnectListeners) {
      try {
        listener(reason);
      } catch (error) {
        console.error("CDP disconnect listener failed", error);
      }
    }
    for (const lease of this.leases) lease.emitDisconnect(reason);
  }

  private clearDomains(): void {
    this.compatibilityDomains.clear();
    for (const lease of this.leases) lease.clearDomains();
  }
}

type CdpDomain = "Fetch" | "Network" | "Page" | "Runtime";

// Playwright CDPSession emits protocol method names directly; it does not emit
// a generic "event" notification. Keep this list aligned with consumers of the
// browser-neutral CDP transport.
const FORWARDED_CDP_EVENTS = [
  "Fetch.requestPaused",
  "Network.requestWillBeSent",
  "Network.responseReceived",
  "Network.loadingFinished",
  "Network.loadingFailed",
  "Network.webSocketCreated",
  "Network.webSocketFrameSent",
  "Network.webSocketFrameReceived",
  "Network.webSocketClosed",
  "Page.frameNavigated",
  "Runtime.bindingCalled",
] as const;

function parseDomainCommand(
  method: string,
): { domain: CdpDomain; action: "enable" | "disable" } | null {
  const match = /^(Fetch|Network|Page|Runtime)\.(enable|disable)$/.exec(method);
  if (!match) return null;
  return {
    domain: match[1] as CdpDomain,
    action: match[2] as "enable" | "disable",
  };
}

class CloakCdpLease implements CdpLease {
  readonly targetId: string;
  private state: "active" | "releasing" | "released" = "active";
  private releasePromise: Promise<void> | null = null;
  private readonly domains = new Set<CdpDomain>();
  private readonly messageListeners = new Set<(message: CdpMessage) => void>();
  private readonly disconnectListeners = new Set<(reason?: string) => void>();

  constructor(
    private readonly transport: CloakCdpTransport,
    readonly owner: string,
  ) {
    this.targetId = transport.targetId;
  }

  get connected(): boolean {
    return this.state === "active" && this.transport.connected;
  }

  get released(): boolean {
    return this.state === "released";
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    return this.transport.sendForLease<T>(this, method, params);
  }

  onMessage(listener: (message: CdpMessage) => void): Unsubscribe {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onDisconnect(listener: (reason?: string) => void): Unsubscribe {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  async release(): Promise<void> {
    if (this.state === "released") return;
    if (this.releasePromise) return this.releasePromise;
    this.state = "releasing";
    const attempt = this.transport.releaseLease(this);
    this.releasePromise = attempt;
    try {
      await attempt;
      this.state = "released";
      this.messageListeners.clear();
      this.disconnectListeners.clear();
    } catch (error) {
      this.state = "active";
      throw error;
    } finally {
      if (this.releasePromise === attempt) this.releasePromise = null;
    }
  }

  acceptsCommands(): boolean {
    return this.state === "active";
  }

  addDomain(domain: CdpDomain): void {
    this.domains.add(domain);
  }

  removeDomain(domain: CdpDomain): void {
    this.domains.delete(domain);
  }

  hasDomain(domain: CdpDomain): boolean {
    return this.domains.has(domain);
  }

  claimedDomains(): readonly CdpDomain[] {
    return [...this.domains];
  }

  clearDomains(): void {
    this.domains.clear();
  }

  emitMessage(method: string, params: Record<string, unknown>): void {
    if (this.state === "released") return;
    emitSafely(this.messageListeners, {
      method,
      params,
      sessionId: this.transport.sessionId,
    });
  }

  emitDisconnect(reason: string): void {
    if (this.state === "released") return;
    for (const listener of this.disconnectListeners) {
      try {
        listener(reason);
      } catch (error) {
        console.error("CDP lease disconnect listener failed", error);
      }
    }
  }

  forceRelease(reason: string): void {
    if (this.state === "released") return;
    this.emitDisconnect(reason);
    this.state = "released";
    this.releasePromise = null;
    this.clearDomains();
    this.messageListeners.clear();
    this.disconnectListeners.clear();
  }
}

export class CloakBrowserTarget implements BrowserTarget {
  readonly backendKind = "cloak" as const;
  readonly sessionId: string;
  readonly contextId: string;

  private targetTabId: string;
  private currentUrl: string;
  private currentTitle = "";
  private loading = false;
  private crashed = false;
  private closed = false;
  private refreshSequence = 0;
  private cdpTransport: CloakCdpTransport | null = null;
  private listeners = new Set<(event: BrowserTargetEvent) => void>();

  constructor(
    private readonly owner: CloakBrowserContext,
    readonly playwrightPage: Page,
    tabId: string = randomUUID(),
  ) {
    this.targetTabId = tabId;
    this.sessionId = owner.sessionId;
    this.contextId = owner.id;
    this.currentUrl = playwrightPage.url();

    playwrightPage.on("request", this.handleRequest);
    playwrightPage.on("requestfailed", this.handleRequestFailed);
    playwrightPage.on("framenavigated", this.handleFrameNavigated);
    playwrightPage.on("domcontentloaded", this.handleDomContentLoaded);
    playwrightPage.on("load", this.handleLoad);
    playwrightPage.on("download", this.handleDownload);
    playwrightPage.once("crash", this.handleCrash);
    playwrightPage.once("close", this.handleClose);
    void this.refreshState(false);
  }

  get playwrightContext(): PlaywrightBrowserContext {
    return this.owner.playwrightContext;
  }

  get id(): string {
    return this.targetTabId;
  }

  get tabId(): string {
    return this.targetTabId;
  }

  adoptTabId(tabId: string): void {
    this.targetTabId = tabId;
  }

  get url(): string {
    if (!this.isClosed()) this.currentUrl = this.playwrightPage.url();
    return this.currentUrl;
  }

  get title(): string {
    return this.currentTitle;
  }

  isClosed(): boolean {
    return this.closed || this.crashed || this.playwrightPage.isClosed();
  }

  getState(): BrowserTargetState {
    return {
      id: this.id,
      tabId: this.tabId,
      sessionId: this.sessionId,
      contextId: this.contextId,
      url: this.url,
      title: this.currentTitle,
      isActive: this.owner.isActiveTarget(this.tabId),
      isLoading: this.loading,
    };
  }

  async navigate(url: string): Promise<void> {
    this.assertOpen();
    const normalized = normalizeTargetUrl(url);
    this.setLoading(true, normalized);
    this.owner.touch();
    try {
      await this.playwrightPage.goto(normalized, { waitUntil: "domcontentloaded" });
      await this.refreshState(false);
    } catch (error) {
      this.setLoading(false);
      throw targetError(
        "NAVIGATION_FAILED",
        `Navigation to ${normalized} failed: ${errorMessage(error)}`,
        this,
        error,
      );
    }
  }

  async goBack(): Promise<void> {
    this.assertOpen();
    this.setLoading(true);
    this.owner.touch();
    try {
      await this.playwrightPage.goBack({ waitUntil: "domcontentloaded" });
      await this.refreshState(false);
    } catch (error) {
      this.setLoading(false);
      throw targetError(
        "NAVIGATION_FAILED",
        `Back navigation failed: ${errorMessage(error)}`,
        this,
        error,
      );
    }
  }

  async goForward(): Promise<void> {
    this.assertOpen();
    this.setLoading(true);
    this.owner.touch();
    try {
      await this.playwrightPage.goForward({ waitUntil: "domcontentloaded" });
      await this.refreshState(false);
    } catch (error) {
      this.setLoading(false);
      throw targetError(
        "NAVIGATION_FAILED",
        `Forward navigation failed: ${errorMessage(error)}`,
        this,
        error,
      );
    }
  }

  async reload(): Promise<void> {
    this.assertOpen();
    this.setLoading(true);
    this.owner.touch();
    try {
      await this.playwrightPage.reload({ waitUntil: "domcontentloaded" });
      await this.refreshState(false);
    } catch (error) {
      this.setLoading(false);
      throw targetError(
        "NAVIGATION_FAILED",
        `Reload failed: ${errorMessage(error)}`,
        this,
        error,
      );
    }
  }

  async activate(): Promise<void> {
    this.assertOpen();
    await this.owner.activateNativeTarget(this);
  }

  async close(): Promise<void> {
    if (this.isClosed()) return;
    try {
      await this.playwrightPage.close({ runBeforeUnload: false });
    } catch (error) {
      if (!this.playwrightPage.isClosed()) {
        throw targetError(
          "BACKEND_FAILURE",
          `Failed to close target: ${errorMessage(error)}`,
          this,
          error,
        );
      }
    }
  }

  async evaluate<T = unknown>(source: string): Promise<T> {
    this.assertOpen();
    this.owner.touch();
    return this.playwrightPage.evaluate(source) as Promise<T>;
  }

  async addInitScript(source: string): Promise<string | null> {
    this.assertOpen();
    return this.owner.addTargetInitScript(source);
  }

  async exposeBinding(
    name: string,
    callback: BrowserBindingCallback,
  ): Promise<void> {
    this.assertOpen();
    await this.owner.exposeTargetBinding(this, name, callback);
  }

  async captureScreenshot(): Promise<Buffer> {
    this.assertOpen();
    return this.playwrightPage.screenshot({ type: "png" });
  }

  async getCdpTransport(): Promise<CdpTransport> {
    this.assertOpen();
    if (!this.cdpTransport) this.cdpTransport = new CloakCdpTransport(this);
    return this.cdpTransport;
  }

  onEvent(listener: (event: BrowserTargetEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getNativeHandle<T = unknown>(): T {
    return this.playwrightPage as T;
  }

  emitStateChanged(): void {
    if (this.closed) return;
    this.emit({
      type: "target-updated",
      sessionId: this.sessionId,
      contextId: this.contextId,
      tabId: this.tabId,
      target: this.getState(),
    });
  }

  private assertOpen(): void {
    if (this.isClosed()) {
      throw targetError("TARGET_CLOSED", "Cloak browser target is closed", this);
    }
  }

  private setLoading(loading: boolean, url?: string): void {
    if (url) this.currentUrl = url;
    if (this.loading === loading && !url) return;
    this.loading = loading;
    this.emitStateChanged();
  }

  private async refreshState(loading = this.loading): Promise<void> {
    if (this.isClosed()) return;
    const sequence = ++this.refreshSequence;
    const url = this.playwrightPage.url();
    let title = this.currentTitle;
    try {
      title = await this.playwrightPage.title();
    } catch {
      if (this.isClosed()) return;
    }
    if (this.isClosed() || sequence !== this.refreshSequence) return;

    const changed =
      url !== this.currentUrl ||
      title !== this.currentTitle ||
      loading !== this.loading;
    this.currentUrl = url;
    this.currentTitle = title;
    this.loading = loading;
    if (changed) this.emitStateChanged();
  }

  private emit(event: BrowserTargetEvent): void {
    emitSafely(this.listeners, event);
    this.owner.handleTargetEvent(this, event);
  }

  private readonly handleRequest = (request: Request): void => {
    try {
      if (
        request.isNavigationRequest() &&
        request.frame() === this.playwrightPage.mainFrame()
      ) {
        this.setLoading(true, request.url());
      }
    } catch {
      // A service-worker request may not have an inspectable frame.
    }
  };

  private readonly handleRequestFailed = (request: Request): void => {
    try {
      if (
        request.isNavigationRequest() &&
        request.frame() === this.playwrightPage.mainFrame()
      ) {
        void this.refreshState(false);
      }
    } catch {
      // Target may already have closed.
    }
  };

  private readonly handleFrameNavigated = (frame: Frame): void => {
    if (frame === this.playwrightPage.mainFrame()) {
      this.currentUrl = frame.url();
      void this.refreshState(this.loading);
    }
  };

  private readonly handleDomContentLoaded = (): void => {
    void this.owner.refreshTargetBindings(this).catch((error) => {
      if (!this.isClosed()) {
        console.warn(
          `Failed to refresh Cloak bindings for target ${this.tabId}`,
          error,
        );
      }
    });
    void this.refreshState(false);
  };

  private readonly handleLoad = (): void => {
    void this.refreshState(false);
  };

  private readonly handleDownload = (download: Download): void => {
    this.owner.handleDownload(this, download);
  };

  private readonly handleCrash = (): void => {
    if (this.crashed || this.closed) return;
    this.crashed = true;
    this.loading = false;
    void this.cdpTransport?.forceClose();
    this.emit({
      type: "target-crashed",
      sessionId: this.sessionId,
      contextId: this.contextId,
      tabId: this.tabId,
      reason: "Chromium renderer process crashed",
    });
  };

  private readonly handleClose = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.currentUrl = this.playwrightPage.url();
    this.loading = false;
    void this.cdpTransport?.forceClose();
    const event: BrowserTargetEvent = {
      type: "target-closed",
      sessionId: this.sessionId,
      contextId: this.contextId,
      tabId: this.tabId,
    };
    emitSafely(this.listeners, event);
    this.owner.handleTargetClosed(this, event);
    this.listeners.clear();
  };
}

export class CloakBrowserContext implements BrowserContext {
  readonly id: string;
  readonly sessionId: string;
  readonly backendKind = "cloak" as const;
  readonly options: Readonly<BrowserContextOptions>;

  private readonly targetsById = new Map<string, CloakBrowserTarget>();
  private readonly targetsByPage = new Map<Page, CloakBrowserTarget>();
  private readonly tabIdsByPage = new WeakMap<Page, string>();
  private readonly announcements = new Map<CloakBrowserTarget, Promise<void>>();
  private readonly listeners = new Set<(event: BrowserContextEvent) => void>();
  private readonly initScriptInstallations = new Map<
    string,
    Promise<Disposable>
  >();
  private readonly bindingInstallations = new Map<
    string,
    Promise<Disposable>
  >();
  private readonly bindingRegistrations = new Map<
    string,
    CloakBindingRegistration
  >();
  private readonly bindingChannels = new Map<
    Page,
    Promise<CloakTargetBindingChannel>
  >();
  private readonly bindingRefreshes = new Map<Page, Promise<void>>();
  private readonly activeRawBindings = new Map<Page, Map<string, string>>();
  private readonly bindingNamesByRaw = new Map<Page, Map<string, string>>();
  private readonly bindingCallbacks = new Map<
    string,
    Map<Page, BrowserBindingCallback>
  >();
  private readonly pendingBindingCalls = new Map<
    string,
    Map<Page, unknown[][]>
  >();
  private nativePageCreationCount = 0;
  private nativePageCreationBarrier: Promise<void> | null = null;
  private resolveNativePageCreationBarrier: (() => void) | null = null;
  private activeTabId: string | null = null;
  private closed = false;

  constructor(
    private readonly runtimeContext: CloakRuntimeContext,
    options: BrowserContextOptions,
    private readonly didClose: (context: CloakBrowserContext) => void,
  ) {
    this.id = runtimeContext.id;
    this.sessionId = runtimeContext.sessionId;
    this.options = Object.freeze({
      ...options,
      backendOptions: options.backendOptions
        ? Object.freeze({ ...options.backendOptions })
        : undefined,
    });

    const restoredTabs = restoredTabsFrom(this.options);
    for (const [index, page] of this.playwrightContext.pages().entries()) {
      const target = this.wrapPage(page, false, restoredTabs[index]?.id);
      if (!this.activeTabId) this.activeTabId = target.tabId;
    }
    this.playwrightContext.on("page", this.handlePage);
    this.playwrightContext.once("close", this.handleClose);
  }

  get playwrightContext(): PlaywrightBrowserContext {
    return this.runtimeContext.nativeContext;
  }

  async initialize(): Promise<void> {
    const restoredTabs = restoredTabsFrom(this.options);
    if (restoredTabs.length === 0) {
      if (this.targetsById.size === 0) await this.createTarget();
      return;
    }

    // Only restore blank targets and stable IDs here. SessionManager installs
    // Deep bindings/init scripts before it restores URLs or the active target.
    for (const savedTab of restoredTabs.slice(this.targetsById.size)) {
      const finishPageCreation = this.beginNativePageCreation();
      let page: Page;
      try {
        page = await this.playwrightContext.newPage();
        this.assertUsableNewPage(page);
        const target = this.targetsByPage.get(page) ?? this.wrapPage(page, true);
        this.adoptTargetTabId(target, savedTab.id);
      } finally {
        finishPageCreation();
      }
    }
  }

  isClosed(): boolean {
    return this.closed || this.runtimeContext.isClosed();
  }

  async activate(): Promise<void> {
    this.assertOpen();
    let target = this.activeTabId ? this.targetsById.get(this.activeTabId) : null;
    if (!target || target.isClosed()) {
      target = [...this.targetsById.values()].find((item) => !item.isClosed());
    }
    if (!target) target = await this.createTarget();
    await this.activateNativeTarget(target);
  }

  async targets(): Promise<CloakBrowserTarget[]> {
    return [...this.targetsById.values()].filter((target) => !target.isClosed());
  }

  async listTargets(): Promise<CloakBrowserTarget[]> {
    return this.targets();
  }

  getTarget(tabId: string): CloakBrowserTarget | null {
    const target = this.targetsById.get(tabId);
    return target && !target.isClosed() ? target : null;
  }

  async createTarget(url?: string): Promise<CloakBrowserTarget> {
    this.assertOpen();
    const finishPageCreation = this.beginNativePageCreation();
    let target: CloakBrowserTarget;
    try {
      const page = await this.playwrightContext.newPage();
      this.assertUsableNewPage(page);
      target = this.targetsByPage.get(page) ?? this.wrapPage(page, true);
    } finally {
      finishPageCreation();
    }
    if (url) await target.navigate(url);
    this.touch();
    return target;
  }

  async activateTarget(tabId: string): Promise<CloakBrowserTarget> {
    const target = this.requireTarget(tabId);
    await this.activateNativeTarget(target);
    return target;
  }

  async closeTarget(tabId: string): Promise<void> {
    await this.requireTarget(tabId).close();
  }

  async clearData(options?: BrowserClearDataOptions): Promise<void> {
    this.assertOpen();
    const clearStorage = options?.storage ?? options === undefined;
    const clearCache = options?.cache ?? options === undefined;
    const activeTargets = [...this.targetsById.values()].filter(
      (target) => !target.isClosed(),
    );
    const needsCdp = (clearStorage || clearCache) && activeTargets.length > 0;
    const transport = needsCdp
      ? await activeTargets[0].getCdpTransport()
      : null;
    const lease = transport
      ? await transport.acquire(`cloak-clear-data:${this.id}`)
      : null;

    try {
      if (clearStorage) {
        await this.playwrightContext.clearCookies();
        await this.playwrightContext.clearPermissions();
        const origins = new Set<string>();
        for (const target of activeTargets) {
          try {
            const origin = new URL(target.url).origin;
            if (origin !== "null") origins.add(origin);
          } catch {
            // Non-origin URLs such as about:blank have no persistent web storage.
          }
        }
        if (lease) {
          await Promise.all(
            [...origins].map((origin) =>
              lease.send("Storage.clearDataForOrigin", {
                origin,
                storageTypes:
                  "cookies,local_storage,indexeddb,websql,service_workers,cache_storage,file_systems",
              }),
            ),
          );
        }
        await Promise.allSettled(
          this.playwrightContext
            .serviceWorkers()
            .map((worker) => worker.evaluate("self.registration.unregister()")),
        );
      }

      if (clearCache && lease) {
        await lease.send("Network.clearBrowserCache");
      }
    } finally {
      await lease?.release();
    }

    if (options?.reloadTargets) {
      await Promise.all(activeTargets.map((target) => target.reload()));
    }
    this.touch();
  }

  async close(): Promise<void> {
    if (this.isClosed()) return;
    await this.runtimeContext.close();
  }

  onEvent(listener: (event: BrowserContextEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getNativeHandle<T = unknown>(): T {
    return this.playwrightContext as T;
  }

  isActiveTarget(tabId: string): boolean {
    return this.activeTabId === tabId;
  }

  touch(): void {
    this.runtimeContext.touch();
  }

  async addTargetInitScript(source: string): Promise<string | null> {
    this.assertOpen();
    if (!source.trim()) {
      throw new BrowserBackendError("INVALID_ARGUMENT", "Init script cannot be empty", {
        backendKind: "cloak",
        sessionId: this.sessionId,
        contextId: this.id,
      });
    }
    let installation = this.initScriptInstallations.get(source);
    if (!installation) {
      installation = this.playwrightContext.addInitScript({ content: source });
      this.initScriptInstallations.set(source, installation);
      installation.catch(() => this.initScriptInstallations.delete(source));
    }
    await installation;
    return null;
  }

  async exposeTargetBinding(
    target: CloakBrowserTarget,
    name: string,
    callback: BrowserBindingCallback,
  ): Promise<void> {
    this.assertOpen();
    if (!name.trim()) {
      throw new BrowserBackendError("INVALID_ARGUMENT", "Binding name cannot be empty", {
        backendKind: "cloak",
        sessionId: this.sessionId,
        contextId: this.id,
        targetId: target.id,
      });
    }
    if (this.targetsById.get(target.tabId) !== target || target.isClosed()) {
      throw new BrowserBackendError("TARGET_NOT_FOUND", "Cloak target was not found", {
        backendKind: "cloak",
        sessionId: this.sessionId,
        contextId: this.id,
        targetId: target.id,
      });
    }

    let callbacks = this.bindingCallbacks.get(name);
    if (!callbacks) {
      callbacks = new Map();
      this.bindingCallbacks.set(name, callbacks);
    }
    callbacks.set(target.playwrightPage, callback);

    let registration = this.bindingRegistrations.get(name);
    let installation = this.bindingInstallations.get(name);
    if (!installation) {
      registration = createBindingRegistration(name);
      this.bindingRegistrations.set(name, registration);
      installation = this.playwrightContext.addInitScript({
        content: registration.source,
      });
      this.bindingInstallations.set(name, installation);
      installation.catch(() => {
        this.bindingInstallations.delete(name);
        this.bindingRegistrations.delete(name);
      });
    }
    let registrationInstalled = false;
    try {
      await installation;
      registrationInstalled = true;
      registration ??= this.bindingRegistrations.get(name);
      if (!registration) throw new Error(`Cloak binding ${name} was not registered`);
      await target.playwrightPage.evaluate(registration.source);
      await this.refreshTargetBindings(target);
      await this.deliverPendingBindingCalls(target, name, callback);
    } catch (error) {
      // Navigation can destroy the execution context between registration and
      // attachment. Keep the callback so the next document event can retry.
      if (!registrationInstalled || target.isClosed() || this.isClosed()) {
        callbacks.delete(target.playwrightPage);
        if (callbacks.size === 0) this.bindingCallbacks.delete(name);
      }
      throw error;
    }
  }

  async refreshTargetBindings(target: CloakBrowserTarget): Promise<void> {
    if (this.isClosed() || target.isClosed()) return;
    const page = target.playwrightPage;
    const previous = this.bindingRefreshes.get(page) ?? Promise.resolve();
    const refresh = previous
      .catch(() => undefined)
      .then(() => this.refreshTargetBindingsNow(target));
    this.bindingRefreshes.set(page, refresh);
    try {
      await refresh;
    } finally {
      if (this.bindingRefreshes.get(page) === refresh) {
        this.bindingRefreshes.delete(page);
      }
    }
  }

  private async refreshTargetBindingsNow(target: CloakBrowserTarget): Promise<void> {
    if (this.isClosed() || target.isClosed()) return;
    const registrations = [...this.bindingRegistrations.values()].filter(
      (registration) =>
        this.bindingCallbacks.get(registration.name)?.has(target.playwrightPage),
    );
    if (registrations.length === 0) return;

    const channel = await this.ensureTargetBindingChannel(target);
    const page = target.playwrightPage;
    let activeBindings = this.activeRawBindings.get(page);
    if (!activeBindings) {
      activeBindings = new Map();
      this.activeRawBindings.set(page, activeBindings);
    }
    let namesByRaw = this.bindingNamesByRaw.get(page);
    if (!namesByRaw) {
      namesByRaw = new Map();
      this.bindingNamesByRaw.set(page, namesByRaw);
    }

    for (const registration of registrations) {
      const previousRawName = activeBindings.get(registration.name) ?? null;
      const nextRawName = createRawBindingName();
      await channel.lease.send("Runtime.addBinding", {
        name: nextRawName,
      });
      namesByRaw.set(nextRawName, registration.name);
      const frames = target.playwrightPage.frames();
      try {
        const results = await Promise.allSettled(
          frames.map(async (frame) => {
            let attached = await frame.evaluate<boolean>(
              `globalThis[${JSON.stringify(registration.attachName)}]?.(${JSON.stringify(nextRawName)}) === true`,
            );
            if (!attached) {
              await frame.evaluate(registration.source);
              attached = await frame.evaluate<boolean>(
                `globalThis[${JSON.stringify(registration.attachName)}]?.(${JSON.stringify(nextRawName)}) === true`,
              );
            }
            return attached;
          }),
        );
        const failedFrameIndex = results.findIndex(
          (result, index) =>
            (result.status === "rejected" || !result.value) &&
            !frames[index].isDetached(),
        );
        if (failedFrameIndex >= 0) {
          const failedFrame = results[failedFrameIndex];
          throw targetError(
            "BACKEND_FAILURE",
            `Failed to attach Cloak binding ${registration.name}`,
            target,
            failedFrame.status === "rejected" ? failedFrame.reason : undefined,
          );
        }

        activeBindings.set(registration.name, nextRawName);
        if (previousRawName) {
          try {
            await channel.lease.send("Runtime.removeBinding", {
              name: previousRawName,
            });
            namesByRaw.delete(previousRawName);
          } catch (error) {
            if (!target.isClosed()) {
              console.warn(
                `Failed to retire an old Cloak binding ${registration.name}`,
                error,
              );
            }
          }
        }
      } catch (error) {
        await Promise.allSettled(
          frames.map((frame) =>
            frame.evaluate(
              `globalThis[${JSON.stringify(registration.attachName)}]?.(${previousRawName ? JSON.stringify(previousRawName) : "null"})`,
            ),
          ),
        );
        namesByRaw.delete(nextRawName);
        await channel.lease
          .send("Runtime.removeBinding", { name: nextRawName })
          .catch(() => undefined);
        throw error;
      }
    }
  }

  private async ensureTargetBindingChannel(
    target: CloakBrowserTarget,
  ): Promise<CloakTargetBindingChannel> {
    const page = target.playwrightPage;
    let channel = this.bindingChannels.get(page);
    if (!channel) {
      channel = (async () => {
        const transport = await target.getCdpTransport();
        const lease = await transport.acquire(`cloak-bindings:${this.id}:${target.tabId}`);
        try {
          await lease.send("Runtime.enable");
          const unsubscribeMessage = lease.onMessage((message) => {
            this.handleBindingMessage(target, message);
          });
          let unsubscribeDisconnect: Unsubscribe = () => undefined;
          unsubscribeDisconnect = lease.onDisconnect(() => {
            if (this.bindingChannels.get(page) !== channel) return;
            this.bindingChannels.delete(page);
            this.activeRawBindings.delete(page);
            this.bindingNamesByRaw.delete(page);
            unsubscribeMessage();
            unsubscribeDisconnect();
            void this.deactivateTargetBindings(target)
              .then(() => lease.release())
              .then(() => this.refreshTargetBindings(target))
              .catch((error) => {
                if (!this.isClosed() && !target.isClosed()) {
                  console.warn(
                    `Failed to recover Cloak bindings for target ${target.tabId}`,
                    error,
                  );
                }
              });
          });
          return { lease, unsubscribeMessage, unsubscribeDisconnect };
        } catch (error) {
          await lease.release().catch(() => undefined);
          throw error;
        }
      })();
      this.bindingChannels.set(page, channel);
      channel.catch(() => {
        if (this.bindingChannels.get(page) === channel) {
          this.bindingChannels.delete(page);
        }
      });
    }
    return channel;
  }

  private handleBindingMessage(target: CloakBrowserTarget, message: CdpMessage): void {
    if (message.method !== "Runtime.bindingCalled" || target.isClosed()) return;
    const rawName = message.params.name;
    const payload = message.params.payload;
    if (typeof rawName !== "string" || typeof payload !== "string") return;
    const bindingName = this.bindingNamesByRaw
      .get(target.playwrightPage)
      ?.get(rawName);
    const registration = bindingName
      ? this.bindingRegistrations.get(bindingName)
      : null;
    if (!registration) return;

    let args: unknown[];
    try {
      const parsed = JSON.parse(payload) as { args?: unknown };
      if (!Array.isArray(parsed.args)) return;
      args = parsed.args;
    } catch {
      return;
    }

    const callback = this.bindingCallbacks
      .get(registration.name)
      ?.get(target.playwrightPage);
    if (!callback) {
      let byPage = this.pendingBindingCalls.get(registration.name);
      if (!byPage) {
        byPage = new Map();
        this.pendingBindingCalls.set(registration.name, byPage);
      }
      const queued = byPage.get(target.playwrightPage) ?? [];
      if (queued.length < 1_000) queued.push(args);
      byPage.set(target.playwrightPage, queued);
      return;
    }
    void Promise.resolve(
      callback({
        sessionId: this.sessionId,
        contextId: this.id,
        tabId: target.tabId,
        name: registration.name,
        args,
      }),
    ).catch((error) => {
      console.warn(`Cloak binding ${registration.name} callback failed`, error);
    });
  }

  private async deliverPendingBindingCalls(
    target: CloakBrowserTarget,
    name: string,
    callback: BrowserBindingCallback,
  ): Promise<void> {
    const pendingByPage = this.pendingBindingCalls.get(name);
    const queued = pendingByPage?.get(target.playwrightPage);
    while (queued?.length) {
      const args = queued.shift()!;
      await callback({
        sessionId: this.sessionId,
        contextId: this.id,
        tabId: target.tabId,
        name,
        args,
      });
    }
    pendingByPage?.delete(target.playwrightPage);
    if (pendingByPage?.size === 0) this.pendingBindingCalls.delete(name);
  }

  private async releaseTargetBindingChannel(page: Page): Promise<void> {
    const refresh = this.bindingRefreshes.get(page);
    const channelPromise = this.bindingChannels.get(page);
    this.bindingChannels.delete(page);
    this.bindingRefreshes.delete(page);
    await refresh?.catch(() => undefined);
    if (!channelPromise) return;
    const channel = await channelPromise.catch(() => null);
    if (!channel) return;
    channel.unsubscribeMessage();
    channel.unsubscribeDisconnect();
    await channel.lease.release().catch(() => undefined);
  }

  private async deactivateTargetBindings(target: CloakBrowserTarget): Promise<void> {
    if (this.isClosed() || target.isClosed()) return;
    const registrations = [...this.bindingRegistrations.values()].filter(
      (registration) =>
        this.bindingCallbacks.get(registration.name)?.has(target.playwrightPage),
    );
    await Promise.allSettled(
      target.playwrightPage.frames().flatMap((frame) =>
        registrations.map((registration) =>
          frame.evaluate(
            `globalThis[${JSON.stringify(registration.attachName)}]?.(null)`,
          ),
        ),
      ),
    );
  }

  async activateNativeTarget(target: CloakBrowserTarget): Promise<void> {
    this.assertOpen();
    if (this.targetsById.get(target.tabId) !== target || target.isClosed()) {
      throw new BrowserBackendError("TARGET_NOT_FOUND", "Cloak target was not found", {
        backendKind: "cloak",
        sessionId: this.sessionId,
        contextId: this.id,
        targetId: target.id,
      });
    }

    const previous = this.activeTabId
      ? this.targetsById.get(this.activeTabId)
      : null;
    await target.playwrightPage.bringToFront();
    this.activeTabId = target.tabId;
    this.touch();
    this.afterAnnouncement(target, () => {
      this.emit({
        type: "target-activated",
        sessionId: this.sessionId,
        contextId: this.id,
        tabId: target.tabId,
      });
    });
    if (previous && previous !== target) previous.emitStateChanged();
    target.emitStateChanged();
  }

  handleTargetEvent(
    target: CloakBrowserTarget,
    event: BrowserTargetEvent,
  ): void {
    this.afterAnnouncement(target, () => {
      if (event.type === "target-updated") {
        this.emit({ ...event, target: event.target });
      } else if (event.type === "target-crashed") {
        this.emit(event);
      }
    });
  }

  handleTargetClosed(
    target: CloakBrowserTarget,
    event: BrowserTargetEvent & { type: "target-closed" },
  ): void {
    void this.releaseTargetBindingChannel(target.playwrightPage);
    this.targetsById.delete(target.tabId);
    this.targetsByPage.delete(target.playwrightPage);
    this.activeRawBindings.delete(target.playwrightPage);
    this.bindingNamesByRaw.delete(target.playwrightPage);
    for (const [name, callbacks] of this.bindingCallbacks) {
      callbacks.delete(target.playwrightPage);
      if (callbacks.size === 0) this.bindingCallbacks.delete(name);
    }
    for (const [name, queued] of this.pendingBindingCalls) {
      queued.delete(target.playwrightPage);
      if (queued.size === 0) this.pendingBindingCalls.delete(name);
    }
    this.afterAnnouncement(target, () => this.emit(event));
    this.announcements.delete(target);

    if (!this.closed && this.activeTabId === target.tabId) {
      const replacement = [...this.targetsById.values()].find(
        (candidate) => !candidate.isClosed(),
      );
      this.activeTabId = replacement?.tabId ?? null;
      if (replacement) {
        this.emit({
          type: "target-activated",
          sessionId: this.sessionId,
          contextId: this.id,
          tabId: replacement.tabId,
        });
        replacement.emitStateChanged();
      }
    }
  }

  handleDownload(target: CloakBrowserTarget, download: Download): void {
    const id = randomUUID();
    const base: BrowserDownloadEvent = {
      id,
      url: download.url(),
      suggestedFilename: download.suggestedFilename(),
      state: "started",
    };
    this.afterAnnouncement(target, () => this.emitDownload(target, base));

    void (async () => {
      try {
        const failure = await download.failure();
        if (failure) {
          this.afterAnnouncement(target, () => {
            this.emitDownload(target, {
              ...base,
              state: failure.toLowerCase().includes("cancel")
                ? "cancelled"
                : "failed",
              error: failure,
            });
          });
          return;
        }
        const savePath = await download.path();
        this.afterAnnouncement(target, () => {
          this.emitDownload(target, { ...base, state: "completed", savePath });
        });
      } catch (error) {
        this.afterAnnouncement(target, () => {
          this.emitDownload(target, {
            ...base,
            state: "failed",
            error: errorMessage(error),
          });
        });
      }
    })();
  }

  private assertOpen(): void {
    if (this.isClosed()) {
      throw new BrowserBackendError("CONTEXT_CLOSED", "Cloak context is closed", {
        backendKind: "cloak",
        sessionId: this.sessionId,
        contextId: this.id,
      });
    }
  }

  private assertUsableNewPage(page: Page): void {
    this.assertOpen();
    if (page.isClosed()) {
      throw new BrowserBackendError(
        "TARGET_CLOSED",
        "Cloak target closed while it was being created",
        {
          backendKind: "cloak",
          sessionId: this.sessionId,
          contextId: this.id,
        },
      );
    }
  }

  private beginNativePageCreation(): () => void {
    if (this.nativePageCreationCount === 0) {
      this.nativePageCreationBarrier = new Promise<void>((resolve) => {
        this.resolveNativePageCreationBarrier = resolve;
      });
    }
    this.nativePageCreationCount += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.nativePageCreationCount = Math.max(0, this.nativePageCreationCount - 1);
      if (this.nativePageCreationCount > 0) return;
      const resolve = this.resolveNativePageCreationBarrier;
      this.nativePageCreationBarrier = null;
      this.resolveNativePageCreationBarrier = null;
      resolve?.();
    };
  }

  private adoptTargetTabId(target: CloakBrowserTarget, preferredTabId: string): void {
    const requestedTabId = preferredTabId.trim();
    if (!requestedTabId || requestedTabId === target.tabId) return;
    const collision = this.targetsById.get(requestedTabId);
    if (collision && collision !== target) {
      throw new BrowserBackendError(
        "BACKEND_FAILURE",
        `Cannot restore duplicate Cloak tab ID ${requestedTabId}`,
        {
          backendKind: "cloak",
          sessionId: this.sessionId,
          contextId: this.id,
          targetId: requestedTabId,
        },
      );
    }

    const previousTabId = target.tabId;
    this.targetsById.delete(previousTabId);
    target.adoptTabId(requestedTabId);
    this.targetsById.set(requestedTabId, target);
    this.tabIdsByPage.set(target.playwrightPage, requestedTabId);
    if (this.activeTabId === previousTabId) this.activeTabId = requestedTabId;
  }

  private requireTarget(tabId: string): CloakBrowserTarget {
    this.assertOpen();
    const target = this.targetsById.get(tabId);
    if (!target || target.isClosed()) {
      throw new BrowserBackendError("TARGET_NOT_FOUND", `Target ${tabId} was not found`, {
        backendKind: "cloak",
        sessionId: this.sessionId,
        contextId: this.id,
        targetId: tabId,
      });
    }
    return target;
  }

  private wrapPage(
    page: Page,
    announce: boolean,
    preferredTabId?: string,
  ): CloakBrowserTarget {
    const existing = this.targetsByPage.get(page);
    if (existing) return existing;

    const requestedTabId = preferredTabId?.trim();
    const tabId =
      requestedTabId && !this.targetsById.has(requestedTabId)
        ? requestedTabId
        : randomUUID();
    const target = new CloakBrowserTarget(this, page, tabId);
    this.targetsByPage.set(page, target);
    this.targetsById.set(target.tabId, target);
    this.tabIdsByPage.set(page, target.tabId);
    if (!this.activeTabId) this.activeTabId = target.tabId;

    if (announce) {
      const creationBarrier = this.nativePageCreationBarrier;
      const announcement = (async () => {
        await creationBarrier;
        let openerTabId: string | undefined;
        try {
          const openerPage = await page.opener();
          if (openerPage) {
            openerTabId = this.tabIdsByPage.get(openerPage);
          }
        } catch {
          // The popup may close before Playwright resolves its opener.
        }
        this.emit({
          type: "target-created",
          sessionId: this.sessionId,
          contextId: this.id,
          tabId: target.tabId,
          target,
          ...(openerTabId ? { openerTabId } : {}),
        });
      })();
      this.announcements.set(target, announcement);
    }
    return target;
  }

  private afterAnnouncement(
    target: CloakBrowserTarget,
    callback: () => void,
  ): void {
    const announcement = this.announcements.get(target);
    if (!announcement) {
      callback();
      return;
    }
    void announcement.then(callback, callback);
  }

  private emitDownload(
    target: CloakBrowserTarget,
    download: BrowserDownloadEvent,
  ): void {
    this.emit({
      type: "download",
      sessionId: this.sessionId,
      contextId: this.id,
      tabId: target.tabId,
      download,
    });
  }

  private emit(event: BrowserContextEvent): void {
    emitSafely(this.listeners, event);
  }

  private readonly handlePage = (page: Page): void => {
    if (this.isClosed()) return;
    this.wrapPage(page, true);
  };

  private readonly handleClose = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.playwrightContext.off("page", this.handlePage);
    this.emit({
      type: "disconnected",
      sessionId: this.sessionId,
      contextId: this.id,
      tabId: null,
      reason: "Cloak browser context closed",
    });
    this.didClose(this);
    const bindingPages = [...this.bindingChannels.keys()];
    void Promise.allSettled(
      bindingPages.map((page) => this.releaseTargetBindingChannel(page)),
    );
    this.listeners.clear();
    this.targetsById.clear();
    this.targetsByPage.clear();
    this.announcements.clear();
    this.initScriptInstallations.clear();
    this.bindingInstallations.clear();
    this.bindingRegistrations.clear();
    this.bindingChannels.clear();
    this.bindingRefreshes.clear();
    this.activeRawBindings.clear();
    this.bindingNamesByRaw.clear();
    this.bindingCallbacks.clear();
    this.pendingBindingCalls.clear();
    this.nativePageCreationCount = 0;
    this.resolveNativePageCreationBarrier?.();
    this.nativePageCreationBarrier = null;
    this.resolveNativePageCreationBarrier = null;
    this.activeTabId = null;
  };
}

export class CloakBrowserBackend implements BrowserBackend {
  readonly kind = "cloak" as const;
  readonly capabilities = CLOAK_BROWSER_CAPABILITIES;

  private readonly runtime: CloakRuntime;
  private readonly contexts = new Map<string, CloakBrowserContext>();
  private state: "idle" | "started" | "shutting-down" | "stopped" = "idle";

  constructor(options: CloakBrowserBackendOptions = {}) {
    const { runtime, ...runtimeOptions } = options;
    this.runtime = runtime ?? new CloakRuntime(runtimeOptions);
  }

  async start(): Promise<void> {
    if (this.state === "shutting-down") {
      throw new BrowserBackendError(
        "BACKEND_SHUTTING_DOWN",
        "Cloak backend is shutting down",
        { backendKind: "cloak" },
      );
    }
    this.runtime.start();
    this.state = "started";
  }

  async openContext(options: BrowserContextOptions): Promise<BrowserContext> {
    this.assertStarted(options.sessionId);
    if (this.contexts.has(options.sessionId)) {
      throw new BrowserBackendError(
        "BACKEND_FAILURE",
        `A Cloak context already exists for session ${options.sessionId}`,
        { backendKind: "cloak", sessionId: options.sessionId },
      );
    }

    const runtimeContext = await this.runtime.openContext(options);
    try {
      const context = new CloakBrowserContext(
        runtimeContext,
        options,
        (closedContext) => {
          if (this.contexts.get(closedContext.sessionId) === closedContext) {
            this.contexts.delete(closedContext.sessionId);
          }
        },
      );
      await context.initialize();
      this.contexts.set(options.sessionId, context);
      return context;
    } catch (error) {
      await runtimeContext.close().catch(() => undefined);
      throw error;
    }
  }

  getContext(sessionId: string): BrowserContext | null {
    const context = this.contexts.get(sessionId);
    if (!context || context.isClosed()) {
      if (context) this.contexts.delete(sessionId);
      return null;
    }
    return context;
  }

  async closeContext(sessionId: string): Promise<void> {
    const context = this.contexts.get(sessionId);
    if (!context) return;
    await context.close();
  }

  async deletePersistentProfile(profileKey: string): Promise<void> {
    await this.runtime.deleteProfile(profileKey);
  }

  async shutdown(): Promise<void> {
    if (this.state === "idle" || this.state === "stopped") {
      this.state = "stopped";
      return;
    }
    this.state = "shutting-down";
    await this.runtime.shutdown();
    this.contexts.clear();
    this.state = "stopped";
  }

  getRuntime(): CloakRuntime {
    return this.runtime;
  }

  private assertStarted(sessionId: string): void {
    if (this.state === "shutting-down") {
      throw new BrowserBackendError(
        "BACKEND_SHUTTING_DOWN",
        "Cloak backend is shutting down",
        { backendKind: "cloak", sessionId },
      );
    }
    if (this.state !== "started") {
      throw new BrowserBackendError(
        "BACKEND_NOT_STARTED",
        "Cloak backend has not been started",
        { backendKind: "cloak", sessionId },
      );
    }
  }
}

export function createCloakBrowserBackend(
  options: CloakBrowserBackendOptions = {},
): CloakBrowserBackend {
  return new CloakBrowserBackend(options);
}
