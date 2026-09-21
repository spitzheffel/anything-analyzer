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
import {
  getToolSessionState,
  recordToolSessionActivity,
} from "../../src/main/ai/tool-session-state";

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

function setup(options: { chatResolves?: () => Promise<string> } = {}) {
  const analyzeCalls: Array<{ signal?: AbortSignal }> = [];
  const chatCalls: Array<{ signal?: AbortSignal }> = [];
  const appended: Array<[string, string]> = [];
  const aiAnalyzer = {
    analyze: vi.fn((_sessionId, _config, _onProgress, _purpose, _template, _seqs, signal?: AbortSignal) => {
      const record: { signal?: AbortSignal } = {};
      analyzeCalls.push(record);
      return pendingCall(record)(signal);
    }),
    chat: vi.fn((_sessionId, _config, _history, _message, _onProgress, _reportId, signal?: AbortSignal) => {
      const record: { signal?: AbortSignal } = { signal };
      chatCalls.push(record);
      if (options.chatResolves) return options.chatResolves();
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
      deleteSession: vi.fn(),
    },
    aiAnalyzer,
    windowManager: { getMainWindow: vi.fn(() => null), getTabManager: vi.fn(() => null) },
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
    chatMessagesRepo: {
      insertMany: vi.fn(),
      append: (_reportId: string, role: string, content: string) => void appended.push([role, content]),
      findByReport: () => [],
    },
    browserCoordinator: {},
  } as unknown as Parameters<typeof registerIpcHandlers>[0]);

  const handler = (channel: string): RegisteredHandler => {
    const found = electronMocks.handlers.get(channel);
    if (!found) throw new Error(`${channel} was not registered`);
    return found;
  };
  return { analyzeCalls, chatCalls, appended, deleted, handler };
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

  it("does not persist a follow-up that was cancelled just as it finished", async () => {
    // 流已经结束时 abort 拦不住回复；界面那边已经回滚，落库就会让它复活
    let finish: (reply: string) => void = () => {};
    const replied = new Promise<string>((resolve) => { finish = resolve; });
    const { appended, handler } = setup({ chatResolves: () => replied });

    const chat = handler("ai:chat")({}, "s1", "r1", [], "问题");
    await Promise.resolve();

    await handler("ai:cancelChat")({}, "s1");
    finish("回复正文");
    await expect(chat).resolves.toBe("回复正文");

    expect(appended).toEqual([]);
  });

  it("persists a follow-up that finished without being cancelled", async () => {
    const { appended, handler } = setup({ chatResolves: async () => "回复正文" });

    await expect(handler("ai:chat")({}, "s1", "r1", [], "问题")).resolves.toBe("回复正文");

    expect(appended).toEqual([["user", "问题"], ["assistant", "回复正文"]]);
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

describe("tool state lifecycle over IPC", () => {
  it("drops a session's tool state when its capture data is cleared or the session is deleted", async () => {
    const { handler } = setup();

    recordToolSessionActivity("ipc-clear", "r1", [1, 2], "[get_request_detail](seqs=1,2)");
    await handler("data:clear")({}, "ipc-clear");
    expect(getToolSessionState("ipc-clear", "r1").fetchedSeqs).toEqual([]);

    recordToolSessionActivity("ipc-delete", "r1", [3, 4], "[get_request_detail](seqs=3,4)");
    await handler("session:delete")({}, "ipc-delete");
    expect(getToolSessionState("ipc-delete", "r1").fetchedSeqs).toEqual([]);
  });
});
