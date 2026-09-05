import type {
  BrowserBackendKind,
  BrowserErrorCode,
  CaptureMode,
  FingerprintProfile,
  ProxyConfig,
} from "@shared/types";

export type { BrowserErrorCode } from "@shared/types";

export type BrowserPresentation = "embedded" | "external";
export type BrowserDevToolsCapability = "native" | "backend" | "none";
export type BrowserDownloadCapability = "native" | "managed" | "none";
export type BrowserFileChooserCapability =
  | "native"
  | "programmatic"
  | "none";
export type BrowserProxyUpdateCapability =
  | "runtime"
  | "context-restart"
  | "none";

/** Stable feature description used by the main process and renderer. */
export interface BrowserCapabilities {
  presentation: BrowserPresentation;
  captureModes: readonly CaptureMode[];
  persistentContexts: boolean;
  cdp: boolean;
  initScripts: boolean;
  pageBindings: boolean;
  screenshots: boolean;
  popupOpener: boolean;
  devtools: BrowserDevToolsCapability;
  downloads: BrowserDownloadCapability;
  fileChooser: BrowserFileChooserCapability;
  proxyUpdate: BrowserProxyUpdateCapability;
}

export interface BrowserContextOptions {
  sessionId: string;
  profileId?: string | null;
  proxy?: ProxyConfig | null;
  fingerprint?: FingerprintProfile | null;
  captureMode?: CaptureMode;
  backendOptions?: Record<string, unknown>;
}

export interface BrowserTargetState {
  id: string;
  tabId: string;
  sessionId: string;
  contextId: string;
  url: string;
  title: string;
  isActive: boolean;
  isLoading: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
}

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserClearDataOptions {
  /** Cookies, DOM storage, IndexedDB, service workers, and related profile data. */
  storage?: boolean;
  cache?: boolean;
  reloadTargets?: boolean;
}

export interface CdpMessage {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

export type Unsubscribe = () => void;

export interface BrowserEventScope {
  sessionId: string;
  contextId: string;
  tabId: string;
}

/** A ref-counted claim on a target's shared CDP connection. */
export interface CdpLease {
  readonly owner: string;
  readonly targetId: string;
  readonly connected: boolean;
  readonly released: boolean;
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
  onMessage(listener: (message: CdpMessage) => void): Unsubscribe;
  onDisconnect(listener: (reason?: string) => void): Unsubscribe;
  release(): Promise<void>;
}

/**
 * Browser-neutral CDP connection. A backend may multiplex this over one native
 * debugger connection, so consumers must not attach or detach the browser
 * debugger themselves.
 */
export interface CdpTransport {
  readonly targetId: string;
  readonly connected: boolean;
  acquire(owner: string): Promise<CdpLease>;
  connect(): Promise<void>;
  send<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
  onMessage(listener: (message: CdpMessage) => void): Unsubscribe;
  onDisconnect(listener: (reason?: string) => void): Unsubscribe;
  /** Graceful compatibility close; refuses to detach while leases are active. */
  close(): Promise<void>;
  /** Permanently closes the transport, including all outstanding leases. */
  forceClose(): Promise<void>;
}

export interface BrowserDownloadEvent {
  id: string;
  url: string;
  suggestedFilename?: string;
  state?: "started" | "progress" | "completed" | "cancelled" | "failed";
  receivedBytes?: number;
  totalBytes?: number;
  savePath?: string;
  error?: string;
}

export type BrowserTargetEvent =
  | (BrowserEventScope & {
      type: "target-updated";
      target: BrowserTargetState;
    })
  | (BrowserEventScope & {
      type: "target-crashed";
      reason?: string;
    })
  | (BrowserEventScope & {
      type: "target-closed";
    });

export interface BrowserBindingCall extends BrowserEventScope {
  name: string;
  args: readonly unknown[];
}

export type BrowserBindingCallback = (
  call: BrowserBindingCall,
) => unknown | Promise<unknown>;

export type BrowserContextEvent =
  | {
      type: "target-created";
      sessionId: string;
      contextId: string;
      tabId: string;
      target: BrowserTarget;
      openerTabId?: string;
    }
  | {
      type: "target-closed";
      sessionId: string;
      contextId: string;
      tabId: string;
    }
  | {
      type: "target-activated";
      sessionId: string;
      contextId: string;
      tabId: string;
    }
  | {
      type: "target-updated";
      sessionId: string;
      contextId: string;
      tabId: string;
      target: BrowserTargetState;
    }
  | {
      type: "target-crashed";
      sessionId: string;
      contextId: string;
      tabId: string;
      reason?: string;
    }
  | {
      type: "download";
      sessionId: string;
      contextId: string;
      tabId: string;
      download: BrowserDownloadEvent;
    }
  | {
      type: "disconnected";
      sessionId: string;
      contextId: string;
      tabId: null;
      reason?: string;
    };

export interface BrowserTarget {
  readonly id: string;
  readonly tabId: string;
  readonly sessionId: string;
  readonly contextId: string;
  readonly backendKind: BrowserBackendKind;
  readonly url: string;
  readonly title: string;

