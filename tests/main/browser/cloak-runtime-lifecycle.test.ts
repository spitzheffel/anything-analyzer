import type { BrowserContext as PlaywrightBrowserContext } from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => {
  const ensureBinary = vi.fn();
  const launchPersistentContext = vi.fn();
  const binaryInfo = vi.fn();
  return {
    access: vi.fn(),
    execFile: vi.fn(),
    lstat: vi.fn(),
    mkdir: vi.fn(),
    realpath: vi.fn(),
    rm: vi.fn(),
    ensureBinary,
    launchPersistentContext,
    binaryInfo,
    cloakModuleFactory: vi.fn(() => ({
      CHROMIUM_VERSION: "unused",
      ensureBinary,
      launchPersistentContext,
      binaryInfo,
    })),
  };
});

vi.mock("electron", () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    isReady: () => true,
  },
}));

vi.mock("node:child_process", () => ({
  execFile: runtimeMocks.execFile,
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  access: runtimeMocks.access,
  lstat: runtimeMocks.lstat,
  mkdir: runtimeMocks.mkdir,
  realpath: runtimeMocks.realpath,
  rm: runtimeMocks.rm,
}));

vi.mock("cloakbrowser", runtimeMocks.cloakModuleFactory);

import {
  CLOAK_PAID_BROWSER_VERSION,
  CLOAK_WRAPPER_VERSION,
  CloakRuntime,
} from "../../../src/main/browser/cloak-runtime";

const BINARY_PATH = `C:\\cloakbrowser\\chromium-${CLOAK_PAID_BROWSER_VERSION}-pro\\chrome.exe`;

function quickDiagnosticsJson(): string {
  return JSON.stringify({
    environment: {
      wrapper: CLOAK_WRAPPER_VERSION,
      platform_tag: "windows-x64",
    },
    binary: {
      version: CLOAK_PAID_BROWSER_VERSION,
      installed_version: CLOAK_PAID_BROWSER_VERSION,
      requested_channel: "stable",
      resolved_channel: null,
      tier: "pro",
      path: BINARY_PATH,
      installed: true,
      pinned: true,
    },
    license: {
      tier: "free",
      valid: true,
      error: null,
    },
    launch: { tested: false, reason: "skipped (--quick)" },
  });
}

