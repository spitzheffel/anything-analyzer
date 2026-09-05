import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { app } from "electron";
import type { BrowserContext as PlaywrightBrowserContext } from "playwright-core";
import type { CloakRuntimePolicy, CloakRuntimeStatus } from "@shared/types";
import {
  BrowserBackendError,
  type BrowserContextOptions,
  type Unsubscribe,
} from "./contracts";

type CloakModule = typeof import("cloakbrowser");
type CloakBinaryInfo = import("cloakbrowser").BinaryInfo;
type CloakLaunchOptions = import("cloakbrowser").LaunchPersistentContextOptions;
type CloakProxy = NonNullable<
  import("cloakbrowser").LaunchPersistentContextOptions["proxy"]
>;
type MaybePromise<T> = T | Promise<T>;

export const CLOAK_WRAPPER_VERSION = "0.5.10";
export const CLOAK_PAID_BROWSER_VERSION = "151.0.7922.108.3";
export const CLOAK_RELEASE_CHANNEL = "stable" as const;

export type CloakLicenseMode = CloakRuntimePolicy;

export interface CloakProfileIdentity {
  profileId: string | null;
  profileKey: string;
  seed: string;
}

export interface CloakProfileTouch {
  sessionId: string;
  profileId: string | null;
  profileKey: string;
  userDataDir: string;
  lastUsedAt: number;
}

export interface CloakBrowserVersionResolution {
  sessionId: string;
  version: string;
  mode: CloakRuntimePolicy;
  licensePlan: string | null;
}

export interface CloakRuntimeOptions {
  policy?: CloakRuntimePolicy;
  /** Must resolve to a directory below Electron's userData directory. */
  profileRoot?: string;
  /** Alias used by the application composition root. */
  profilesRoot?: string;
  resolveProfile?: (
    options: Readonly<BrowserContextOptions>,
  ) => MaybePromise<CloakProfileIdentity>;
  onProfileTouched?: (touch: CloakProfileTouch) => MaybePromise<void>;
  onBrowserVersionResolved?: (
    resolution: CloakBrowserVersionResolution,
  ) => MaybePromise<void>;
  onStatusChanged?: (status: CloakRuntimeStatus) => void;
}

export interface CloakBinaryStatus {
  wrapperVersion: string;
  mode: CloakRuntimePolicy;
  licensePlan: string | null;
  releaseChannel: typeof CLOAK_RELEASE_CHANNEL;
  requestedVersion: string | null;
  actualVersion: string;
  executablePath: string;
  binaryInfo: CloakBinaryInfo;
}

export interface CloakRuntimeContextSnapshot {
  id: string;
  sessionId: string;
  profileId: string | null;
  profileKey: string;
  userDataDir: string;
  browserVersion: string;
  createdAt: number;
  lastUsedAt: number;
  closed: boolean;
}

export interface CloakCliEnvironmentDiagnostics {
  wrapper: string;
  platformTag: string;
}

export interface CloakCliBinaryDiagnostics {
  version: string | null;
  installedVersion: string | null;
  requestedChannel: string;
  resolvedChannel: string | null;
  tier: "free" | "pro" | "override";
  path: string | null;
  installed: boolean;
  pinned: boolean;
}

export interface CloakCliLicenseDiagnostics {
  tier: string;
  valid: boolean | null;
  error: string | null;
  seatLimit: number | null;
}

export interface CloakCliDiagnostics {
  environment: CloakCliEnvironmentDiagnostics;
  binary: CloakCliBinaryDiagnostics;
  license: CloakCliLicenseDiagnostics;
}

interface PreparedRuntime {
  api: CloakModule;
  policy: CloakRuntimePolicy;
  requestedVersion: string | undefined;
  status: CloakBinaryStatus;
}

const PROFILE_KEY_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const CLOAK_CLI_TIMEOUT_MS = 20_000;
const CLOAK_CLI_MAX_BUFFER_BYTES = 1024 * 1024;
let cloakModulePromise: Promise<CloakModule> | null = null;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function backendFailure(
  message: string,
  options?: BrowserContextOptions,
  cause?: unknown,
): BrowserBackendError {
  return new BrowserBackendError("BACKEND_FAILURE", message, {
    backendKind: "cloak",
    sessionId: options?.sessionId,
    cause,
  });
}

function validateCloakApi(value: unknown): CloakModule {
  if (!value || typeof value !== "object") {
    throw new Error("cloakbrowser did not expose an ES module namespace");
  }
  const api = value as Partial<CloakModule>;
  const requiredFunctions = [
    "launchPersistentContext",
    "ensureBinary",
    "binaryInfo",
  ] as const;
  for (const name of requiredFunctions) {
    if (typeof api[name] !== "function") {
      throw new Error(
        `cloakbrowser ${CLOAK_WRAPPER_VERSION} compatibility check failed: ${name}() is missing`,
      );
    }
  }
  if (typeof api.CHROMIUM_VERSION !== "string" || !api.CHROMIUM_VERSION) {
    throw new Error(
      `cloakbrowser ${CLOAK_WRAPPER_VERSION} compatibility check failed: CHROMIUM_VERSION is missing`,
    );
  }
  return api as CloakModule;
}

