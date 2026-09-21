/**
 * 取消路径：分析和追问都必须能停，而且只能停自己那一次。
 * 这里直接注册真实的 IPC handler，用假的 AiAnalyzer 观察传下去的 AbortSignal。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type RegisteredHandler = (event: unknown, ...args: unknown[]) => unknown;

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

const llmConfig = {
  name: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-test",
  model: "gpt-4o",
  maxTokens: 4096,
};

vi.mock("electron", () => ({
  ipcMain: { handle: electronMocks.handle, on: electronMocks.on },
  app: { getPath: vi.fn(() => process.cwd()), getVersion: vi.fn(() => "test") },
  dialog: { showSaveDialog: vi.fn() },
  session: { defaultSession: { setProxy: vi.fn(), closeAllConnections: vi.fn() } },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    // llm-config.json 之外的路径保持真实行为，别影响其它读文件的 handler
    existsSync: (path: string) =>
      String(path).endsWith("llm-config.json") ? true : actual.existsSync(path),
    readFileSync: ((path: string, ...rest: unknown[]) =>
      String(path).endsWith("llm-config.json")
        ? JSON.stringify(llmConfig)
        : (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest)) as typeof actual.readFileSync,
    writeFileSync: vi.fn(),
  };
});

vi.mock("../../src/main/mcp/mcp-config", () => ({
  loadMCPServers: () => [],
  saveMCPServer: vi.fn(),
  deleteMCPServer: vi.fn(),
}));

import { registerIpcHandlers } from "../../src/main/ipc";

/** 一个只在 signal abort 时结束的调用，用来观察取消是否真的传到了底层 */
function pendingCall(record: { signal?: AbortSignal }) {
  return (signal?: AbortSignal) => {
    record.signal = signal;
    return new Promise<never>((_resolve, reject) => {
      if (!signal) return; // 没拿到 signal 就永远挂着：修复前就是这个样子
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  };
}

function setup() {
  const analyzeCalls: Array<{ signal?: AbortSignal }> = [];
  const chatCalls: Array<{ signal?: AbortSignal }> = [];
  const aiAnalyzer = {
    analyze: vi.fn((_sessionId, _config, _onProgress, _purpose, _template, _seqs, signal?: AbortSignal) => {
      const record: { signal?: AbortSignal } = {};
      analyzeCalls.push(record);
      return pendingCall(record)(signal);
    }),
    chat: vi.fn((_sessionId, _config, _history, _message, _onProgress, _reportId, signal?: AbortSignal) => {
      const record: { signal?: AbortSignal } = {};
      chatCalls.push(record);
      return pendingCall(record)(signal);
    }),
    buildInitialChatMessages: () => [],
  };

  // "*" = 整会话删除，其余是被单独删掉的报告 id
  const deleted: string[] = [];
  const noopRepo = { deleteBySession: vi.fn() };

  registerIpcHandlers({
    sessionManager: {
      withCaptureDataClear: async (_id: string, clear: () => void) => clear(),
    },
    aiAnalyzer,
    windowManager: { getMainWindow: vi.fn(() => null) },
    mcpManager: { connectAll: vi.fn(), hasConnections: () => false },
    requestsRepo: noopRepo,
    jsHooksRepo: noopRepo,
    storageSnapshotsRepo: noopRepo,
    interactionEventsRepo: noopRepo,
    reportsRepo: {
      findById: () => undefined,
      findBySession: () => [{ id: "r1" }],
      deleteBySession: () => void deleted.push("*"),
      deleteById: (id: string) => void deleted.push(id),
    },
    chatMessagesRepo: { insertMany: vi.fn(), append: vi.fn(), findByReport: () => [] },
    browserCoordinator: {},
  } as unknown as Parameters<typeof registerIpcHandlers>[0]);

  const handler = (channel: string): RegisteredHandler => {
    const found = electronMocks.handlers.get(channel);
    if (!found) throw new Error(`${channel} was not registered`);
    return found;
  };
  return { analyzeCalls, chatCalls, deleted, handler };
}

beforeEach(() => {
  electronMocks.handlers.clear();
  vi.clearAllMocks();
});

describe("AI cancellation IPC", () => {
  it("cancels an in-flight follow-up", async () => {
    const { chatCalls, handler } = setup();

    const chat = handler("ai:chat")({}, "s1", "r1", [], "问题");
    const rejects = expect(chat).rejects.toThrow("aborted");
    await Promise.resolve();

    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0].signal).toBeInstanceOf(AbortSignal);

    await handler("ai:cancelChat")({}, "s1");
    await rejects;
  });

  it("keeps analysis and follow-up cancellation separate", async () => {
    const { analyzeCalls, chatCalls, handler } = setup();

    const analysis = handler("ai:analyze")({}, "s1");
    const chat = handler("ai:chat")({}, "s1", "r1", [], "问题");
    analysis.catch(() => {});
    const chatRejects = expect(chat).rejects.toThrow("aborted");
    await Promise.resolve();
    await Promise.resolve();

    await handler("ai:cancelChat")({}, "s1");
    await chatRejects;
    expect(analyzeCalls[0].signal?.aborted).toBe(false);

    await handler("ai:cancel")({}, "s1");
    await expect(analysis).rejects.toThrow("aborted");
  });

  it("does not let a finished run deregister the run that replaced it", async () => {
    const { analyzeCalls, handler } = setup();

    // 第一次分析：会被第二次挤掉
    const first = handler("ai:analyze")({}, "s1");
    first.catch(() => {});
    await Promise.resolve();

    // 第二次分析抢占；第一次随即以取消收场并走 finally
    const second = handler("ai:analyze")({}, "s1");
    second.catch(() => {});
    await expect(first).rejects.toThrow("aborted");
    await Promise.resolve();

    // 此刻表里必须还是第二次那个 controller，否则停止按钮就成了空操作
    await handler("ai:cancel")({}, "s1");
    expect(analyzeCalls).toHaveLength(2);
    expect(analyzeCalls[1].signal?.aborted).toBe(true);
    await expect(second).rejects.toThrow("aborted");
  });

  it("does not let a finished follow-up deregister the one that replaced it", async () => {
    const { chatCalls, handler } = setup();

    const first = handler("ai:chat")({}, "s1", "r1", [], "第一问");
    first.catch(() => {});
    await Promise.resolve();

    const second = handler("ai:chat")({}, "s1", "r1", [], "第二问");
    second.catch(() => {});
    await expect(first).rejects.toThrow("aborted");
    await Promise.resolve();

    await handler("ai:cancelChat")({}, "s1");
    expect(chatCalls).toHaveLength(2);
    expect(chatCalls[1].signal?.aborted).toBe(true);
    await expect(second).rejects.toThrow("aborted");
  });

  it("keeps a report protected while a replaced follow-up is still unwinding", async () => {
    const { deleted, handler } = setup();

    const first = handler("ai:chat")({}, "s1", "r1", [], "第一问");
    first.catch(() => {});
    await Promise.resolve();

    const second = handler("ai:chat")({}, "s1", "r1", [], "第二问");
    second.catch(() => {});
    await expect(first).rejects.toThrow("aborted");
    await Promise.resolve();

    // 第一次追问已经结束，但第二次还在跑：报告不能被级联删掉
    await handler("data:clear")({}, "s1");
    expect(deleted).toEqual([]);

    await handler("ai:cancelChat")({}, "s1");
    await expect(second).rejects.toThrow("aborted");

    await handler("data:clear")({}, "s1");
    expect(deleted).toEqual(["*"]);
  });
});
