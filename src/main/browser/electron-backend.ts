import { session as electronSession } from "electron";
import type {
  Event as ElectronEvent,
  Session as ElectronSession,
  RenderProcessGoneDetails,
  WebContents,
  WebContentsView,
} from "electron";
import { applyHttpSpoofing } from "../fingerprint/http-spoofing";
import type { TabManager } from "../tab-manager";
import type { WindowManager } from "../window";
import {
  BrowserBackendError,
  normalizeBrowserUrl,
  type BrowserBackend,
  type BrowserBindingCallback,
  type BrowserBounds,
  type BrowserCapabilities,
  type BrowserClearDataOptions,
  type BrowserContext,
  type BrowserContextEvent,
  type BrowserContextOptions,
  type BrowserTarget,
  type BrowserTargetEvent,
  type BrowserTargetState,
  type CdpLease,
  type CdpMessage,
  type CdpTransport,
  type Unsubscribe,
} from "./contracts";

interface ElectronTabRecord {
  id: string;
  view: WebContentsView;
  url: string;
  title: string;
  isLoading: boolean;
}

interface TabCreatedData {
  id: string;
  url: string;
  title: string;
  openerTabId?: string;
}

interface TabChangedData {
  tabId: string;
  url?: string;
  title?: string;
  isLoading?: boolean;
}

const ELECTRON_CAPABILITIES: Readonly<BrowserCapabilities> = Object.freeze({
  presentation: "embedded",
  captureModes: Object.freeze(["deep"] as const),
  persistentContexts: true,
  cdp: true,
  initScripts: true,
  pageBindings: false,
  screenshots: true,
  popupOpener: true,
  devtools: "native",
  downloads: "native",
  fileChooser: "native",
  proxyUpdate: "runtime",
});

const COMPAT_CDP_OWNER_ID = 0;
const PROTECTED_CDP_DOMAINS = new Set(["Fetch", "Network", "Page", "Runtime"]);

interface ElectronCdpLeaseRecord {
  owner: string;
  claimedDomains: Set<string>;
  lease: ElectronCdpLease;
}

export class ElectronCdpLease implements CdpLease {
  private state: "active" | "releasing" | "released" = "active";
  private releasePromise: Promise<void> | null = null;
  private readonly subscriptions = new Set<Unsubscribe>();

  constructor(
    readonly owner: string,
    readonly targetId: string,
    private readonly id: number,
    private readonly transport: ElectronCdpTransport,
  ) {}

  get connected(): boolean {
    return this.state === "active" && this.transport.connected;
  }

  get released(): boolean {
    return this.state === "released";
  }

  async send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.ensureActive();
    return this.transport.sendForLease<T>(this.id, method, params);
  }

  onMessage(listener: (message: CdpMessage) => void): Unsubscribe {
    this.ensureActive();
    return this.trackSubscription(
      this.transport.onMessage((message) => {
        if (this.state !== "released") listener(message);
      }),
    );
  }

  onDisconnect(listener: (reason?: string) => void): Unsubscribe {
    this.ensureActive();
    return this.trackSubscription(
      this.transport.onDisconnect((reason) => {
        if (this.state !== "released") listener(reason);
      }),
    );
  }

  async release(): Promise<void> {
    if (this.state === "released") return;
    if (this.releasePromise) return this.releasePromise;
    this.state = "releasing";
    const attempt = this.transport.releaseLease(this.id);
    this.releasePromise = attempt;
    try {
      await attempt;
      this.invalidate();
    } catch (error) {
      this.state = "active";
      throw error;
    } finally {
      if (this.releasePromise === attempt) this.releasePromise = null;
    }
  }

  invalidate(): void {
    if (this.state === "released") return;
    this.state = "released";
    this.releasePromise = null;
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions.clear();
  }

  private trackSubscription(unsubscribe: Unsubscribe): Unsubscribe {
    this.subscriptions.add(unsubscribe);
    return () => {
      if (!this.subscriptions.delete(unsubscribe)) return;
      unsubscribe();
    };
  }

  private ensureActive(): void {
    if (this.state !== "active") {
      throw new BrowserBackendError("CDP_DETACHED", "CDP lease has been released", {
        backendKind: "electron",
        targetId: this.targetId,
      });
    }
  }
}

/** A ref-counted, ownership-aware facade over Electron's one debugger attachment. */
export class ElectronCdpTransport implements CdpTransport {
  readonly targetId: string;

  private active = false;
  private ownsAttachment = false;
  private forceClosed = false;
  private compatibilityHold = false;
  private pendingAcquires = 0;
  private connectPromise: Promise<void> | null = null;
  private disconnectPromise: Promise<void> | null = null;
  private forceClosePromise: Promise<void> | null = null;
  private operationTail: Promise<void> = Promise.resolve();
  private listenersAttached = false;
  private nextLeaseId = 1;
  private readonly leases = new Map<number, ElectronCdpLeaseRecord>();
  private readonly domainClaims = new Map<string, Set<number>>();
  private readonly compatClaimedDomains = new Set<string>();
  private readonly messageListeners = new Set<(message: CdpMessage) => void>();
  private readonly disconnectListeners = new Set<(reason?: string) => void>();

  private readonly handleMessage = (
    _event: ElectronEvent,
    method: string,
    params: unknown,
    sessionId: string,
  ): void => {
    const message: CdpMessage = {
      method,
      params: isRecord(params) ? params : {},
      ...(sessionId ? { sessionId } : {}),
    };
    for (const listener of this.messageListeners) listener(message);
  };

  private readonly handleDetach = (
    _event: ElectronEvent,
    reason: string,
  ): void => {
    if (!this.active) return;
    this.active = false;
    this.ownsAttachment = false;
    this.clearDomainClaims();
    for (const listener of this.disconnectListeners) listener(reason);
  };

  constructor(
    targetId: string,
    private readonly getWebContents: () => WebContents,
  ) {
    this.targetId = targetId;
  }