/** ESM-only Cloak is loaded only when status preparation/open is requested. */
export async function loadCloakModule(): Promise<CloakModule> {
  if (!cloakModulePromise) {
    cloakModulePromise = import("cloakbrowser")
      .then(validateCloakApi)
      .catch((error: unknown) => {
        cloakModulePromise = null;
        throw error;
      });
  }
  return cloakModulePromise;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`CloakBrowser diagnostics field ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  const normalized = optionalString(value);
  if (!normalized) {
    throw new Error(`CloakBrowser diagnostics field ${label} must be a non-empty string`);
  }
  return normalized;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requiredString(value, label);
}

function optionalNullableString(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  return requiredString(value, label);
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`CloakBrowser diagnostics field ${label} must be a boolean`);
  }
  return value;
}

/** Parse and validate the stable contract emitted by cloakbrowser 0.5.10. */
export function parseCloakInfoJson(stdout: string): CloakCliDiagnostics {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim()) as unknown;
  } catch (error) {
    throw new Error("CloakBrowser CLI returned invalid JSON", { cause: error });
  }

  const root = requiredRecord(parsed, "root");
  const environment = requiredRecord(root.environment, "environment");
  const wrapper = requiredString(environment.wrapper, "environment.wrapper");
  if (wrapper !== CLOAK_WRAPPER_VERSION) {
    throw new Error(
      `CloakBrowser wrapper mismatch: expected ${CLOAK_WRAPPER_VERSION}, got ${wrapper}`,
    );
  }

  const binary = requiredRecord(root.binary, "binary");
  if (binary.error !== undefined) {
    throw new Error(
      `CloakBrowser CLI could not resolve the binary: ${requiredString(binary.error, "binary.error")}`,
    );
  }
  const binaryTier = requiredString(binary.tier, "binary.tier");
  if (binaryTier !== "free" && binaryTier !== "pro" && binaryTier !== "override") {
    throw new Error(`Unsupported CloakBrowser binary tier: ${binaryTier}`);
  }

  const license = requiredRecord(root.license, "license");
  const licenseValid = license.valid;
  if (licenseValid !== undefined && typeof licenseValid !== "boolean") {
    throw new Error("CloakBrowser diagnostics field license.valid must be a boolean");
  }
  const sessions =
    license.sessions === undefined
      ? null
      : requiredRecord(license.sessions, "license.sessions");
  const rawSeatLimit = sessions?.limit;
  if (
    rawSeatLimit !== undefined &&
    (typeof rawSeatLimit !== "number" ||
      !Number.isInteger(rawSeatLimit) ||
      rawSeatLimit < 1)
  ) {
    throw new Error(
      "CloakBrowser diagnostics field license.sessions.limit must be a positive integer",
    );
  }

  return {
    environment: {
      wrapper,
      platformTag: requiredString(
        environment.platform_tag,
        "environment.platform_tag",
      ),
    },
    binary: {
      version: nullableString(binary.version, "binary.version"),
      installedVersion: optionalNullableString(
        binary.installed_version,
        "binary.installed_version",
      ),
      requestedChannel: requiredString(
        binary.requested_channel,
        "binary.requested_channel",
      ),
      resolvedChannel: optionalNullableString(
        binary.resolved_channel,
        "binary.resolved_channel",
      ),
      tier: binaryTier,
      path: nullableString(binary.path, "binary.path"),
      installed: requiredBoolean(binary.installed, "binary.installed"),
      pinned: requiredBoolean(binary.pinned, "binary.pinned"),
    },
    license: {
      tier: requiredString(license.tier, "license.tier"),
      valid: licenseValid ?? null,
      error: optionalNullableString(license.error, "license.error"),
      seatLimit:
        typeof rawSeatLimit === "number" ? rawSeatLimit : null,
    },
  };
}

function diagnosticsStatus(
  diagnostics: CloakCliDiagnostics,
  policy: CloakRuntimePolicy,
  changes: Partial<CloakRuntimeStatus>,
): CloakRuntimeStatus {
  return {
    ...initialStatus(policy),
    available: true,
    loggedIn: diagnostics.license.valid === true,
    plan: diagnostics.license.valid === true ? diagnostics.license.tier : null,
    seats: diagnostics.license.seatLimit ?? 1,
    actualVersion: diagnostics.binary.version,
    ...changes,
  };
}

/** Convert official CLI diagnostics into the application's policy/status contract. */
export function evaluateCloakDiagnosticsStatus(
  diagnostics: CloakCliDiagnostics,
  policy: CloakRuntimePolicy,
): CloakRuntimeStatus {
  const licenseTier = diagnostics.license.tier.toLowerCase();
  if (diagnostics.license.valid !== true) {
    const validationUnavailable = licenseTier === "unknown";
    return diagnosticsStatus(diagnostics, policy, {
      state: validationUnavailable ? "error" : "login-required",
      error: validationUnavailable
        ? `CloakBrowser could not validate the signed-in account${
            diagnostics.license.error ? `: ${diagnostics.license.error}` : ""
          }`
        : "Sign in with `cloakbrowser login` before using CloakBrowser",
    });
  }

  if (licenseTier === "invalid" || licenseTier === "unknown") {
    return diagnosticsStatus(diagnostics, policy, {
      state: "error",
      error: `CloakBrowser reported an invalid license tier: ${diagnostics.license.tier}`,
    });
  }
  if (diagnostics.binary.requestedChannel !== CLOAK_RELEASE_CHANNEL) {
    return diagnosticsStatus(diagnostics, policy, {
      state: "error",
      error: `CloakBrowser must use the stable release channel, got ${diagnostics.binary.requestedChannel}`,
    });
  }
  if (diagnostics.binary.tier === "override") {
    return diagnosticsStatus(diagnostics, policy, {
      state: "error",
      error: "CLOAKBROWSER_BINARY_PATH overrides are not supported by the managed Cloak runtime",
    });
  }
  if (policy === "strict" && diagnostics.binary.tier !== "pro") {
    return diagnosticsStatus(diagnostics, policy, {
      state: "error",
      error: `Strict Cloak mode requires the maintained Pro binary, got ${diagnostics.binary.tier}`,
    });
  }
  if (policy === "strict" && !diagnostics.binary.pinned) {
    return diagnosticsStatus(diagnostics, policy, {
      state: "error",
      error: "Strict Cloak mode requires a pinned browser version",
    });
  }
  if (
    policy === "strict" &&
    diagnostics.binary.version !== CLOAK_PAID_BROWSER_VERSION
  ) {
    return diagnosticsStatus(diagnostics, policy, {
      state: "error",
      error: `Strict Cloak version mismatch: expected ${CLOAK_PAID_BROWSER_VERSION}, got ${
        diagnostics.binary.version ?? "unresolved"
      }`,
    });
  }
  if (policy === "free-latest" && diagnostics.binary.pinned) {
    return diagnosticsStatus(diagnostics, policy, {
      state: "error",
      error: "Free-latest Cloak mode cannot use a pinned browser version",
    });
  }
  if (!diagnostics.binary.installed) {
    return diagnosticsStatus(diagnostics, policy, {
      state: "not-installed",
      error: null,
    });
  }
  if (!diagnostics.binary.version || !diagnostics.binary.path) {
    return diagnosticsStatus(diagnostics, policy, {
      state: "error",
      error: "CloakBrowser reported an installed binary without a version and executable path",
    });
  }
  return diagnosticsStatus(diagnostics, policy, {
    state: "ready",
    error: null,
  });
}

function cloakCliPath(): string {
  return join(
    app.getAppPath(),
    "node_modules",
    "cloakbrowser",
    "dist",
    "cli.js",
  );
}

async function readCloakDiagnostics(
  policy: CloakRuntimePolicy,
): Promise<CloakCliDiagnostics> {
  const cliPath = cloakCliPath();
  await access(cliPath, constants.F_OK);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    CLOAKBROWSER_RELEASE_CHANNEL: CLOAK_RELEASE_CHANNEL,
  };
  if (policy === "strict") {
    env.CLOAKBROWSER_VERSION = CLOAK_PAID_BROWSER_VERSION;
  }

  const stdout = await new Promise<string>((resolveOutput, rejectOutput) => {
    execFile(
      process.execPath,
      [cliPath, "info", "--quick", "--json"],
      {
        encoding: "utf8",
        env,
        windowsHide: true,
        timeout: CLOAK_CLI_TIMEOUT_MS,
        maxBuffer: CLOAK_CLI_MAX_BUFFER_BYTES,
      },
      (error, output, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          rejectOutput(
            new Error(`cloakbrowser info --quick --json failed: ${detail}`, {
              cause: error,
            }),
          );
          return;
        }
        resolveOutput(output);
      },
    );
  });
  return parseCloakInfoJson(stdout);
}

function validateProfileKey(profileKey: string, sessionId?: string): string {
  const normalized = profileKey.trim();
  if (
    !PROFILE_KEY_PATTERN.test(normalized) ||
    normalized === "." ||
    normalized === ".."
  ) {
    throw new BrowserBackendError(
      "INVALID_ARGUMENT",
      "Cloak profileKey must contain only letters, numbers, dot, underscore, or hyphen",
      { backendKind: "cloak", sessionId },
    );
  }
  return normalized;
}

function normalizeProfileIdentity(
  profile: CloakProfileIdentity,
  options: BrowserContextOptions,
): CloakProfileIdentity {
  const profileKey = validateProfileKey(profile.profileKey, options.sessionId);
  const seed = profile.seed.trim();
  if (!seed || seed.length > 256 || CONTROL_CHARACTER_PATTERN.test(seed)) {
    throw new BrowserBackendError(
      "INVALID_ARGUMENT",
      "Cloak fingerprint seed must be a non-empty string without control characters",
      { backendKind: "cloak", sessionId: options.sessionId },
    );
  }
  return { profileId: profile.profileId, profileKey, seed };
}

function stableFallbackSeed(profileKey: string): string {
  const digest = createHash("sha256").update(profileKey).digest();
  return String((digest.readUInt32BE(0) % 90_000) + 10_000);
}

function defaultProfileIdentity(
  options: BrowserContextOptions,
): CloakProfileIdentity {
  const backendOptions = options.backendOptions ?? {};
  const profileKey =
    optionalString(backendOptions.profileKey) ??
    optionalString(backendOptions.profile_key) ??
    options.profileId ??
    options.sessionId;
  const seed =
    optionalString(backendOptions.cloakSeed) ??
    optionalString(backendOptions.cloak_seed) ??
    stableFallbackSeed(profileKey);
  return {
    profileId: options.profileId ?? null,
    profileKey,
    seed,
  };
}

function toCloakProxy(options: BrowserContextOptions): CloakProxy | undefined {
  const proxy = options.proxy;
  if (!proxy || proxy.type === "none") return undefined;
  const host = proxy.host.trim();
  if (!host || !Number.isInteger(proxy.port) || proxy.port < 1 || proxy.port > 65_535) {
    throw new BrowserBackendError(
      "INVALID_ARGUMENT",
      "Proxy host and port are invalid",
      { backendKind: "cloak", sessionId: options.sessionId },
    );
  }
  return {
    server: `${proxy.type}://${host}:${proxy.port}`,
    ...(proxy.username ? { username: proxy.username } : {}),
    ...(proxy.password ? { password: proxy.password } : {}),
  };
}

