import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => {
  const ensureBinary = vi.fn();
  const launchPersistentContext = vi.fn();
  const binaryInfo = vi.fn();
  return {
    access: vi.fn(),
    execFile: vi.fn(),
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
}));

vi.mock("cloakbrowser", runtimeMocks.cloakModuleFactory);

import {
  CLOAK_PAID_BROWSER_VERSION,
  CLOAK_WRAPPER_VERSION,
  CloakRuntime,
} from "../../../src/main/browser/cloak-runtime";

function diagnosticsJson(options: { loggedIn?: boolean } = {}): string {
  const loggedIn = options.loggedIn ?? true;
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
      path: `C:\\cloakbrowser\\chromium-${CLOAK_PAID_BROWSER_VERSION}-pro\\chrome.exe`,
      installed: true,
      pinned: true,
    },
    license: {
      tier: "free",
      valid: loggedIn,
      error: null,
    },
    launch: { tested: false, reason: "skipped (--quick)" },
  });
}

describe("CloakRuntime status checks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeMocks.access.mockResolvedValue(undefined);
  });

  it("actively re-runs read-only diagnostics without loading or launching Cloak", async () => {
    const outputs = [
      diagnosticsJson({ loggedIn: true }),
      diagnosticsJson({ loggedIn: false }),
    ];
    runtimeMocks.execFile.mockImplementation(
      (
        _executable: unknown,
        _args: unknown,
        _options: unknown,
        callback: unknown,
      ) => {
        (callback as (error: Error | null, stdout: string, stderr: string) => void)(
          null,
          outputs.shift()!,
          "",
        );
        return {};
      },
    );
    const states: string[] = [];
    const runtime = new CloakRuntime({
      policy: "strict",
      onStatusChanged: (status) => states.push(status.state),
    });

    await expect(runtime.check()).resolves.toMatchObject({
      state: "ready",
      loggedIn: true,
      seats: 1,
    });
    await expect(runtime.check()).resolves.toMatchObject({
      state: "login-required",
      loggedIn: false,
      seats: 1,
    });

    expect(runtimeMocks.execFile).toHaveBeenCalledTimes(2);
    for (const call of runtimeMocks.execFile.mock.calls) {
      expect(call[1]).toEqual([
        expect.stringMatching(/cloakbrowser[\\/]dist[\\/]cli\.js$/),
        "info",
        "--quick",
        "--json",
      ]);
      expect(call[1]).not.toContain("login");
    }
    expect(states).toEqual([
      "checking",
      "ready",
      "checking",
      "login-required",
    ]);
    expect(runtimeMocks.cloakModuleFactory).not.toHaveBeenCalled();
    expect(runtimeMocks.ensureBinary).not.toHaveBeenCalled();
    expect(runtimeMocks.launchPersistentContext).not.toHaveBeenCalled();
  });
});
