import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    isReady: () => true,
  },
}));

import {
  CLOAK_PAID_BROWSER_VERSION,
  CLOAK_WRAPPER_VERSION,
  buildCloakLaunchOptions,
  evaluateCloakDiagnosticsStatus,
  parseCloakInfoJson,
} from "../../../src/main/browser/cloak-runtime";

interface FixtureOptions {
  licenseTier?: string;
  licenseValid?: boolean | null;
  binaryTier?: "free" | "pro" | "override";
  version?: string | null;
  installed?: boolean;
  pinned?: boolean;
  channel?: string;
  seatLimit?: number;
}

function diagnosticsJson(options: FixtureOptions = {}): string {
  const license: Record<string, unknown> = {
    tier: options.licenseTier ?? "pro",
  };
  if (options.licenseValid !== null) {
    license.valid = options.licenseValid ?? true;
  }
  if (options.seatLimit !== undefined) {
    license.sessions = {
      active: 0,
      limit: options.seatLimit,
      state: "ok",
    };
  }

  const version =
    options.version === undefined ? CLOAK_PAID_BROWSER_VERSION : options.version;
  return JSON.stringify({
    environment: {
      wrapper: CLOAK_WRAPPER_VERSION,
      platform_tag: "windows-x64",
    },
    binary: {
      version,
      installed_version: version,
      requested_channel: options.channel ?? "stable",
      resolved_channel: null,
      tier: options.binaryTier ?? "pro",
      path:
        version === null
          ? null
          : `C:\\cloakbrowser\\chromium-${version}-pro\\chrome.exe`,
      installed: options.installed ?? true,
      pinned: options.pinned ?? false,
    },
    license,
  });
}

describe("CloakBrowser CLI diagnostics", () => {
  it("parses the official JSON fields and account seat limit", () => {
    const diagnostics = parseCloakInfoJson(
      diagnosticsJson({ licenseTier: "team", seatLimit: 6, pinned: true }),
    );

    expect(diagnostics).toMatchObject({
      environment: {
        wrapper: CLOAK_WRAPPER_VERSION,
        platformTag: "windows-x64",
      },
      binary: {
        version: CLOAK_PAID_BROWSER_VERSION,
        requestedChannel: "stable",
        tier: "pro",
        installed: true,
        pinned: true,
      },
      license: {
        tier: "team",
        valid: true,
        seatLimit: 6,
      },
    });
  });

  it("rejects incompatible wrappers and malformed license validity", () => {
    const wrongWrapper = JSON.parse(diagnosticsJson()) as {
      environment: { wrapper: string };
    };
    wrongWrapper.environment.wrapper = "0.5.9";
    expect(() => parseCloakInfoJson(JSON.stringify(wrongWrapper))).toThrow(
      /wrapper mismatch/i,
    );

    const malformedLicense = JSON.parse(diagnosticsJson()) as {
      license: { valid: unknown };
    };
    malformedLicense.license.valid = "yes";
    expect(() => parseCloakInfoJson(JSON.stringify(malformedLicense))).toThrow(
      /license\.valid must be a boolean/i,
    );
  });

  it("maps a missing validated login to login-required", () => {
    const diagnostics = parseCloakInfoJson(
      diagnosticsJson({ licenseTier: "free", licenseValid: null }),
    );
    const status = evaluateCloakDiagnosticsStatus(diagnostics, "free-latest");

    expect(status).toMatchObject({
      state: "login-required",
      loggedIn: false,
      plan: null,
      seats: 1,
    });
  });

  it("defaults missing quick-diagnostics seat data to one", () => {
    const diagnostics = parseCloakInfoJson(
      diagnosticsJson({ licenseTier: "free", pinned: true }),
    );
    const status = evaluateCloakDiagnosticsStatus(diagnostics, "strict");

    expect(diagnostics.license.seatLimit).toBeNull();
    expect(status).toMatchObject({
      state: "ready",
      loggedIn: true,
      plan: "free",
      seats: 1,
    });
  });

  it("accepts a validated free account when the binary satisfies its policy", () => {
    const latestDiagnostics = parseCloakInfoJson(
      diagnosticsJson({ licenseTier: "free", binaryTier: "pro" }),
    );
    const strictDiagnostics = parseCloakInfoJson(
      diagnosticsJson({
        licenseTier: "free",
        binaryTier: "pro",
        pinned: true,
      }),
    );

    expect(
      evaluateCloakDiagnosticsStatus(latestDiagnostics, "free-latest"),
    ).toMatchObject({
      state: "ready",
      loggedIn: true,
      plan: "free",
      seats: 1,
      configuredVersion: null,
    });
    expect(evaluateCloakDiagnosticsStatus(strictDiagnostics, "strict")).toMatchObject({
      state: "ready",
      loggedIn: true,
      plan: "free",
      seats: 1,
      configuredVersion: CLOAK_PAID_BROWSER_VERSION,
      actualVersion: CLOAK_PAID_BROWSER_VERSION,
    });
  });

  it("requires the exact paid binary in strict mode", () => {
    const exact = parseCloakInfoJson(
      diagnosticsJson({ licenseTier: "team", pinned: true }),
    );
    expect(evaluateCloakDiagnosticsStatus(exact, "strict")).toMatchObject({
      state: "ready",
      plan: "team",
      configuredVersion: CLOAK_PAID_BROWSER_VERSION,
      actualVersion: CLOAK_PAID_BROWSER_VERSION,
      seats: 1,
    });

    const mismatch = parseCloakInfoJson(
      diagnosticsJson({
        licenseTier: "team",
        version: "151.0.7922.108.2",
        pinned: true,
      }),
    );
    expect(evaluateCloakDiagnosticsStatus(mismatch, "strict")).toMatchObject({
      state: "error",
    });
    expect(evaluateCloakDiagnosticsStatus(mismatch, "strict").error).toMatch(
      /version mismatch/i,
    );

    const unpinned = parseCloakInfoJson(
      diagnosticsJson({ licenseTier: "team", pinned: false }),
    );
    expect(evaluateCloakDiagnosticsStatus(unpinned, "strict")).toMatchObject({
      state: "error",
      error: expect.stringMatching(/pinned browser version/i),
    });

    const freeBinary = parseCloakInfoJson(
      diagnosticsJson({
        licenseTier: "free",
        binaryTier: "free",
        pinned: true,
      }),
    );
    expect(evaluateCloakDiagnosticsStatus(freeBinary, "strict")).toMatchObject({
      state: "error",
      error: expect.stringMatching(/requires the maintained Pro binary/i),
    });

    const rejectedLicense = parseCloakInfoJson(
      diagnosticsJson({ licenseTier: "free", licenseValid: false, pinned: true }),
    );
    expect(evaluateCloakDiagnosticsStatus(rejectedLicense, "strict")).toMatchObject({
      state: "login-required",
      loggedIn: false,
    });
  });

  it("keeps latest mode unpinned and distinguishes a missing binary", () => {
    const pinned = parseCloakInfoJson(
      diagnosticsJson({ licenseTier: "free", pinned: true }),
    );
    expect(evaluateCloakDiagnosticsStatus(pinned, "free-latest")).toMatchObject({
      state: "error",
    });

    const missing = parseCloakInfoJson(
      diagnosticsJson({
        licenseTier: "free",
        version: null,
        installed: false,
      }),
    );
    expect(evaluateCloakDiagnosticsStatus(missing, "free-latest")).toMatchObject({
      state: "not-installed",
      loggedIn: true,
      seats: 1,
    });
  });

  it("rejects non-stable diagnostics", () => {
    const diagnostics = parseCloakInfoJson(
      diagnosticsJson({ channel: "preview" }),
    );
    const status = evaluateCloakDiagnosticsStatus(diagnostics, "strict");

    expect(status.state).toBe("error");
    expect(status.error).toMatch(/stable release channel/i);
  });
});

