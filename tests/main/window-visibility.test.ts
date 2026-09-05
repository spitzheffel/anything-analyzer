import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  WebContentsView: class {},
  nativeImage: { createFromPath: vi.fn() },
  session: {},
}));

import { WindowManager } from "../../src/main/window";

describe("WindowManager browser visibility", () => {
  it("starts with the native browser view hidden", () => {
    expect(new WindowManager().isTargetViewVisible()).toBe(false);
  });
});