/** Build deterministic launch options without consulting credentials or the network. */
export function buildCloakLaunchOptions(
  userDataDir: string,
  profile: Readonly<CloakProfileIdentity>,
  options: Readonly<BrowserContextOptions>,
  requestedVersion?: string,
): CloakLaunchOptions {
  const proxy = toCloakProxy(options);
  return {
    userDataDir,
    headless: false,
    humanize: true,
    releaseChannel: CLOAK_RELEASE_CHANNEL,
    ...(requestedVersion ? { browserVersion: requestedVersion } : {}),
    args: [
      `--fingerprint=${profile.seed}`,
      // Chromium otherwise inherits the host's system proxy configuration.
      ...(proxy ? [] : ["--no-proxy-server"]),
    ],
    geoip: Boolean(proxy),
    ...(proxy ? { proxy } : {}),
    contextOptions: { acceptDownloads: true },
  };
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const normalized = resolve(value);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  return normalize(left) === normalize(right);
}

function isWithin(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent === "" ||
    (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent))
  );
}

function initialStatus(policy: CloakRuntimePolicy): CloakRuntimeStatus {
  return {
    available: true,
    state: "not-installed",
    loggedIn: false,
    plan: null,
    seats: 1,
    policy,
    configuredVersion:
      policy === "strict" ? CLOAK_PAID_BROWSER_VERSION : null,
    actualVersion: null,
    error: null,
    errorCode: null,
    downloadProgress: null,
  };
}