  get connected(): boolean {
    if (!this.active || this.forceClosed) return false;
    try {
      const webContents = this.getWebContents();
      return !webContents.isDestroyed() && webContents.debugger.isAttached();
    } catch {
      return false;
    }
  }

  async acquire(owner: string): Promise<CdpLease> {
    const normalizedOwner = owner.trim();
    if (!normalizedOwner) {
      throw new BrowserBackendError("INVALID_ARGUMENT", "CDP lease owner cannot be empty", {
        backendKind: "electron",
        targetId: this.targetId,
      });
    }
    this.pendingAcquires += 1;
    try {
      this.ensureNotForceClosed();
      await this.ensureConnected();

      const id = this.nextLeaseId++;
      const lease = new ElectronCdpLease(
        normalizedOwner,
        this.targetId,
        id,
        this,
      );
      this.leases.set(id, {
        owner: normalizedOwner,
        claimedDomains: new Set(),
        lease,
      });
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
    this.compatibilityHold = true;
    return this.enqueueOperation(async () => {
      await this.ensureConnected();
      return this.sendCommand<T>(COMPAT_CDP_OWNER_ID, method, params);
    });
  }

  async sendForLease<T = Record<string, unknown>>(
    leaseId: number,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    if (!this.leases.has(leaseId)) {
      throw new BrowserBackendError("CDP_DETACHED", "CDP lease is no longer active", {
        backendKind: "electron",
        targetId: this.targetId,
      });
    }
    return this.enqueueOperation(() => this.sendCommand<T>(leaseId, method, params));
  }

  onMessage(listener: (message: CdpMessage) => void): Unsubscribe {
    this.ensureNotForceClosed();
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onDisconnect(listener: (reason?: string) => void): Unsubscribe {
    this.ensureNotForceClosed();
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  async releaseLease(leaseId: number): Promise<void> {
    await this.enqueueOperation(() => this.releaseLeaseNow(leaseId));
  }

  private async releaseLeaseNow(leaseId: number): Promise<void> {
    const record = this.leases.get(leaseId);
    if (!record) return;

    for (const domain of record.claimedDomains) {
      const otherClaims = this.domainClaims.get(domain);
      const hasOtherClaim = Boolean(
        otherClaims && [...otherClaims].some((claimantId) => claimantId !== leaseId),
      );
      if (!hasOtherClaim && !this.compatClaimedDomains.has(domain) && this.connected) {
        try {
          await this.sendNativeCommand(`${domain}.disable`, {});
        } catch (cause) {
          throw new BrowserBackendError(
            "CDP_UNAVAILABLE",
            `Unable to release ${domain} for Electron tab ${this.targetId}`,
            { backendKind: "electron", targetId: this.targetId, cause },
          );
        }
      }
    }

    const isLastLease = this.leases.size === 1;
    if (
      isLastLease &&
      this.pendingAcquires === 0 &&
      !this.compatibilityHold
    ) {
      await this.disconnect("last CDP lease released");
    }
    this.removeLeaseClaims(leaseId, record);
    this.leases.delete(leaseId);
    record.lease.invalidate();
  }

  async close(): Promise<void> {
    if (this.forceClosed) return;
    if (this.leases.size > 0 || this.pendingAcquires > 0) {
      const owners = [...new Set([...this.leases.values()].map(({ owner }) => owner))];
      throw new BrowserBackendError(
        "CDP_IN_USE",
        `Cannot close CDP while leased by: ${owners.join(", ") || "pending acquire"}`,
        { backendKind: "electron", targetId: this.targetId },
      );
    }
    this.compatibilityHold = false;
    if (this.connectPromise) await this.connectPromise.catch(() => undefined);
    await this.operationTail.catch(() => undefined);
    for (const domain of [...this.compatClaimedDomains]) {
      await this.sendCommand(COMPAT_CDP_OWNER_ID, `${domain}.disable`, {});
    }
    await this.disconnect("CDP transport closed");
  }

  async forceClose(): Promise<void> {
    if (this.forceClosePromise) return this.forceClosePromise;
    if (this.forceClosed) return;
    this.forceClosed = true;
    this.compatibilityHold = false;
    for (const { lease } of this.leases.values()) lease.invalidate();
    const pendingConnection = this.connectPromise;
    const pendingOperations = this.operationTail;
    this.forceClosePromise = (async () => {
      if (pendingConnection) await pendingConnection.catch(() => undefined);
      await pendingOperations.catch(() => undefined);
      await this.disconnect("CDP transport force-closed");
      this.leases.clear();
      this.clearDomainClaims();
      this.messageListeners.clear();
      this.disconnectListeners.clear();
    })();
    return this.forceClosePromise;
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
    if (this.disconnectPromise) {
      await this.disconnectPromise;
      return this.ensureConnected();
    }
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;
    this.ensureNotForceClosed();

    this.connectPromise = (async () => {
      await Promise.resolve();
      const webContents = this.getUsableWebContents();
      this.attachListeners(webContents);
      try {
        if (!webContents.debugger.isAttached()) {
          webContents.debugger.attach("1.3");
          this.ownsAttachment = true;
        } else {
          this.ownsAttachment = false;
        }
        if (this.forceClosed || webContents.isDestroyed()) {
          if (
            this.ownsAttachment &&
            !webContents.isDestroyed() &&
            webContents.debugger.isAttached()
          ) {
            webContents.debugger.detach();
          }
          throw new BrowserBackendError(
            webContents.isDestroyed() ? "TARGET_CLOSED" : "CDP_DETACHED",
            `CDP transport closed while attaching Electron tab ${this.targetId}`,
            { backendKind: "electron", targetId: this.targetId },
          );
        }
        this.active = true;
      } catch (cause) {
        this.active = false;
        this.ownsAttachment = false;
        this.removeListeners(webContents);
        if (cause instanceof BrowserBackendError) throw cause;
        throw new BrowserBackendError(
          "CDP_UNAVAILABLE",
          `Unable to attach CDP to Electron tab ${this.targetId}`,
          { backendKind: "electron", targetId: this.targetId, cause },
        );
      } finally {
        this.connectPromise = null;
      }
    })();
    return this.connectPromise;
  }

  private async sendNativeCommand<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const webContents = this.getUsableWebContents();
    return (await webContents.debugger.sendCommand(method, params)) as T;
  }

  private async sendCommand<T>(
    ownerId: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    if (!method.trim()) {
      throw new BrowserBackendError("INVALID_ARGUMENT", "CDP method cannot be empty", {
        backendKind: "electron",
        targetId: this.targetId,
      });
    }
    this.ensureNotForceClosed();
    const domainOperation = parseProtectedDomainOperation(method);
    if (domainOperation?.operation === "disable") {
      this.assertCanDisableDomain(domainOperation.domain, ownerId);
    }
    if (!this.connected) await this.ensureConnected();

    try {
      const result = await this.sendNativeCommand<T>(method, params);
      if (domainOperation?.operation === "enable") {
        this.addDomainClaim(domainOperation.domain, ownerId);
      } else if (domainOperation?.operation === "disable") {
        this.clearDomainClaimsForOwner(domainOperation.domain, ownerId);
      }
      return result;
    } catch (cause) {
      if (cause instanceof BrowserBackendError) throw cause;
      throw new BrowserBackendError(
        "CDP_UNAVAILABLE",
        `CDP command ${method} failed for Electron tab ${this.targetId}`,
        { backendKind: "electron", targetId: this.targetId, cause },
      );
    }
  }

  private assertCanDisableDomain(domain: string, ownerId: number): void {
    const claims = this.domainClaims.get(domain);
    if (!claims?.size) return;
    const owner = this.ownerName(ownerId);
    const conflictingOwners = new Set<string>();
    for (const claimantId of claims) {
      const claimantOwner = this.ownerName(claimantId);
      if (claimantOwner !== owner) conflictingOwners.add(claimantOwner);
    }
    if (conflictingOwners.size === 0) return;
    throw new BrowserBackendError(
      "CDP_DOMAIN_CONFLICT",
      `${domain}.disable would disrupt CDP owner(s): ${[...conflictingOwners].join(", ")}`,
      { backendKind: "electron", targetId: this.targetId },
    );
  }

  private addDomainClaim(domain: string, ownerId: number): void {
    let claims = this.domainClaims.get(domain);
    if (!claims) {
      claims = new Set();
      this.domainClaims.set(domain, claims);
    }
    claims.add(ownerId);
    if (ownerId === COMPAT_CDP_OWNER_ID) {
      this.compatClaimedDomains.add(domain);
    } else {
      this.leases.get(ownerId)?.claimedDomains.add(domain);
    }
  }

  private clearDomainClaimsForOwner(domain: string, ownerId: number): void {
    const owner = this.ownerName(ownerId);
    const claims = this.domainClaims.get(domain);
    if (!claims) return;
    for (const claimantId of [...claims]) {
      if (this.ownerName(claimantId) !== owner) continue;
      claims.delete(claimantId);
      if (claimantId === COMPAT_CDP_OWNER_ID) {
        this.compatClaimedDomains.delete(domain);
      } else {
        this.leases.get(claimantId)?.claimedDomains.delete(domain);
      }
    }
    if (claims.size === 0) this.domainClaims.delete(domain);
  }

  private removeLeaseClaims(
    leaseId: number,
    record: ElectronCdpLeaseRecord,
  ): void {
    for (const domain of record.claimedDomains) {
      const claims = this.domainClaims.get(domain);
      claims?.delete(leaseId);
      if (claims?.size === 0) this.domainClaims.delete(domain);
    }
    record.claimedDomains.clear();
  }

  private clearDomainClaims(): void {
    this.domainClaims.clear();
    this.compatClaimedDomains.clear();
    for (const record of this.leases.values()) record.claimedDomains.clear();
  }

  private ownerName(ownerId: number): string {
    return ownerId === COMPAT_CDP_OWNER_ID
      ? "compat"
      : this.leases.get(ownerId)?.owner ?? `released-lease-${ownerId}`;
  }

  private async disconnect(reason: string): Promise<void> {
    if (this.disconnectPromise) return this.disconnectPromise;
    const disconnectPromise = (async () => {
      await Promise.resolve();
      let webContents: WebContents | null = null;
      try {
        webContents = this.getWebContents();
      } catch {
        // The target may already have been destroyed.
      }

      const wasActive = this.active;
      const ownedAttachment = this.ownsAttachment;
      if (
        webContents &&
        ownedAttachment &&
        !webContents.isDestroyed() &&
        webContents.debugger.isAttached()
      ) {
        try {
          webContents.debugger.detach();
        } catch (cause) {
          if (!this.forceClosed && !webContents.isDestroyed()) {
            throw new BrowserBackendError(
              "CDP_UNAVAILABLE",
              `Unable to detach CDP from Electron tab ${this.targetId}`,
              { backendKind: "electron", targetId: this.targetId, cause },
            );
          }
        }
      }

      if (webContents) this.removeListeners(webContents);
      const detachEventAlreadyEmitted = wasActive && !this.active;
      this.active = false;
      this.ownsAttachment = false;
      this.clearDomainClaims();
      if (wasActive && !detachEventAlreadyEmitted) {
        for (const listener of this.disconnectListeners) listener(reason);
      }
    })().finally(() => {
      if (this.disconnectPromise === disconnectPromise) {
        this.disconnectPromise = null;
      }
    });
    this.disconnectPromise = disconnectPromise;
    return disconnectPromise;
  }

  private getUsableWebContents(): WebContents {
    let webContents: WebContents;
    try {
      webContents = this.getWebContents();
    } catch (cause) {
      throw new BrowserBackendError("TARGET_CLOSED", "Electron tab is unavailable", {
        backendKind: "electron",
        targetId: this.targetId,
        cause,
      });
    }
    if (webContents.isDestroyed()) {
      throw new BrowserBackendError("TARGET_CLOSED", "Electron tab is closed", {
        backendKind: "electron",
        targetId: this.targetId,
      });
    }
    return webContents;
  }

  private ensureNotForceClosed(): void {
    if (this.forceClosed) {
      throw new BrowserBackendError("CDP_DETACHED", "CDP transport is closed", {
        backendKind: "electron",
        targetId: this.targetId,
      });
    }
  }

  private attachListeners(webContents: WebContents): void {
    if (this.listenersAttached) return;
    webContents.debugger.on("message", this.handleMessage);
    webContents.debugger.on("detach", this.handleDetach);
    this.listenersAttached = true;
  }

  private removeListeners(webContents: WebContents): void {
    if (!this.listenersAttached) return;
    webContents.debugger.removeListener("message", this.handleMessage);
    webContents.debugger.removeListener("detach", this.handleDetach);
    this.listenersAttached = false;
  }
}

export class ElectronBrowserTarget implements BrowserTarget {
  readonly backendKind = "electron" as const;
  readonly id: string;
  readonly tabId: string;
  readonly sessionId: string;
  readonly contextId: string;

  private closed = false;
  private cdpTransport: ElectronCdpTransport | null = null;
  private devtoolsLease: CdpLease | null = null;
  private devtoolsLeaseRelease: Promise<void> | null = null;
  private closeCleanup: Promise<void> | null = null;
  private readonly listeners = new Set<(event: BrowserTargetEvent) => void>();
  private snapshot: BrowserTargetState;

  private readonly handleRendererGone = (
    _event: ElectronEvent,
    details: RenderProcessGoneDetails,
  ): void => {
    this.context.handleTargetCrashed(this.tabId, details.reason);
  };

  private readonly handleDevToolsClosed = (): void => {
    void this.releaseDevToolsLease();
  };

  constructor(
    private readonly context: ElectronBrowserContext,
    private tab: ElectronTabRecord,
  ) {
    this.id = tab.id;
    this.tabId = tab.id;
    this.sessionId = context.sessionId;
    this.contextId = context.id;
    this.snapshot = this.readState();
    this.tab.view.webContents.prependListener(
      "render-process-gone",
      this.handleRendererGone,
    );
    this.tab.view.webContents.on("devtools-closed", this.handleDevToolsClosed);
  }

  get url(): string {
    if (this.closed) return this.snapshot.url;
    try {
      const current = this.tab.view.webContents.getURL();
      return current || this.tab.url;
    } catch {
      return this.tab.url || this.snapshot.url;
    }
  }

  get title(): string {
    if (this.closed) return this.snapshot.title;
    try {
      return this.tab.view.webContents.getTitle() || this.tab.title;
    } catch {
      return this.tab.title || this.snapshot.title;
    }
  }

  isClosed(): boolean {
    return this.closed || this.tab.view.webContents.isDestroyed();
  }

  getState(): BrowserTargetState {
    if (!this.closed) this.snapshot = this.readState();
    return { ...this.snapshot };
  }

  async navigate(url: string): Promise<void> {
    const webContents = this.getWebContents();
    try {
      await webContents.loadURL(normalizeBrowserUrl(url));
    } catch (cause) {
      throw new BrowserBackendError(
        "NAVIGATION_FAILED",
        `Navigation failed for Electron tab ${this.tabId}`,
        {
          backendKind: this.backendKind,
          sessionId: this.sessionId,
          contextId: this.contextId,
          targetId: this.tabId,
          cause,
        },
      );
    }
  }

  async goBack(): Promise<void> {
    const webContents = this.getWebContents();
    if (webContents.canGoBack()) webContents.goBack();
  }

  async goForward(): Promise<void> {
    const webContents = this.getWebContents();
    if (webContents.canGoForward()) webContents.goForward();
  }

  async reload(): Promise<void> {
    this.getWebContents().reload();
  }

  async activate(): Promise<void> {
    this.ensureOpen();
    await this.context.activateTargetInternal(this.tabId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.context.closeTarget(this.tabId);
  }

  async evaluate<T = unknown>(source: string): Promise<T> {
    if (!source.trim()) {
      throw new BrowserBackendError("INVALID_ARGUMENT", "Script cannot be empty", {
        backendKind: this.backendKind,
        sessionId: this.sessionId,
        contextId: this.contextId,
        targetId: this.tabId,
      });
    }
    return (await this.getWebContents().executeJavaScript(source, true)) as T;
  }

  async addInitScript(source: string): Promise<string | null> {
    if (!source.trim()) {
      throw new BrowserBackendError("INVALID_ARGUMENT", "Init script cannot be empty", {
        backendKind: this.backendKind,
        sessionId: this.sessionId,
        contextId: this.contextId,
        targetId: this.tabId,
      });
    }
    const transport = await this.getCdpTransport();
    const lease = await transport.acquire("electron:init-script");
    try {
      const result = await lease.send<{ identifier?: string }>(
        "Page.addScriptToEvaluateOnNewDocument",
        { source },
      );
      return result.identifier ?? null;
    } finally {
      await lease.release();
    }
  }

  async exposeBinding(
    _name: string,
    _callback: BrowserBindingCallback,
  ): Promise<void> {
    throw new BrowserBackendError(
      "CAPABILITY_UNSUPPORTED",
      "Electron backend does not provide browser-neutral page bindings",
      {
        backendKind: this.backendKind,
        sessionId: this.sessionId,
        contextId: this.contextId,
        targetId: this.tabId,
      },
    );
  }

  async captureScreenshot(): Promise<Buffer> {
    const image = await this.getWebContents().capturePage();
    return image.toPNG();
  }

  async getCdpTransport(): Promise<CdpTransport> {
    this.ensureOpen();
    if (!this.cdpTransport) {
      this.cdpTransport = new ElectronCdpTransport(
        this.tabId,
        () => this.tab.view.webContents,
      );
    }
    return this.cdpTransport;
  }

  onEvent(listener: (event: BrowserTargetEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async setVisible(visible: boolean): Promise<void> {
    this.ensureOpen();
    if (visible) await this.activate();
    if (this.getState().isActive) this.context.setVisible(visible);
  }

  async setBounds(bounds: BrowserBounds): Promise<void> {
    this.ensureOpen();
    validateBounds(bounds);
    await this.activate();
    this.tab.view.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
    });
  }

  async toggleDevTools(): Promise<void> {
    const webContents = this.getWebContents();
    if (webContents.isDevToolsOpened()) {
      webContents.closeDevTools();
      await this.releaseDevToolsLease();
      return;
    }

    const lease = await this.getCdpTransport().then((transport) =>
      transport.acquire(`devtools:${this.sessionId}:${this.tabId}`),
    );
    this.devtoolsLease = lease;
    try {
      webContents.openDevTools({ mode: "detach" });
    } catch (error) {
      await this.releaseDevToolsLease();
      throw error;
    }
  }

  getNativeHandle<T = unknown>(): T {
    return this.getWebContents() as unknown as T;
  }

  updateTab(tab: ElectronTabRecord): void {
    if (this.closed) return;
    this.tab = tab;
    this.snapshot = this.readState();
  }

  emitUpdated(): void {
    if (this.closed) return;
    const event: BrowserTargetEvent = {
      type: "target-updated",
      sessionId: this.sessionId,
      contextId: this.contextId,
      tabId: this.tabId,
      target: this.getState(),
    };
    for (const listener of this.listeners) listener(event);
  }

  emitCrashed(reason?: string): void {
    const event: BrowserTargetEvent = {
      type: "target-crashed",
      sessionId: this.sessionId,
      contextId: this.contextId,
      tabId: this.tabId,
      ...(reason ? { reason } : {}),
    };
    for (const listener of this.listeners) listener(event);
  }

  markClosed(): Promise<void> {
    if (this.closed) return this.waitForCloseCleanup();
    this.snapshot = { ...this.getState(), isActive: false, isLoading: false };
    this.closed = true;
    if (!this.tab.view.webContents.isDestroyed()) {
      this.tab.view.webContents.removeListener(
        "render-process-gone",
        this.handleRendererGone,
      );
      this.tab.view.webContents.removeListener(
        "devtools-closed",
        this.handleDevToolsClosed,
      );
    }
    this.closeCleanup = (async () => {
      await this.releaseDevToolsLease();
      await this.cdpTransport?.forceClose();
    })();
    void this.closeCleanup.catch((error) => {
      console.warn(
        `[ElectronBrowserTarget] Failed to release CDP owners for ${this.tabId}:`,
        error,
      );
    });
    const event: BrowserTargetEvent = {
      type: "target-closed",
      sessionId: this.sessionId,
      contextId: this.contextId,
      tabId: this.tabId,
    };
    for (const listener of this.listeners) listener(event);
    this.listeners.clear();
    return this.closeCleanup;
  }

  waitForCloseCleanup(): Promise<void> {
    return this.closeCleanup ?? Promise.resolve();
  }

  isNativeDestroyed(): boolean {
    return this.tab.view.webContents.isDestroyed();
  }

  private getWebContents(): WebContents {
    this.ensureOpen();
    return this.tab.view.webContents;
  }

  private async releaseDevToolsLease(): Promise<void> {
    if (this.devtoolsLeaseRelease) return this.devtoolsLeaseRelease;
    const lease = this.devtoolsLease;
    if (!lease) return;
    this.devtoolsLease = null;
    let release!: Promise<void>;
    release = (lease.released ? Promise.resolve() : lease.release())
      .catch(() => undefined)
      .finally(() => {
        if (this.devtoolsLeaseRelease === release) {
          this.devtoolsLeaseRelease = null;
        }
      });
    this.devtoolsLeaseRelease = release;
    return release;
  }

  private ensureOpen(): void {
    if (this.isClosed()) {
      throw new BrowserBackendError("TARGET_CLOSED", "Electron tab is closed", {
        backendKind: this.backendKind,
        sessionId: this.sessionId,
        contextId: this.contextId,
        targetId: this.tabId,
      });
    }
  }

  private readState(): BrowserTargetState {
    const webContents = this.tab.view.webContents;
    const usable = !webContents.isDestroyed();
    return {
      id: this.tabId,
      tabId: this.tabId,
      sessionId: this.sessionId,
      contextId: this.contextId,
      url: usable ? webContents.getURL() || this.tab.url : this.tab.url,
      title: usable ? webContents.getTitle() || this.tab.title : this.tab.title,
      isActive: this.context.isTargetActive(this.tabId),
      isLoading: usable ? webContents.isLoading() : false,
      canGoBack: usable && webContents.canGoBack(),
      canGoForward: usable && webContents.canGoForward(),
    };
  }
}

export class ElectronBrowserContext implements BrowserContext {
  readonly backendKind = "electron" as const;
  readonly id: string;
  readonly sessionId: string;

  private closed = false;
  private currentOptions: Readonly<BrowserContextOptions>;
  private readonly targetMap = new Map<string, ElectronBrowserTarget>();
  private readonly listeners = new Set<(event: BrowserContextEvent) => void>();

  constructor(
    private readonly backend: ElectronBrowserBackend,
    options: BrowserContextOptions,
    private readonly nativeSession: ElectronSession,
  ) {
    this.sessionId = options.sessionId;
    this.id = `electron:${options.sessionId}`;
    this.currentOptions = Object.freeze({ ...options });
  }

  get options(): Readonly<BrowserContextOptions> {
    return this.currentOptions;
  }

  isClosed(): boolean {
    return this.closed;
  }

  async activate(): Promise<void> {
    this.ensureOpen();
    await this.backend.activateContext(this);
  }

  async targets(): Promise<BrowserTarget[]> {
    this.ensureOpen();
    return [...this.targetMap.values()].filter((target) => !target.isClosed());
  }

  async listTargets(): Promise<BrowserTarget[]> {
    return this.targets();
  }

  getTarget(tabId: string): BrowserTarget | null {
    const target = this.targetMap.get(tabId);
    return target && !target.isClosed() ? target : null;
  }

  async createTarget(url?: string): Promise<BrowserTarget> {
    this.ensureOpen();
    await this.activate();
    const tab = this.backend.createNativeTab(url);
    return this.ensureTarget(tab).target;
  }

  async activateTarget(tabId: string): Promise<BrowserTarget> {
    const target = this.requireTarget(tabId);
    await target.activate();
    return target;
  }

  async activateTargetInternal(tabId: string): Promise<void> {
    this.ensureOpen();
    await this.activate();
    this.backend.activateNativeTab(this, tabId);
  }

  async closeTarget(tabId: string): Promise<void> {
    if (this.closed) return;
    const target = this.targetMap.get(tabId);
    if (!target || target.isClosed()) return;
    await this.activate();
    this.backend.closeNativeTab(this, tabId);
    if (!target.isClosed()) await this.handleTargetClosed(tabId);
    else await target.waitForCloseCleanup();
  }

  async clearData(options: BrowserClearDataOptions = {}): Promise<void> {
    this.ensureOpen();
    const clearStorage = options.storage ?? true;
    const clearCache = options.cache ?? true;
    if (clearStorage) await this.nativeSession.clearStorageData();
    if (clearCache) await this.nativeSession.clearCache();
    if (options.reloadTargets) {
      await Promise.all(
        [...this.targetMap.values()]
          .filter((target) => !target.isClosed())
          .map((target) => target.reload()),
      );
    }
  }

  async updateProxy(proxy: BrowserContextOptions["proxy"]): Promise<void> {
    this.ensureOpen();
    await applyProxy(this.nativeSession, proxy ?? null);
    this.currentOptions = Object.freeze({ ...this.currentOptions, proxy: proxy ?? null });
  }

  async close(): Promise<void> {
    await this.backend.closeContext(this.sessionId);
  }

  onEvent(listener: (event: BrowserContextEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getNativeHandle<T = unknown>(): T {
    return this.nativeSession as unknown as T;
  }

  ensureTarget(tab: ElectronTabRecord): {
    target: ElectronBrowserTarget;
    created: boolean;
  } {
    const existing = this.targetMap.get(tab.id);
    if (existing && !existing.isClosed()) {
      existing.updateTab(tab);
      return { target: existing, created: false };
    }
    const target = new ElectronBrowserTarget(this, tab);
    this.targetMap.set(tab.id, target);
    this.backend.setTargetOwner(tab.id, this);
    return { target, created: true };
  }

  syncNativeTargets(tabs: ElectronTabRecord[]): void {
    for (const tab of tabs) this.ensureTarget(tab);
  }

  handleTargetUpdated(tabId: string, tab?: ElectronTabRecord): void {
    const target = this.targetMap.get(tabId);
    if (!target || target.isClosed()) return;
    if (tab) target.updateTab(tab);
    target.emitUpdated();
    this.emit({
      type: "target-updated",
      sessionId: this.sessionId,
      contextId: this.id,
      tabId,
      target: target.getState(),
    });
  }

  handleTargetActivated(tabId: string): void {
    const target = this.targetMap.get(tabId);
    if (!target || target.isClosed()) return;
    this.emit({
      type: "target-activated",
      sessionId: this.sessionId,
      contextId: this.id,
      tabId,
    });
  }

  handleTargetCrashed(tabId: string, reason?: string): void {
    const target = this.targetMap.get(tabId);
    if (!target) return;
    target.emitCrashed(reason);
    this.emit({
      type: "target-crashed",
      sessionId: this.sessionId,
      contextId: this.id,
      tabId,
      ...(reason ? { reason } : {}),
    });
  }

  async handleTargetClosed(tabId: string): Promise<void> {
    const target = this.targetMap.get(tabId);
    if (!target) return;
    const cleanup = target.markClosed();
    this.targetMap.delete(tabId);
    this.backend.deleteTargetOwner(tabId, this);
    this.emit({
      type: "target-closed",
      sessionId: this.sessionId,
      contextId: this.id,
      tabId,
    });
    await cleanup;
  }

  async closeFromBackend(): Promise<void> {
    if (this.closed) return;
    await Promise.all(
      [...this.targetMap.keys()].map((tabId) => this.handleTargetClosed(tabId)),
    );
    this.closed = true;
    this.listeners.clear();
  }

  isTargetActive(tabId: string): boolean {
    return this.backend.isNativeTargetActive(this, tabId);
  }

  setVisible(visible: boolean): void {
    this.backend.setNativeViewVisible(visible);
  }

  emitTargetCreated(
    target: ElectronBrowserTarget,
    openerTabId?: string,
  ): void {
    this.emit({
      type: "target-created",
      sessionId: this.sessionId,
      contextId: this.id,
      tabId: target.tabId,
      target,
      ...(openerTabId ? { openerTabId } : {}),
    });
  }

  private requireTarget(tabId: string): ElectronBrowserTarget {
    this.ensureOpen();
    const target = this.targetMap.get(tabId);
    if (!target || target.isClosed()) {
      throw new BrowserBackendError("TARGET_NOT_FOUND", `Tab ${tabId} was not found`, {
        backendKind: this.backendKind,
        sessionId: this.sessionId,
        contextId: this.id,
        targetId: tabId,
      });
    }
    return target;
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new BrowserBackendError("CONTEXT_CLOSED", "Electron context is closed", {
        backendKind: this.backendKind,
        sessionId: this.sessionId,
        contextId: this.id,
      });
    }
  }

  private emit(event: BrowserContextEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

export class ElectronBrowserBackend implements BrowserBackend {
  readonly kind = "electron" as const;
  readonly capabilities = ELECTRON_CAPABILITIES;

  private readonly contexts = new Map<string, ElectronBrowserContext>();
  private readonly targetOwners = new Map<string, ElectronBrowserContext>();
  private tabManager: TabManager | null;
  private started = false;
  private shuttingDown = false;
  private shutDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private activationTail: Promise<void> = Promise.resolve();

  private readonly onTabCreated = (data: TabCreatedData): void => {
    const tabManager = this.tabManager;
    if (!tabManager) return;
    const groupId = tabManager.getCurrentGroupId();
    if (!groupId) return;
    const context = this.contexts.get(groupId);
    const tab = this.findCurrentTab(data.id);
    if (!context || !tab) return;

    const { target, created } = context.ensureTarget(tab);
    if (created) context.emitTargetCreated(target, data.openerTabId);
    if (tabManager.getActiveTab()?.id === data.id) {
      context.handleTargetActivated(data.id);
    }
  };

  private readonly onTabUpdated = (data: TabChangedData): void => {
    const context = this.targetOwners.get(data.tabId);
    if (!context) return;
    context.handleTargetUpdated(data.tabId, this.findCurrentTab(data.tabId));
  };

  private readonly onTabActivated = (data: TabChangedData): void => {
    const context = this.targetOwners.get(data.tabId);
    if (!context) return;
    context.handleTargetActivated(data.tabId);
  };

  private readonly onTabClosed = (data: { tabId: string }): void => {
    const context = this.targetOwners.get(data.tabId);
    if (!context) return;

    // switchSessionGroup emits UI-only close events while retaining live tabs.
    if (this.findCurrentTab(data.tabId)) return;
    void context.handleTargetClosed(data.tabId).catch((error) => {
      console.warn(
        `[ElectronBrowserBackend] Failed to close tab ${data.tabId}:`,
        error,
      );
    });
  };

  constructor(
    private readonly windowManager: WindowManager,
    tabManager?: TabManager,
  ) {
    this.tabManager = tabManager ?? null;
  }

  async start(): Promise<void> {
    if (this.shuttingDown) {
      throw new BrowserBackendError(
        "BACKEND_SHUTTING_DOWN",
        "Electron browser backend is shutting down",
        { backendKind: this.kind },
      );
    }
    if (this.started) return;
    this.tabManager ??= this.windowManager.getTabManager();
    if (!this.tabManager) {
      throw new BrowserBackendError(
        "BACKEND_NOT_STARTED",
        "TabManager must be initialized before the Electron browser backend starts",
        { backendKind: this.kind },
      );
    }

    this.tabManager.on("tab-created", this.onTabCreated);
    this.tabManager.on("tab-updated", this.onTabUpdated);
    this.tabManager.on("tab-activated", this.onTabActivated);
    this.tabManager.on("tab-closed", this.onTabClosed);
    this.started = true;
  }

  async openContext(options: BrowserContextOptions): Promise<BrowserContext> {
    this.ensureUsable();
    const sessionId = options.sessionId.trim();
    if (!sessionId) {
      throw new BrowserBackendError("INVALID_ARGUMENT", "Session ID cannot be empty", {
        backendKind: this.kind,
      });
    }
    const existing = this.contexts.get(sessionId);
    if (existing && !existing.isClosed()) return existing;

    const nativeSession = electronSession.fromPartition(`persist:session-${sessionId}`);
    await applyProxy(nativeSession, options.proxy ?? null);
    if (options.fingerprint) applyHttpSpoofing(nativeSession, options.fingerprint);

    const context = new ElectronBrowserContext(
      this,
      { ...options, sessionId },
      nativeSession,
    );
    this.contexts.set(sessionId, context);
    return context;
  }

  getContext(sessionId: string): BrowserContext | null {
    const context = this.contexts.get(sessionId);
    return context && !context.isClosed() ? context : null;
  }

  async closeContext(sessionId: string): Promise<void> {
    const context = this.contexts.get(sessionId);
    if (!context) return;
    await context.closeFromBackend();
    this.tabManager?.destroySessionGroup(sessionId);
    if (this.contexts.get(sessionId) === context) {
      this.contexts.delete(sessionId);
    }
  }

  async deletePersistentProfile(profileKey: string): Promise<void> {
    const normalizedKey = profileKey.trim();
    if (!normalizedKey) {
      throw new BrowserBackendError("INVALID_ARGUMENT", "Profile key cannot be empty", {
        backendKind: this.kind,
      });
    }
    if (this.contexts.has(normalizedKey)) await this.closeContext(normalizedKey);
    const nativeSession = electronSession.fromPartition(
      `persist:session-${normalizedKey}`,
    );
    await Promise.all([
      nativeSession.clearStorageData(),
      nativeSession.clearCache(),
    ]);
    await nativeSession.closeAllConnections();
  }

  async activateContext(context: ElectronBrowserContext): Promise<void> {
    return this.enqueueActivation(async () => {
      this.ensureUsable();
      if (this.contexts.get(context.sessionId) !== context || context.isClosed()) {
        throw new BrowserBackendError("CONTEXT_NOT_FOUND", "Electron context was not found", {
          backendKind: this.kind,
          sessionId: context.sessionId,
          contextId: context.id,
        });
      }
      const tabManager = this.requireTabManager();
      const nativeSession = context.getNativeHandle<ElectronSession>();
      tabManager.switchSessionGroup(context.sessionId, nativeSession);
      context.syncNativeTargets(this.currentTabs());
    });
  }

  createNativeTab(url?: string): ElectronTabRecord {
    this.ensureUsable();
    const normalizedUrl = url === undefined ? undefined : normalizeBrowserUrl(url);
    return this.requireTabManager().createTab(normalizedUrl) as ElectronTabRecord;
  }

  activateNativeTab(context: ElectronBrowserContext, tabId: string): void {
    const tabManager = this.requireTabManager();
    if (tabManager.getCurrentGroupId() !== context.sessionId) {
      throw new BrowserBackendError("CONTEXT_BACKEND_MISMATCH", "Context is not active", {
        backendKind: this.kind,
        sessionId: context.sessionId,
        contextId: context.id,
        targetId: tabId,
      });
    }
    if (!this.findCurrentTab(tabId)) {
      throw new BrowserBackendError("TARGET_NOT_FOUND", `Tab ${tabId} was not found`, {
        backendKind: this.kind,
        sessionId: context.sessionId,
        contextId: context.id,
        targetId: tabId,
      });
    }
    tabManager.activateTab(tabId);
  }

  closeNativeTab(context: ElectronBrowserContext, tabId: string): void {
    const tabManager = this.requireTabManager();
    if (tabManager.getCurrentGroupId() !== context.sessionId) {
      throw new BrowserBackendError("CONTEXT_BACKEND_MISMATCH", "Context is not active", {
        backendKind: this.kind,
        sessionId: context.sessionId,
        contextId: context.id,
        targetId: tabId,
      });
    }
    tabManager.closeTab(tabId);
  }

  setTargetOwner(tabId: string, context: ElectronBrowserContext): void {
    this.targetOwners.set(tabId, context);
  }

  deleteTargetOwner(tabId: string, context: ElectronBrowserContext): void {
    if (this.targetOwners.get(tabId) === context) this.targetOwners.delete(tabId);
  }

  isNativeTargetActive(context: ElectronBrowserContext, tabId: string): boolean {
    const tabManager = this.tabManager;
    return Boolean(
      tabManager &&
        tabManager.getCurrentGroupId() === context.sessionId &&
        tabManager.getActiveTab()?.id === tabId,
    );
  }

  setNativeViewVisible(visible: boolean): void {
    this.windowManager.setTargetViewVisible(visible);
  }

  shutdown(): Promise<void> {
    if (this.shutDown) return Promise.resolve();
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;

    const attempt = this.performShutdown();
    const trackedAttempt = attempt.finally(() => {
      if (this.shutdownPromise === trackedAttempt) this.shutdownPromise = null;
    });
    this.shutdownPromise = trackedAttempt;
    return trackedAttempt;
  }

  private async performShutdown(): Promise<void> {
    const failures: unknown[] = [];
    const tabManager = this.tabManager;

    if (tabManager && this.started) {
      tabManager.removeListener("tab-created", this.onTabCreated);
      tabManager.removeListener("tab-updated", this.onTabUpdated);
      tabManager.removeListener("tab-activated", this.onTabActivated);
      tabManager.removeListener("tab-closed", this.onTabClosed);
    }
    tabManager?.setShuttingDown(true);
    this.windowManager.setShuttingDown(true);

    for (const sessionId of [...this.contexts.keys()]) {
      try {
        await this.closeContext(sessionId);
      } catch (error) {
        failures.push(error);
      }
    }

    if (failures.length === 0) {
      try {
        if (this.windowManager.getTabManager() === tabManager) {
          this.windowManager.destroyTargetView();
        } else {
          tabManager?.destroyEverything();
        }
      } catch (error) {
        failures.push(error);
      }
    }

    if (failures.length > 0) {
      throw new BrowserBackendError(
        "BACKEND_FAILURE",
        `Electron backend shutdown failed in ${failures.length} operation(s)`,
        { backendKind: this.kind, cause: new AggregateError(failures) },
      );
    }

    this.contexts.clear();
    this.targetOwners.clear();
    this.started = false;
    this.tabManager = null;
    this.shutDown = true;
  }

  private currentTabs(): ElectronTabRecord[] {
    return this.requireTabManager().getAllTabs() as ElectronTabRecord[];
  }

  private findCurrentTab(tabId: string): ElectronTabRecord | undefined {
    return this.tabManager
      ?.getAllTabs()
      .find((tab) => tab.id === tabId) as ElectronTabRecord | undefined;
  }

  private requireTabManager(): TabManager {
    this.ensureUsable();
    return this.tabManager!;
  }

  private ensureUsable(): void {
    if (this.shuttingDown) {
      throw new BrowserBackendError(
        "BACKEND_SHUTTING_DOWN",
        "Electron browser backend is shutting down",
        { backendKind: this.kind },
      );
    }
    if (!this.started || !this.tabManager) {
      throw new BrowserBackendError(
        "BACKEND_NOT_STARTED",
        "Electron browser backend has not started",
        { backendKind: this.kind },
      );
    }
  }

  private enqueueActivation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.activationTail.then(operation, operation);
    this.activationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

async function applyProxy(
  nativeSession: ElectronSession,
  proxy: BrowserContextOptions["proxy"],
): Promise<void> {
  if (!proxy || proxy.type === "none") {
    await nativeSession.setProxy({ mode: "direct" });
    return;
  }
  if (!proxy.host.trim() || !Number.isInteger(proxy.port) || proxy.port <= 0) {
    throw new BrowserBackendError("INVALID_ARGUMENT", "Invalid proxy host or port", {
      backendKind: "electron",
    });
  }
  await nativeSession.setProxy({
    proxyRules: `${proxy.type}://${proxy.host}:${proxy.port}`,
  });
}

function validateBounds(bounds: BrowserBounds): void {
  const values = [bounds.x, bounds.y, bounds.width, bounds.height];
  if (values.some((value) => !Number.isFinite(value)) || bounds.width < 0 || bounds.height < 0) {
    throw new BrowserBackendError("INVALID_ARGUMENT", "Browser bounds are invalid", {
      backendKind: "electron",
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseProtectedDomainOperation(
  method: string,
): { domain: string; operation: "enable" | "disable" } | null {
  const match = /^([A-Za-z][A-Za-z0-9]*)\.(enable|disable)$/.exec(method);
  if (!match || !PROTECTED_CDP_DOMAINS.has(match[1])) return null;
  return {
    domain: match[1],
    operation: match[2] as "enable" | "disable",
  };
}
