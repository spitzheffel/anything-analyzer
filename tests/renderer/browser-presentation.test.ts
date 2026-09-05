import { describe, expect, it } from "vitest";
import { shouldShowEmbeddedBrowser } from "../../src/shared/browser-presentation";

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