export class CloakRuntimeContext {
  readonly id = randomUUID();
  readonly profileId: string | null;
  readonly profileKey: string;
  readonly userDataDir: string;
  readonly browserVersion: string;
  readonly binaryStatus: Readonly<CloakBinaryStatus>;
  readonly createdAt = Date.now();

  private closed = false;
  private closePromise: Promise<void> | null = null;
  private lastUsed = this.createdAt;

  constructor(
    readonly nativeContext: PlaywrightBrowserContext,
    profile: CloakProfileIdentity,
    userDataDir: string,
    status: CloakBinaryStatus,
    readonly sessionId: string,
    private readonly handleTouch: (context: CloakRuntimeContext) => void,
    private readonly handleClose: (context: CloakRuntimeContext) => void,
  ) {
    this.profileId = profile.profileId;
    this.profileKey = profile.profileKey;
    this.userDataDir = userDataDir;
    this.browserVersion = status.actualVersion;
    this.binaryStatus = Object.freeze(status);
    nativeContext.once("close", () => this.markClosed());
  }

  get lastUsedAt(): number {
    return this.lastUsed;
  }

  isClosed(): boolean {
    return this.closed;
  }

  touch(): void {
    if (this.closed) return;
    this.lastUsed = Date.now();
    this.handleTouch(this);
  }

  snapshot(): CloakRuntimeContextSnapshot {
    return {
      id: this.id,
      sessionId: this.sessionId,
      profileId: this.profileId,
      profileKey: this.profileKey,
      userDataDir: this.userDataDir,
      browserVersion: this.browserVersion,
      createdAt: this.createdAt,
      lastUsedAt: this.lastUsed,
      closed: this.closed,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.closePromise) return this.closePromise;
    // Defer the native call until closePromise is assigned so a synchronous
    // throw cannot leave a permanently rejected promise cached here.
    const closeAttempt = Promise.resolve().then(async () => {
      try {
        await this.nativeContext.close();
        this.markClosed();
      } catch (error) {
        if (this.nativeContext.browser()?.isConnected() === false) {
          this.markClosed();
          return;
        }
        throw error;
      }
    });
    this.closePromise = closeAttempt;
    try {
      await closeAttempt;
    } finally {
      if (this.closePromise === closeAttempt) this.closePromise = null;
    }
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.lastUsed = Date.now();
    this.handleClose(this);
  }
}

export class CloakRuntime {
  private readonly contexts = new Map<string, CloakRuntimeContext>();
  private readonly openingSessions = new Set<string>();
  private readonly openingBarriers = new Set<Promise<void>>();
  private readonly reservedProfiles = new Map<string, string>();
  private readonly statusListeners = new Set<(status: CloakRuntimeStatus) => void>();
  private state: "idle" | "started" | "shutting-down" | "stopped" = "idle";
  private status: CloakRuntimeStatus;
  private prepared: PreparedRuntime | null = null;
  private preparePromise: Promise<CloakRuntimeStatus> | null = null;
  private diagnosticsPromise: Promise<CloakRuntimeStatus> | null = null;
  private shutdownPromise: Promise<void> | null = null;

  constructor(private readonly options: CloakRuntimeOptions = {}) {
    this.status = initialStatus(options.policy ?? "strict");
    if (options.onStatusChanged) this.statusListeners.add(options.onStatusChanged);
  }

  start(): void {
    if (this.state === "shutting-down") {
      throw new BrowserBackendError(
        "BACKEND_SHUTTING_DOWN",
        "Cloak runtime is shutting down",
        { backendKind: "cloak" },
      );
    }
    this.state = "started";
  }

  getStatus(): CloakRuntimeStatus {
    return {
      ...this.status,
      downloadProgress: this.status.downloadProgress
        ? { ...this.status.downloadProgress }
        : null,
    };
  }