function completeDiagnosticsImmediately(): void {
  runtimeMocks.execFile.mockImplementation(
    (
      _executable: unknown,
      _args: unknown,
      _options: unknown,
      callback: unknown,
    ) => {
      (callback as (error: Error | null, stdout: string, stderr: string) => void)(
        null,
        quickDiagnosticsJson(),
        "",
      );
      return {};
    },
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("CloakRuntime lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.access.mockResolvedValue(undefined);
    runtimeMocks.mkdir.mockResolvedValue(undefined);
    runtimeMocks.realpath.mockImplementation(async (path: unknown) => String(path));
    runtimeMocks.rm.mockResolvedValue(undefined);
    runtimeMocks.lstat.mockRejectedValue(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );
    runtimeMocks.ensureBinary.mockResolvedValue(BINARY_PATH);
    runtimeMocks.binaryInfo.mockReturnValue({ binaryPath: BINARY_PATH });
  });

  it("waits for an in-flight quick diagnostic before completing shutdown", async () => {
    let completeDiagnostics!: () => void;
    runtimeMocks.execFile.mockImplementation(
      (
        _executable: unknown,
        _args: unknown,
        _options: unknown,
        callback: unknown,
      ) => {
        completeDiagnostics = () => {
          (callback as (error: Error | null, stdout: string, stderr: string) => void)(
            null,
            quickDiagnosticsJson(),
            "",
          );
        };
        return {};
      },
    );
    const runtime = new CloakRuntime({ policy: "strict" });

    const checking = runtime.check();
    const shuttingDown = runtime.shutdown();
    let shutdownSettled = false;
    void shuttingDown.then(() => {
      shutdownSettled = true;
    });

    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    completeDiagnostics();
    await expect(checking).resolves.toMatchObject({ state: "ready", seats: 1 });
    await expect(shuttingDown).resolves.toBeUndefined();
    await expect(runtime.check()).rejects.toMatchObject({
      code: "BACKEND_NOT_STARTED",
    });
  });

  it("waits for ensureBinary and aborts the remaining prepare work during shutdown", async () => {
    completeDiagnosticsImmediately();
    const binary = deferred<string>();
    runtimeMocks.ensureBinary.mockReturnValue(binary.promise);
    const runtime = new CloakRuntime({ policy: "strict" });

    const preparing = runtime.prepare();
    await vi.waitFor(() => {
      expect(runtimeMocks.ensureBinary).toHaveBeenCalledTimes(1);
    });

    const shuttingDown = runtime.shutdown();
    let shutdownSettled = false;
    void shuttingDown.then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    expect(shutdownSettled).toBe(false);

    binary.resolve(BINARY_PATH);
    await expect(preparing).rejects.toMatchObject({
      code: "BACKEND_SHUTTING_DOWN",
    });
    await expect(shuttingDown).resolves.toBeUndefined();
    expect(runtimeMocks.execFile).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.launchPersistentContext).not.toHaveBeenCalled();
  });

  it("retains a failed close for a later shutdown retry", async () => {
    completeDiagnosticsImmediately();
    const nativeClose = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("browser is still busy");
      })
      .mockResolvedValueOnce(undefined);
    const nativeContext = {
      once: vi.fn(),
      close: nativeClose,
      browser: vi.fn(() => ({ isConnected: () => true })),
    } as unknown as PlaywrightBrowserContext;
    runtimeMocks.launchPersistentContext.mockResolvedValue(nativeContext);
    const runtime = new CloakRuntime({ policy: "strict" });
    runtime.start();

    const context = await runtime.openContext({
      sessionId: "session-1",
      profileId: "profile-1",
      backendOptions: {
        profileKey: "profile-1",
        cloakSeed: "12345",
      },
    });

    await expect(runtime.shutdown()).rejects.toMatchObject({
      code: "BACKEND_FAILURE",
    });
    expect(runtime.getContext("session-1")).toBe(context);
    expect(runtime.listContexts()).toEqual([
      expect.objectContaining({ sessionId: "session-1", closed: false }),
    ]);
    await expect(runtime.deleteProfile("profile-1")).rejects.toThrow(
      /while session session-1 is using it/i,
    );

    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(nativeClose).toHaveBeenCalledTimes(2);
    expect(runtime.getContext("session-1")).toBeNull();
    expect(runtime.listContexts()).toEqual([]);
    await expect(runtime.deleteProfile("profile-1")).resolves.toBeUndefined();
  });

  it("tracks a late launch whose shutdown cleanup fails", async () => {
    completeDiagnosticsImmediately();
    const launched = deferred<PlaywrightBrowserContext>();
    runtimeMocks.launchPersistentContext.mockReturnValue(launched.promise);
    const nativeClose = vi
      .fn()
      .mockRejectedValueOnce(new Error("late launch cleanup failed"))
      .mockRejectedValueOnce(new Error("shutdown retry failed"))
      .mockResolvedValueOnce(undefined);
    const nativeContext = {
      once: vi.fn(),
      close: nativeClose,
      browser: vi.fn(() => ({ isConnected: () => true })),
    } as unknown as PlaywrightBrowserContext;
    const runtime = new CloakRuntime({ policy: "strict" });
    runtime.start();

    const opening = runtime.openContext({
      sessionId: "late-session",
      profileId: "late-profile",
      backendOptions: {
        profileKey: "late-profile",
        cloakSeed: "54321",
      },
    });
    await vi.waitFor(() => {
      expect(runtimeMocks.launchPersistentContext).toHaveBeenCalledTimes(1);
    });
    const openingResult = expect(opening).rejects.toMatchObject({
      code: "BACKEND_FAILURE",
    });

    const firstShutdown = runtime.shutdown();
    launched.resolve(nativeContext);

    await openingResult;
    await expect(firstShutdown).rejects.toMatchObject({ code: "BACKEND_FAILURE" });
    expect(nativeClose).toHaveBeenCalledTimes(2);
    expect(runtime.listContexts()).toEqual([
      expect.objectContaining({ sessionId: "late-session", closed: false }),
    ]);
    await expect(runtime.deleteProfile("late-profile")).rejects.toThrow(
      /while session late-session is using it/i,
    );

    await expect(runtime.shutdown()).resolves.toBeUndefined();
    expect(nativeClose).toHaveBeenCalledTimes(3);
    expect(runtime.listContexts()).toEqual([]);
    await expect(runtime.deleteProfile("late-profile")).resolves.toBeUndefined();
  });
});
