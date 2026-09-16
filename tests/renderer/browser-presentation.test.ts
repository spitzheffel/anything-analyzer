import { describe, expect, it } from "vitest";
import {
  cloakVersionDrift,
  shouldShowEmbeddedBrowser,
} from "../../src/shared/browser-presentation";
import type { CloakRuntimeStatus } from "../../src/shared/types";

function status(changes: Partial<CloakRuntimeStatus> = {}): CloakRuntimeStatus {
  return {
    available: true,
    state: "ready",
    loggedIn: true,
    plan: "free",
    seats: 1,
    policy: "strict",
    configuredVersion: "151.0.7922.108.3",
    actualVersion: "151.0.7922.108.3",
    error: null,
    errorCode: null,
    downloadProgress: null,
    ...changes,
  };
}

describe("cloak version drift", () => {
  it("reports the gap when the wrapper resolved a build other than the pin", () => {
    expect(cloakVersionDrift(status({ actualVersion: "151.0.7922.108.6" }))).toEqual({
      requested: "151.0.7922.108.3",
      actual: "151.0.7922.108.6",
    });
  });

  it("stays quiet when the pin was honored", () => {
    expect(cloakVersionDrift(status())).toBeNull();
  });

  it("stays quiet in free-latest, which requests no version at all", () => {
    expect(
      cloakVersionDrift(
        status({
          policy: "free-latest",
          configuredVersion: null,
          actualVersion: "151.0.7922.108.6",
        }),
      ),
    ).toBeNull();
  });

  it("waits for a ready runtime, where the reported version stops echoing the request", () => {
    expect(cloakVersionDrift(null)).toBeNull();
    expect(
      cloakVersionDrift(
        status({ state: "checking", actualVersion: "151.0.7922.108.6" }),
      ),
    ).toBeNull();
    expect(cloakVersionDrift(status({ state: "ready", actualVersion: null }))).toBeNull();
  });
});

describe("embedded browser presentation", () => {
  it("stays hidden without a selected Session", () => {
    expect(shouldShowEmbeddedBrowser("browser", null)).toBe(false);
    expect(shouldShowEmbeddedBrowser("browser", undefined)).toBe(false);
  });

  it("is visible only for an Electron Session in the browser view", () => {
    expect(shouldShowEmbeddedBrowser("browser", "electron")).toBe(true);
    expect(shouldShowEmbeddedBrowser("browser", "cloak")).toBe(false);
    expect(shouldShowEmbeddedBrowser("inspector", "electron")).toBe(false);
    expect(shouldShowEmbeddedBrowser("report", "electron")).toBe(false);
  });
});