  onStatus(listener: (status: CloakRuntimeStatus) => void): Unsubscribe {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Refresh account, seat, and installed-binary state without downloading. */
  async check(): Promise<CloakRuntimeStatus> {
    this.assertRuntimeWorkAllowed();
    if (this.preparePromise) return this.getStatus();
    if (this.diagnosticsPromise) return this.diagnosticsPromise;
    const policy = this.status.policy;
    this.updateStatus({
      state: "checking",
      error: null,
      downloadProgress: null,
      configuredVersion:
        policy === "strict" ? CLOAK_PAID_BROWSER_VERSION : null,
    });
    this.diagnosticsPromise = readCloakDiagnostics(policy)
      .then((diagnostics) => {
        const status = evaluateCloakDiagnosticsStatus(diagnostics, policy);
        if (
          status.state !== "ready" ||
          this.prepared?.status.actualVersion !== status.actualVersion
        ) {
          this.prepared = null;
        }
        this.updateStatus(status);
        return this.getStatus();
      })
      .catch((error: unknown) => {
        this.prepared = null;
        this.updateStatus({
          available: false,
          state: "error",
          loggedIn: false,
          plan: null,
          actualVersion: null,
          error: `Unable to run CloakBrowser account diagnostics: ${errorMessage(error)}`,
          downloadProgress: null,
        });
        return this.getStatus();
      })
      .finally(() => {
        this.diagnosticsPromise = null;
      });
    return this.diagnosticsPromise;
  }

  async setPolicy(policy: CloakRuntimePolicy): Promise<CloakRuntimeStatus> {
    this.assertRuntimeWorkAllowed();
    if (policy !== "strict" && policy !== "free-latest") {
      throw new BrowserBackendError(
        "INVALID_ARGUMENT",
        `Unsupported Cloak runtime policy: ${String(policy)}`,
        { backendKind: "cloak" },
      );
    }
    if (this.preparePromise || this.diagnosticsPromise) {
      throw new BrowserBackendError(
        "BACKEND_FAILURE",
        "Cannot change Cloak runtime policy while diagnostics or preparation is in progress",
        { backendKind: "cloak" },
      );
    }
    if (this.status.policy === policy) return this.getStatus();
    this.prepared = null;
    this.updateStatus({
      ...initialStatus(policy),
      available: this.status.available,
      seats: this.status.seats,
    });
    return this.getStatus();
  }

  async prepare(policy: CloakRuntimePolicy = this.status.policy): Promise<CloakRuntimeStatus> {
    this.assertRuntimeWorkAllowed();
    if (this.diagnosticsPromise) await this.diagnosticsPromise;
    this.assertRuntimeWorkAllowed();
    if (policy !== this.status.policy) await this.setPolicy(policy);
    this.assertRuntimeWorkAllowed();
    if (this.prepared && this.status.state === "ready") return this.getStatus();
    if (this.preparePromise) return this.preparePromise;
    this.preparePromise = this.prepareRuntime().finally(() => {
      this.preparePromise = null;
    });
    return this.preparePromise;
  }

  getContext(sessionId: string): CloakRuntimeContext | null {
    const context = this.contexts.get(sessionId);
    return context && !context.isClosed() ? context : null;
  }

  listContexts(): readonly CloakRuntimeContextSnapshot[] {
    return [...this.contexts.values()].map((context) => context.snapshot());
  }

  touchContext(sessionId: string): void {
    this.getContext(sessionId)?.touch();
  }

  async getProfileDirectory(profileKey: string): Promise<string> {
    const key = validateProfileKey(profileKey);
    const root = await this.resolveProfileRoot();
    const profileDir = join(root, key);
    if (!isWithin(root, profileDir) || samePath(root, profileDir)) {
      throw new BrowserBackendError(
        "INVALID_ARGUMENT",
        "Resolved Cloak profile directory escaped profileRoot",
        { backendKind: "cloak" },
      );
    }
    return profileDir;
  }

  async deleteProfile(profileKey: string): Promise<void> {
    const key = validateProfileKey(profileKey);
    const owner = this.reservedProfiles.get(key);
    if (owner) {
      throw new BrowserBackendError(
        "BACKEND_FAILURE",
        `Cannot delete Cloak profile ${key} while session ${owner} is using it`,
        { backendKind: "cloak", sessionId: owner },
      );
    }

    const profileDir = await this.getProfileDirectory(key);
    let stats;
    try {
      stats = await lstat(profileDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw backendFailure(
        `Failed to inspect Cloak profile ${key}: ${errorMessage(error)}`,
        undefined,
        error,
      );
    }
    if (stats.isSymbolicLink()) {
      throw new BrowserBackendError(
        "INVALID_ARGUMENT",
        `Refusing to recursively delete symlinked Cloak profile ${key}`,
        { backendKind: "cloak" },
      );
    }

    const root = await this.resolveProfileRoot();
    const realProfileDir = await realpath(profileDir);
    if (!isWithin(root, realProfileDir) || samePath(root, realProfileDir)) {
      throw new BrowserBackendError(
        "INVALID_ARGUMENT",
        `Refusing to delete Cloak profile ${key} outside profileRoot`,
        { backendKind: "cloak" },
      );
    }
    try {
      await rm(profileDir, { recursive: true, force: false, maxRetries: 2 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw backendFailure(
        `Failed to delete Cloak profile ${key}: ${errorMessage(error)}`,
        undefined,
        error,
      );
    }
  }

  async openContext(
    contextOptions: BrowserContextOptions,
  ): Promise<CloakRuntimeContext> {
    this.assertStarted(contextOptions);
    if (!contextOptions.sessionId.trim()) {
      throw new BrowserBackendError(
        "INVALID_ARGUMENT",
        "Cloak context requires a non-empty sessionId",
        { backendKind: "cloak" },
      );
    }
    if (
      this.contexts.has(contextOptions.sessionId) ||
      this.openingSessions.has(contextOptions.sessionId)
    ) {
      throw backendFailure(
        `A Cloak context already exists for session ${contextOptions.sessionId}`,
        contextOptions,
      );
    }

    this.openingSessions.add(contextOptions.sessionId);
    let finishOpening!: () => void;
    const openingBarrier = new Promise<void>((resolveBarrier) => {
      finishOpening = resolveBarrier;
    });
    this.openingBarriers.add(openingBarrier);
    let profile: CloakProfileIdentity | null = null;
    try {
      profile = await this.resolveProfile(contextOptions);
      const owner = this.reservedProfiles.get(profile.profileKey);
      if (owner && owner !== contextOptions.sessionId) {
        throw backendFailure(
          `Cloak profile ${profile.profileKey} is already open by another session`,
          contextOptions,
        );
      }
      this.reservedProfiles.set(profile.profileKey, contextOptions.sessionId);

      const prepared = await this.prepareLaunch(contextOptions);
      const userDataDir = await this.prepareProfileDirectory(profile, contextOptions);
      this.assertStarted(contextOptions);
      const nativeContext = await prepared.api.launchPersistentContext(
        buildCloakLaunchOptions(
          userDataDir,
          profile,
          contextOptions,
          prepared.requestedVersion,
        ),
      );

      const runtimeContext = new CloakRuntimeContext(
        nativeContext,
        profile,
        userDataDir,
        prepared.status,
        contextOptions.sessionId,
        (context) => this.handleContextTouch(context),
        (context) => this.handleContextClose(context),
      );
      // Register before checking shutdown state. If closing a late launch fails,
      // shutdown must retain the Context and profile reservation for a retry.
      this.contexts.set(contextOptions.sessionId, runtimeContext);

      if (this.state !== "started") {
        await runtimeContext.close();
        throw new BrowserBackendError(
          "OPERATION_ABORTED",
          "Cloak context launch finished after shutdown began",
          { backendKind: "cloak", sessionId: contextOptions.sessionId },
        );
      }

      runtimeContext.touch();
      this.notifyBrowserVersion(runtimeContext, prepared.status);
      return runtimeContext;
    } catch (error) {
      if (error instanceof BrowserBackendError) throw error;
      throw backendFailure(
        `Failed to launch CloakBrowser: ${errorMessage(error)}`,
        contextOptions,
        error,
      );
    } finally {
      finishOpening();
      this.openingBarriers.delete(openingBarrier);
      this.openingSessions.delete(contextOptions.sessionId);
      if (profile && !this.contexts.has(contextOptions.sessionId)) {
        if (this.reservedProfiles.get(profile.profileKey) === contextOptions.sessionId) {
          this.reservedProfiles.delete(profile.profileKey);
        }
      }
    }
  }

  async closeContext(sessionId: string): Promise<void> {
    const context = this.contexts.get(sessionId);
    if (!context) return;
    try {
      await context.close();
    } catch (error) {
      throw new BrowserBackendError(
        "BACKEND_FAILURE",
        `Failed to close Cloak context: ${errorMessage(error)}`,
        {
          backendKind: "cloak",
          sessionId,
          contextId: context.id,
          cause: error,
        },
      );
    }
  }

  shutdown(): Promise<void> {
    if (this.state === "stopped") return Promise.resolve();
    if (this.shutdownPromise) return this.shutdownPromise;
    this.state = "shutting-down";

    const attempt = this.performShutdown();
    const trackedAttempt = attempt.finally(() => {
      if (this.shutdownPromise === trackedAttempt) this.shutdownPromise = null;
    });
    this.shutdownPromise = trackedAttempt;
    return trackedAttempt;
  }

  private async performShutdown(): Promise<void> {
    await this.waitForInFlightWork();
    const results = await Promise.allSettled(
      [...this.contexts.values()].map((context) => context.close()),
    );
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length) {
      throw new BrowserBackendError(
        "BACKEND_FAILURE",
        `Failed to close ${failures.length} Cloak browser context(s)`,
        { backendKind: "cloak", cause: failures[0].reason },
      );
    }
    this.state = "stopped";
  }

  private async waitForInFlightWork(): Promise<void> {
    for (;;) {
      const pending = new Set<Promise<unknown>>();
      if (this.diagnosticsPromise) pending.add(this.diagnosticsPromise);
      if (this.preparePromise) pending.add(this.preparePromise);
      for (const opening of this.openingBarriers) pending.add(opening);
      if (pending.size === 0) return;
      await Promise.allSettled(pending);
    }
  }

  private async prepareRuntime(): Promise<CloakRuntimeStatus> {
    const policy = this.status.policy;
    this.updateStatus({
      state: "checking",
      error: null,
      downloadProgress: null,
      configuredVersion:
        policy === "strict" ? CLOAK_PAID_BROWSER_VERSION : null,
    });

    let beforeDiagnostics: CloakCliDiagnostics;
    try {
      beforeDiagnostics = await readCloakDiagnostics(policy);
    } catch (error) {
      this.prepared = null;
      this.updateStatus({
        available: false,
        state: "error",
        loggedIn: false,
        plan: null,
        actualVersion: null,
        error: `Unable to run CloakBrowser account diagnostics: ${errorMessage(error)}`,
        downloadProgress: null,
      });
      throw backendFailure(
        this.status.error ?? "CloakBrowser diagnostics are unavailable",
        undefined,
        error,
      );
    }
    this.assertRuntimeWorkAllowed();

    const beforeStatus = evaluateCloakDiagnosticsStatus(beforeDiagnostics, policy);
    if (beforeStatus.state === "login-required" || beforeStatus.state === "error") {
      this.prepared = null;
      this.updateStatus(beforeStatus);
      throw backendFailure(beforeStatus.error ?? "CloakBrowser account is not ready");
    }
    this.updateStatus({
      ...beforeStatus,
      state:
        beforeStatus.state === "not-installed" ? "downloading" : "checking",
      downloadProgress:
        beforeStatus.state === "not-installed" ? { percent: 0 } : null,
    });

    let api: CloakModule;
    try {
      api = await loadCloakModule();
    } catch (error) {
      this.prepared = null;
      this.updateStatus({
        available: false,
        state: "unavailable",
        error: `Unable to load cloakbrowser ${CLOAK_WRAPPER_VERSION}: ${errorMessage(error)}`,
        downloadProgress: null,
      });
      throw backendFailure(
        this.status.error ?? "CloakBrowser is unavailable",
        undefined,
        error,
      );
    }
    this.assertRuntimeWorkAllowed();

    const requestedVersion =
      policy === "strict" ? CLOAK_PAID_BROWSER_VERSION : undefined;

    let executablePath: string;
    try {
      // The official wrapper owns credential lookup and validation. The app never
      // reads a key or supplies the licenseKey argument.
      executablePath = await api.ensureBinary(
        undefined,
        requestedVersion,
        CLOAK_RELEASE_CHANNEL,
      );
      await access(executablePath, constants.F_OK);
    } catch (error) {
      this.prepared = null;
      this.updateStatus({
        state: "error",
        error: `CloakBrowser binary is unavailable: ${errorMessage(error)}`,
        downloadProgress: null,
      });
      throw backendFailure(this.status.error ?? "CloakBrowser binary is unavailable", undefined, error);
    }
    this.assertRuntimeWorkAllowed();

    let afterDiagnostics: CloakCliDiagnostics;
    try {
      afterDiagnostics = await readCloakDiagnostics(policy);
    } catch (error) {
      this.prepared = null;
      this.updateStatus({
        state: "error",
        error: `Unable to verify CloakBrowser after installation: ${errorMessage(error)}`,
        downloadProgress: null,
      });
      throw backendFailure(
        this.status.error ?? "CloakBrowser verification failed",
        undefined,
        error,
      );
    }
    this.assertRuntimeWorkAllowed();

    const afterStatus = evaluateCloakDiagnosticsStatus(afterDiagnostics, policy);
    if (afterStatus.state !== "ready") {
      this.prepared = null;
      const error =
        afterStatus.error ??
        "CloakBrowser binary is still not installed after preparation";
      this.updateStatus({
        ...afterStatus,
        state: "error",
        error,
        downloadProgress: null,
      });
      throw backendFailure(error);
    }

    const diagnosedPath = afterDiagnostics.binary.path;
    const actualVersion = afterDiagnostics.binary.version;
    if (!diagnosedPath || !actualVersion) {
      throw backendFailure(
        "CloakBrowser diagnostics omitted the prepared executable or version",
      );
    }
    const binaryInfo = api.binaryInfo(requestedVersion, CLOAK_RELEASE_CHANNEL);
    if (
      !samePath(diagnosedPath, executablePath) ||
      !samePath(binaryInfo.binaryPath, executablePath)
    ) {
      this.prepared = null;
      this.updateStatus({
        state: "error",
        error: "CloakBrowser binary status does not match the selected executable",
        downloadProgress: null,
      });
      throw backendFailure(this.status.error ?? "CloakBrowser binary status mismatch");
    }

    const binaryStatus: CloakBinaryStatus = {
      wrapperVersion: afterDiagnostics.environment.wrapper,
      mode: policy,
      licensePlan: afterDiagnostics.license.tier,
      releaseChannel: CLOAK_RELEASE_CHANNEL,
      requestedVersion: requestedVersion ?? null,
      actualVersion,
      executablePath,
      binaryInfo,
    };
    this.prepared = { api, policy, requestedVersion, status: binaryStatus };
    this.updateStatus({
      ...afterStatus,
      downloadProgress: null,
    });
    return this.getStatus();
  }

  private async prepareLaunch(options: BrowserContextOptions): Promise<PreparedRuntime> {
    try {
      // Re-run the wrapper's own key validation before every launch. A prior
      // prepare can become stale after login/logout without restarting the app.
      this.prepared = null;
      await this.prepare(this.status.policy);
    } catch (error) {
      if (error instanceof BrowserBackendError) {
        throw backendFailure(error.message, options, error);
      }
      throw error;
    }
    if (!this.prepared || this.status.state !== "ready") {
      throw backendFailure("CloakBrowser runtime is not ready", options);
    }
    return this.prepared;
  }

  private assertStarted(options: BrowserContextOptions): void {
    if (this.state === "shutting-down") {
      throw new BrowserBackendError(
        "BACKEND_SHUTTING_DOWN",
        "Cloak runtime is shutting down",
        { backendKind: "cloak", sessionId: options.sessionId },
      );
    }
    if (this.state !== "started") {
      throw new BrowserBackendError(
        "BACKEND_NOT_STARTED",
        "Cloak runtime has not been started",
        { backendKind: "cloak", sessionId: options.sessionId },
      );
    }
  }

  private assertRuntimeWorkAllowed(): void {
    if (this.state === "shutting-down") {
      throw new BrowserBackendError(
        "BACKEND_SHUTTING_DOWN",
        "Cloak runtime is shutting down",
        { backendKind: "cloak" },
      );
    }
    if (this.state === "stopped") {
      throw new BrowserBackendError(
        "BACKEND_NOT_STARTED",
        "Cloak runtime has been stopped",
        { backendKind: "cloak" },
      );
    }
  }

  private async resolveProfile(
    options: BrowserContextOptions,
  ): Promise<CloakProfileIdentity> {
    try {
      const resolved = this.options.resolveProfile
        ? await this.options.resolveProfile(Object.freeze({ ...options }))
        : defaultProfileIdentity(options);
      return normalizeProfileIdentity(resolved, options);
    } catch (error) {
      if (error instanceof BrowserBackendError) throw error;
      throw backendFailure(
        `Failed to resolve Cloak profile: ${errorMessage(error)}`,
        options,
        error,
      );
    }
  }

  private async resolveProfileRoot(): Promise<string> {
    if (!app.isReady()) {
      throw backendFailure("Electron app must be ready before accessing Cloak profiles");
    }
    if (
      this.options.profileRoot &&
      this.options.profilesRoot &&
      !samePath(this.options.profileRoot, this.options.profilesRoot)
    ) {
      throw new BrowserBackendError(
        "INVALID_ARGUMENT",
        "profileRoot and profilesRoot cannot point to different directories",
        { backendKind: "cloak" },
      );
    }

    const userData = resolve(app.getPath("userData"));
    const configured = this.options.profilesRoot ?? this.options.profileRoot;
    const configuredRoot = configured
      ? resolve(configured)
      : join(userData, "browser-profiles", "cloak");
    if (!isWithin(userData, configuredRoot)) {
      throw new BrowserBackendError(
        "INVALID_ARGUMENT",
        "Cloak profilesRoot must be inside Electron's userData directory",
        { backendKind: "cloak" },
      );
    }
    await mkdir(configuredRoot, { recursive: true });
    const realRoot = await realpath(configuredRoot);
    if (!isWithin(userData, realRoot)) {
      throw new BrowserBackendError(
        "INVALID_ARGUMENT",
        "Resolved Cloak profilesRoot escaped Electron's userData directory",
        { backendKind: "cloak" },
      );
    }
    return realRoot;
  }

  private async prepareProfileDirectory(
    profile: CloakProfileIdentity,
    options: BrowserContextOptions,
  ): Promise<string> {
    const root = await this.resolveProfileRoot();
    const profileDir = join(root, profile.profileKey);
    const requireExisting = options.backendOptions?.requireExistingProfile === true;
    try {
      const stats = await lstat(profileDir);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new BrowserBackendError(
          "PROFILE_MISSING",
          "The saved Cloak profile path is not a regular directory",
          { backendKind: "cloak", sessionId: options.sessionId },
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (requireExisting) {
        throw new BrowserBackendError(
          "PROFILE_MISSING",
          `The saved Cloak profile ${profile.profileKey} is missing`,
          { backendKind: "cloak", sessionId: options.sessionId },
        );
      }
      await mkdir(profileDir, { recursive: false });
    }
    const realProfileDir = await realpath(profileDir);
    if (!isWithin(root, realProfileDir) || samePath(root, realProfileDir)) {
      throw new BrowserBackendError(
        "INVALID_ARGUMENT",
        "Resolved Cloak profile directory escaped profileRoot",
        { backendKind: "cloak", sessionId: options.sessionId },
      );
    }
    return realProfileDir;
  }

  private updateStatus(changes: Partial<CloakRuntimeStatus>): void {
    this.status = { ...this.status, ...changes };
    const snapshot = this.getStatus();
    for (const listener of this.statusListeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.error("Cloak runtime status listener failed", error);
      }
    }
  }

  private handleContextTouch(context: CloakRuntimeContext): void {
    const callback = this.options.onProfileTouched;
    if (!callback) return;
    Promise.resolve()
      .then(() =>
        callback({
          sessionId: context.sessionId,
          profileId: context.profileId,
          profileKey: context.profileKey,
          userDataDir: context.userDataDir,
          lastUsedAt: context.lastUsedAt,
        }),
      )
      .catch((error: unknown) => {
        console.warn(
          `[cloakbrowser] Failed to persist profile last-used metadata: ${errorMessage(error)}`,
        );
      });
  }

  private notifyBrowserVersion(
    context: CloakRuntimeContext,
    status: CloakBinaryStatus,
  ): void {
    const callback = this.options.onBrowserVersionResolved;
    if (!callback) return;
    Promise.resolve()
      .then(() =>
        callback({
          sessionId: context.sessionId,
          version: status.actualVersion,
          mode: status.mode,
          licensePlan: status.licensePlan,
        }),
      )
      .catch((error: unknown) => {
        console.warn(
          `[cloakbrowser] Failed to persist resolved browser version: ${errorMessage(error)}`,
        );
      });
  }

  private handleContextClose(context: CloakRuntimeContext): void {
    if (this.contexts.get(context.sessionId) === context) {
      this.contexts.delete(context.sessionId);
    }
    if (this.reservedProfiles.get(context.profileKey) === context.sessionId) {
      this.reservedProfiles.delete(context.profileKey);
    }
  }
}