describe("CloakBrowser launch options", () => {
  const profile = {
    profileId: "profile-1",
    profileKey: "profile-1",
    seed: "12345",
  };

  it.each([undefined, { type: "none" as const, host: "", port: 0 }])(
    "forces a direct Chromium connection when proxy is %s",
    (proxy) => {
      const launchOptions = buildCloakLaunchOptions(
        "C:\\profiles\\profile-1",
        profile,
        { sessionId: "session-1", proxy },
        CLOAK_PAID_BROWSER_VERSION,
      );

      expect(launchOptions.args).toContain("--no-proxy-server");
      expect(launchOptions.args).toContain("--fingerprint=12345");
      expect(launchOptions.geoip).toBe(false);
      expect(launchOptions).not.toHaveProperty("proxy");
      expect(launchOptions).not.toHaveProperty("licenseKey");
      expect(launchOptions.browserVersion).toBe(CLOAK_PAID_BROWSER_VERSION);
    },
  );

  it("keeps proxy routing and GeoIP coupled", () => {
    const launchOptions = buildCloakLaunchOptions(
      "C:\\profiles\\profile-1",
      profile,
      {
        sessionId: "session-1",
        proxy: {
          type: "socks5",
          host: "127.0.0.1",
          port: 1080,
          username: "alice",
          password: "secret",
        },
      },
    );

    expect(launchOptions.args).not.toContain("--no-proxy-server");
    expect(launchOptions.geoip).toBe(true);
    expect(launchOptions.proxy).toEqual({
      server: "socks5://127.0.0.1:1080",
      username: "alice",
      password: "secret",
    });
    expect(launchOptions).not.toHaveProperty("browserVersion");
    expect(launchOptions).not.toHaveProperty("licenseKey");
  });

  it("rejects incomplete proxy endpoints", () => {
    expect(() =>
      buildCloakLaunchOptions("C:\\profiles\\profile-1", profile, {
        sessionId: "session-1",
        proxy: { type: "http", host: " ", port: 8080 },
      }),
    ).toThrow(/proxy host and port are invalid/i);
  });
});