  isClosed(): boolean;
  getState(): BrowserTargetState;
  navigate(url: string): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  activate(): Promise<void>;
  close(): Promise<void>;
  evaluate<T = unknown>(source: string): Promise<T>;
  addInitScript(source: string): Promise<string | null>;
  exposeBinding(name: string, callback: BrowserBindingCallback): Promise<void>;
  captureScreenshot(): Promise<Buffer>;
  getCdpTransport(): Promise<CdpTransport>;
  onEvent(listener: (event: BrowserTargetEvent) => void): Unsubscribe;

  /** Embedded-presentation operations. External backends normally omit these. */
  setVisible?(visible: boolean): Promise<void>;
  setBounds?(bounds: BrowserBounds): Promise<void>;
  toggleDevTools?(): Promise<void>;

  /** Transitional escape hatch for existing Electron-only capture modules. */
  getNativeHandle<T = unknown>(): T;
}

export interface BrowserContext {
  readonly id: string;
  readonly sessionId: string;
  readonly backendKind: BrowserBackendKind;
  readonly options: Readonly<BrowserContextOptions>;

  isClosed(): boolean;
  activate(): Promise<void>;
  targets(): Promise<BrowserTarget[]>;
  /** @deprecated Use targets(). */
  listTargets(): Promise<BrowserTarget[]>;
  getTarget(tabId: string): BrowserTarget | null;
  createTarget(url?: string): Promise<BrowserTarget>;
  activateTarget(tabId: string): Promise<BrowserTarget>;
  closeTarget(tabId: string): Promise<void>;
  clearData(options?: BrowserClearDataOptions): Promise<void>;
  /** Runtime proxy updates are present only when capabilities.proxyUpdate is runtime. */
  updateProxy?(proxy: ProxyConfig | null): Promise<void>;
  close(): Promise<void>;
  onEvent(listener: (event: BrowserContextEvent) => void): Unsubscribe;
  getNativeHandle<T = unknown>(): T;
}

export interface BrowserBackend {
  readonly kind: BrowserBackendKind;
  readonly capabilities: Readonly<BrowserCapabilities>;

  start(): Promise<void>;
  openContext(options: BrowserContextOptions): Promise<BrowserContext>;
  getContext(sessionId: string): BrowserContext | null;
  closeContext(sessionId: string): Promise<void>;
  deletePersistentProfile(profileKey: string): Promise<void>;
  shutdown(): Promise<void>;
}

export interface BrowserErrorDetails {
  backendKind?: BrowserBackendKind;
  sessionId?: string;
  contextId?: string;
  tabId?: string;
  /** @deprecated Use tabId. */
  targetId?: string;
  cause?: unknown;
}

export class BrowserBackendError extends Error {
  readonly code: BrowserErrorCode;
  readonly backendKind?: BrowserBackendKind;
  readonly sessionId?: string;
  readonly contextId?: string;
  readonly tabId?: string;
  /** @deprecated Use tabId. */
  readonly targetId?: string;

  constructor(
    code: BrowserErrorCode,
    message: string,
    details: BrowserErrorDetails = {},
  ) {
    super(
      formatBrowserBackendErrorMessage(code, message),
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.name = "BrowserBackendError";
    this.code = code;
    this.backendKind = details.backendKind;
    this.sessionId = details.sessionId;
    this.contextId = details.contextId;
    this.tabId = details.tabId ?? details.targetId;
    this.targetId = this.tabId;
  }
}

export function formatBrowserBackendErrorMessage(
  code: BrowserErrorCode,
  message: string,
): string {
  const prefix = `[${code}]`;
  return message.startsWith(prefix) ? message : `${prefix} ${message}`;
}

export function isBrowserBackendError(error: unknown): error is BrowserBackendError {
  return error instanceof BrowserBackendError;
}

export function supportsCaptureMode(
  capabilities: BrowserCapabilities,
  mode: CaptureMode,
): boolean {
  return capabilities.captureModes.includes(mode);
}

export function normalizeBrowserUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new BrowserBackendError("INVALID_ARGUMENT", "Browser URL cannot be empty");
  }
  return /^(?:https?:\/\/|about:|data:|file:|chrome:|devtools:)/i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
}
