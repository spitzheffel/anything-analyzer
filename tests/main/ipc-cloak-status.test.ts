import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserBackendError } from "../../src/main/browser/contracts";

type RegisteredHandler = (
  event: unknown,
  ...args: unknown[]
) => unknown;

const electronMocks = vi.hoisted(() => {
  const handlers = new Map<string, RegisteredHandler>();
  return {
    handlers,
    handle: vi.fn((channel: string, handler: RegisteredHandler) => {
      handlers.set(channel, handler);
    }),
    on: vi.fn(),
  };
});

const sideEffects = vi.hoisted(() => ({
  writeFileSync: vi.fn(),
  execFile: vi.fn(),
  cloakModuleLoaded: vi.fn(),
  ensureBinary: vi.fn(),
  launchPersistentContext: vi.fn(),
  login: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: electronMocks.handle,
    on: electronMocks.on,
  },
  app: {
    getPath: vi.fn(() => process.cwd()),
    getVersion: vi.fn(() => "test"),
  },
  dialog: {
    showSaveDialog: vi.fn(),
  },
  session: {
    defaultSession: {
      setProxy: vi.fn(),
      closeAllConnections: vi.fn(),
    },
  },
  shell: {
    openExternal: vi.fn(),
    openPath: vi.fn(),
  },
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    writeFileSync: sideEffects.writeFileSync,
  };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: sideEffects.execFile,
  };
});

vi.mock("cloakbrowser", () => {
  sideEffects.cloakModuleLoaded();
  return {
    CHROMIUM_VERSION: "test",
    binaryInfo: vi.fn(),
    ensureBinary: sideEffects.ensureBinary,
    launchPersistentContext: sideEffects.launchPersistentContext,
    login: sideEffects.login,
  };
});

import { registerIpcHandlers } from "../../src/main/ipc";

describe("Cloak status IPC", () => {
  beforeEach(() => {
    electronMocks.handlers.clear();
    vi.clearAllMocks();
  });

  it("keeps the public-build status path read-only", async () => {
    const publicStatus = {
      available: false,
      state: "unavailable" as const,
      loggedIn: false,
      plan: null,
      seats: 0,
      policy: "strict" as const,
      configuredVersion: null,
      actualVersion: null,
      error: "CloakBrowser is not available in this build",
      errorCode: "BACKEND_NOT_AVAILABLE" as const,
      downloadProgress: null,
    };
    const sessionManager = {
      getCloakStatus: vi.fn(async () => publicStatus),
      prepareCloakRuntime: vi.fn(),
      setCloakRuntimePolicy: vi.fn(),
    };
    const browserCoordinator = {
      openSession: vi.fn(),
    };

    registerIpcHandlers({
      sessionManager,
      windowManager: { getMainWindow: vi.fn(() => null) },
      browserCoordinator,
    } as unknown as Parameters<typeof registerIpcHandlers>[0]);

    const statusHandler = electronMocks.handlers.get("cloak:status");
    expect(statusHandler).toBeTypeOf("function");
    if (!statusHandler) throw new Error("cloak:status was not registered");

    await expect(statusHandler({})).resolves.toBe(publicStatus);
    expect(sessionManager.getCloakStatus).toHaveBeenCalledOnce();
    expect(sessionManager.prepareCloakRuntime).not.toHaveBeenCalled();
    expect(sessionManager.setCloakRuntimePolicy).not.toHaveBeenCalled();
    expect(browserCoordinator.openSession).not.toHaveBeenCalled();

    expect(sideEffects.cloakModuleLoaded).not.toHaveBeenCalled();
    expect(sideEffects.execFile).not.toHaveBeenCalled();
    expect(sideEffects.ensureBinary).not.toHaveBeenCalled();
    expect(sideEffects.launchPersistentContext).not.toHaveBeenCalled();
    expect(sideEffects.login).not.toHaveBeenCalled();
    expect(sideEffects.writeFileSync).not.toHaveBeenCalled();
  });

  it("exposes the backend code and does not save policy when prepare is unavailable", async () => {
    const sessionManager = {
      getCloakStatus: vi.fn(),
      prepareCloakRuntime: vi.fn(async () => {
        throw new BrowserBackendError(
          "BACKEND_NOT_AVAILABLE",
          "CloakBrowser is not available in this build",
          { backendKind: "cloak" },
        );
      }),
      setCloakRuntimePolicy: vi.fn(),
    };

    registerIpcHandlers({
      sessionManager,
      windowManager: { getMainWindow: vi.fn(() => null) },
      browserCoordinator: { openSession: vi.fn() },
    } as unknown as Parameters<typeof registerIpcHandlers>[0]);

    const prepareHandler = electronMocks.handlers.get("cloak:prepare");
    expect(prepareHandler).toBeTypeOf("function");
    if (!prepareHandler) throw new Error("cloak:prepare was not registered");

    await expect(prepareHandler({}, "free-latest")).rejects.toThrow(
      "[BACKEND_NOT_AVAILABLE] CloakBrowser is not available in this build",
    );
    expect(sessionManager.prepareCloakRuntime).toHaveBeenCalledWith("free-latest");
    expect(sideEffects.writeFileSync).not.toHaveBeenCalled();
  });

  it("always forwards hide requests and gates show to an active Electron context", async () => {
    const setTargetViewVisible = vi.fn();
    const activeContext = { current: null as null | { backendKind: "electron" | "cloak" } };
    registerIpcHandlers({
      sessionManager: {},
      windowManager: {
        getMainWindow: vi.fn(() => null),
        setTargetViewVisible,
      },
      browserCoordinator: {
        getActiveContext: vi.fn(() => activeContext.current),
      },
    } as unknown as Parameters<typeof registerIpcHandlers>[0]);

    const handler = electronMocks.handlers.get("browser:setVisible");
    expect(handler).toBeTypeOf("function");
    if (!handler) throw new Error("browser:setVisible was not registered");

    await handler({}, false);
    await handler({}, true);
    activeContext.current = { backendKind: "cloak" };
    await handler({}, true);
    activeContext.current = { backendKind: "electron" };
    await handler({}, true);

    expect(setTargetViewVisible.mock.calls).toEqual([
      [false],
      [false],
      [false],
      [true],
    ]);
  });
});
