import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  session: {},
}));

import {
  ElectronBrowserBackend,
  ElectronBrowserTarget,
  ElectronCdpTransport,
} from "../../../src/main/browser/electron-backend";

class FakeDebugger extends EventEmitter {
  attached = false;
  private readonly sendGates = new Map<string, Promise<void>>();
  private readonly sendErrors = new Map<string, Error>();
  private nextDetachError: Error | null = null;
  readonly attach = vi.fn(() => {
    this.attached = true;
  });
  readonly detach = vi.fn(() => {
    if (this.nextDetachError) {
      const error = this.nextDetachError;
      this.nextDetachError = null;
      throw error;
    }
    this.attached = false;
    this.emit("detach", {}, "target closed");
  });
  readonly isAttached = vi.fn(() => this.attached);
  readonly sendCommand = vi.fn(async (method: string) => {
    await this.sendGates.get(method);
    const error = this.sendErrors.get(method);
    if (error) {
      this.sendErrors.delete(method);
      throw error;
    }
    return {};
  });

  blockSend(method: string, gate: Promise<void>): void {
    this.sendGates.set(method, gate);
  }

  failNextDetach(error: Error): void {
    this.nextDetachError = error;
  }

  failNextSend(method: string, error: Error): void {
    this.sendErrors.set(method, error);
  }
}

class FakeWebContents extends EventEmitter {
  readonly debugger = new FakeDebugger();
  devToolsOpened = false;
  destroyed = false;

  isDestroyed(): boolean { return this.destroyed; }
  getURL(): string { return "https://scope.test/"; }
  getTitle(): string { return "Scope"; }
  isLoading(): boolean { return false; }
  canGoBack(): boolean { return false; }
  canGoForward(): boolean { return false; }
  isDevToolsOpened(): boolean { return this.devToolsOpened; }
  openDevTools(): void { this.devToolsOpened = true; }
  closeDevTools(): void {
    this.devToolsOpened = false;
    this.emit("devtools-closed");
  }
}

function createTarget(): {
  target: ElectronBrowserTarget;
  webContents: FakeWebContents;
} {
  const webContents = new FakeWebContents();
  const context = {
    sessionId: "session-1",
    id: "electron:session-1",
    isTargetActive: () => true,
    activateTargetInternal: vi.fn(async () => undefined),
    closeTarget: vi.fn(async () => undefined),
    setVisible: vi.fn(),
  };
  const tab = {
    id: "tab-1",
    url: "https://scope.test/",
    title: "Scope",
    isLoading: false,
    view: {
      webContents,
      setBounds: vi.fn(),
    },
  };
  return {
    target: new ElectronBrowserTarget(context as never, tab as never),
    webContents,
  };
}

function createBackend(): {
  backend: ElectronBrowserBackend;
  tabManager: EventEmitter & {
    destroyEverything: ReturnType<typeof vi.fn>;
    destroySessionGroup: ReturnType<typeof vi.fn>;
    getActiveTab: ReturnType<typeof vi.fn>;
    getAllTabs: ReturnType<typeof vi.fn>;
    getCurrentGroupId: ReturnType<typeof vi.fn>;
    setShuttingDown: ReturnType<typeof vi.fn>;
  };
  windowManager: {
    destroyTargetView: ReturnType<typeof vi.fn>;
    getTabManager: ReturnType<typeof vi.fn>;
    setShuttingDown: ReturnType<typeof vi.fn>;
  };
} {
  const tabManager = Object.assign(new EventEmitter(), {
    destroyEverything: vi.fn(),
    destroySessionGroup: vi.fn(),
    getActiveTab: vi.fn(() => null),
    getAllTabs: vi.fn(() => []),
    getCurrentGroupId: vi.fn(() => null),
    setShuttingDown: vi.fn(),
  });
  const windowManager = {
    destroyTargetView: vi.fn(),
    getTabManager: vi.fn(() => tabManager),
    setShuttingDown: vi.fn(),
  };
  return {
    backend: new ElectronBrowserBackend(windowManager as never, tabManager as never),
    tabManager,
    windowManager,
  };
}

describe("ElectronBrowserTarget DevTools CDP ownership", () => {
  it("releases only the DevTools lease while another CDP owner is active", async () => {
    const { target, webContents } = createTarget();
    await target.toggleDevTools();
    const transport = await target.getCdpTransport() as ElectronCdpTransport;
    const captureLease = await transport.acquire("capture");

    await target.toggleDevTools();

    expect(webContents.debugger.detach).not.toHaveBeenCalled();
    expect(captureLease.connected).toBe(true);
    await expect(transport.close()).rejects.toMatchObject({ code: "CDP_IN_USE" });

    await captureLease.release();
    expect(webContents.debugger.detach).toHaveBeenCalledOnce();
  });

  it("invalidates every outstanding lease before target close completes", async () => {
    const { target, webContents } = createTarget();
    await target.toggleDevTools();
    const transport = await target.getCdpTransport() as ElectronCdpTransport;
    const captureLease = await transport.acquire("capture");

    await target.markClosed();

    expect(captureLease.released).toBe(true);
    expect(transport.connected).toBe(false);
    expect(webContents.debugger.detach).toHaveBeenCalledOnce();
  });

  it("disables a released lease's exclusive domain without detaching another owner", async () => {
    const { target, webContents } = createTarget();
    const transport = await target.getCdpTransport() as ElectronCdpTransport;
    const keeper = await transport.acquire("capture");
    const raw = await transport.acquire("mcp:raw");

    await raw.send("Fetch.enable");
    await raw.release();

    expect(webContents.debugger.sendCommand.mock.calls.map(([method]) => method)).toEqual([
      "Fetch.enable",
      "Fetch.disable",
    ]);
    expect(webContents.debugger.detach).not.toHaveBeenCalled();
    expect(keeper.connected).toBe(true);
    await keeper.release();
  });

  it("serializes an in-flight domain enable before releasing its lease", async () => {
    const { target, webContents } = createTarget();
    const transport = await target.getCdpTransport() as ElectronCdpTransport;
    const keeper = await transport.acquire("capture");
    const raw = await transport.acquire("mcp:raw");
    let releaseEnable: (() => void) | undefined;
    const enableGate = new Promise<void>((resolve) => {
      releaseEnable = resolve;
    });
    webContents.debugger.blockSend("Fetch.enable", enableGate);

    const enable = raw.send("Fetch.enable");
    const release = raw.release();
    await Promise.resolve();
    expect(webContents.debugger.sendCommand).toHaveBeenCalledTimes(1);

    releaseEnable?.();
    await Promise.all([enable, release]);
    expect(webContents.debugger.sendCommand.mock.calls.map(([method]) => method)).toEqual([
      "Fetch.enable",
      "Fetch.disable",
    ]);
    await keeper.release();
  });

  it("retains a lease when graceful debugger detach fails and retries", async () => {
    const { target, webContents } = createTarget();
    const transport = await target.getCdpTransport() as ElectronCdpTransport;
    const lease = await transport.acquire("capture");
    webContents.debugger.failNextDetach(new Error("detach failed"));

    await expect(lease.release()).rejects.toMatchObject({ code: "CDP_UNAVAILABLE" });
    expect(lease.connected).toBe(true);
    expect(transport.connected).toBe(true);

    await expect(lease.release()).resolves.toBeUndefined();
    expect(webContents.debugger.detach).toHaveBeenCalledTimes(2);
  });

  it("retains domain ownership when automatic disable fails and retries", async () => {
    const { target, webContents } = createTarget();
    const transport = await target.getCdpTransport() as ElectronCdpTransport;
    const keeper = await transport.acquire("capture");
    const raw = await transport.acquire("mcp:raw");
    await raw.send("Fetch.enable");
    webContents.debugger.failNextSend("Fetch.disable", new Error("disable failed"));

    await expect(raw.release()).rejects.toMatchObject({ code: "CDP_UNAVAILABLE" });
    expect(raw.connected).toBe(true);

    await expect(raw.release()).resolves.toBeUndefined();
    expect(
      webContents.debugger.sendCommand.mock.calls.filter(
        ([method]) => method === "Fetch.disable",
      ),
    ).toHaveLength(2);
    await keeper.release();
  });

  it("protects Runtime from another raw CDP owner", async () => {
    const { target } = createTarget();
    const transport = await target.getCdpTransport() as ElectronCdpTransport;
    const bindings = await transport.acquire("bindings");
    const raw = await transport.acquire("mcp:raw");
    await bindings.send("Runtime.enable");

    await expect(raw.send("Runtime.disable")).rejects.toMatchObject({
      code: "CDP_DOMAIN_CONFLICT",
    });

    await raw.release();
    await bindings.release();
  });
});

describe("ElectronBrowserBackend shutdown", () => {
  it("shares an in-flight attempt and retries failed final cleanup", async () => {
    const { backend, windowManager } = createBackend();
    await backend.start();
    windowManager.destroyTargetView
      .mockImplementationOnce(() => {
        throw new Error("destroy failed");
      })
      .mockImplementationOnce(() => undefined);

    const firstAttempt = backend.shutdown();
    const concurrentAttempt = backend.shutdown();

    expect(concurrentAttempt).toBe(firstAttempt);
    await expect(firstAttempt).rejects.toMatchObject({ code: "BACKEND_FAILURE" });

    const retry = backend.shutdown();
    expect(retry).not.toBe(firstAttempt);
    await expect(retry).resolves.toBeUndefined();
    expect(windowManager.destroyTargetView).toHaveBeenCalledTimes(2);

    await expect(backend.shutdown()).resolves.toBeUndefined();
    expect(windowManager.destroyTargetView).toHaveBeenCalledTimes(2);
  });

  it("retains a failed context and retries it before final cleanup", async () => {
    const { backend, tabManager, windowManager } = createBackend();
    await backend.start();
    const closeFromBackend = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("context close failed"))
      .mockResolvedValueOnce(undefined);
    const context = { closeFromBackend };
    const contexts = (
      backend as unknown as {
        contexts: Map<string, typeof context>;
      }
    ).contexts;
    contexts.set("session-1", context);

    await expect(backend.shutdown()).rejects.toMatchObject({ code: "BACKEND_FAILURE" });
    expect(contexts.get("session-1")).toBe(context);
    expect(windowManager.destroyTargetView).not.toHaveBeenCalled();

    await expect(backend.shutdown()).resolves.toBeUndefined();
    expect(closeFromBackend).toHaveBeenCalledTimes(2);
    expect(tabManager.destroySessionGroup).toHaveBeenCalledOnce();
    expect(contexts.has("session-1")).toBe(false);
    expect(windowManager.destroyTargetView).toHaveBeenCalledOnce();
  });
});
