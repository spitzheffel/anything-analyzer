import { describe, expect, it, vi } from "vitest";
import type {
  BrowserBindingCallback,
  BrowserTarget,
} from "../../../src/main/browser/contracts";
import { InteractionRecorder } from "../../../src/main/capture/interaction-recorder";
import type { InteractionEventsRepo } from "../../../src/main/db/repositories";
import type {
  BrowserBackendKind,
  RawInteractionData,
} from "../../../src/shared/types";

interface TargetHarness {
  target: BrowserTarget;
  addInitScript: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
  exposeBinding: ReturnType<typeof vi.fn>;
  getCdpTransport: ReturnType<typeof vi.fn>;
  invokeBinding(value: unknown): Promise<void>;
}

function createTarget(
  backendKind: BrowserBackendKind,
  options: {
    order?: string[];
    controlDelayMs?: number;
    onControl?: (recording: boolean) => void;
  } = {},
): TargetHarness {
  const order = options.order ?? [];
  let binding: BrowserBindingCallback | null = null;
  const addInitScript = vi.fn(async () => {
    order.push("addInitScript");
    return null;
  });
  const exposeBinding = vi.fn(
    async (_name: string, callback: BrowserBindingCallback) => {
      order.push("exposeBinding");
      binding = callback;
    },
  );
  const evaluate = vi.fn(async (source: string) => {
    const match = source.match(/recording:(true|false)/);
    if (!match) {
      order.push("evaluateCurrentPage");
      return undefined;
    }
    const recording = match[1] === "true";
    order.push(`control:${recording}`);
    if (options.controlDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.controlDelayMs));
    }
    options.onControl?.(recording);
    return undefined;
  });
  const getCdpTransport = vi.fn(async () => {
    throw new Error("InteractionRecorder must not acquire CDP");
  });
  const target = {
    id: "target-1",
    tabId: "tab-1",
    sessionId: "session-1",
    contextId: "context-1",
    backendKind,
    url: "about:blank",
    title: "Test",
    isClosed: () => false,
    getState: vi.fn(),
    navigate: vi.fn(async () => {
      order.push("navigate");
    }),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    activate: vi.fn(),
    close: vi.fn(),
    evaluate,
    addInitScript,
    exposeBinding,
    captureScreenshot: vi.fn(),
    getCdpTransport,
    onEvent: vi.fn(),
    getNativeHandle: vi.fn(),
  } as unknown as BrowserTarget;

  return {
    target,
    addInitScript,
    evaluate,
    exposeBinding,
    getCdpTransport,
    async invokeBinding(value: unknown): Promise<void> {
      if (!binding) throw new Error("No binding was exposed");
      await binding({
        sessionId: target.sessionId,
        contextId: target.contextId,
        tabId: target.tabId,
        name: "__anythingAnalyzerInteractionBinding",
        args: [value],
      });
    },
  };
}

function createRecorder(): {
  recorder: InteractionRecorder;
  repo: Pick<InteractionEventsRepo, "getNextSequence" | "insert">;
  renderer: { isDestroyed: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
} {
  const repo = {
    getNextSequence: vi.fn(() => 7),
    insert: vi.fn(),
  };
  const renderer = {
    isDestroyed: vi.fn(() => false),
    send: vi.fn(),
  };
  const recorder = new InteractionRecorder(repo as unknown as InteractionEventsRepo);
  recorder.start("session-1", renderer);
  (recorder as unknown as { scriptContent: string }).scriptContent =
    "globalThis.__testInteractionHook = true";
  return { recorder, repo, renderer };
}

const cloakMessage = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: "ar-interaction",
  interactionType: "input",
  timestamp: 1_725_000_000_000,
  selector: "#\u7528\u6237\u540d",
  elementText: "\u4f60\u597d\uff0c\u4e16\u754c",
  attributes: { "aria-label": "\u8d26\u6237\u540d" },
  inputValue: "\u6d4b\u8bd5\ud83d\ude80",
  url: "https://example.test/\u8def\u5f84",
  pageTitle: "\u767b\u5f55\u9875",
  ...overrides,
});

describe("InteractionRecorder", () => {
  it("installs the Cloak binding and init script before touching or navigating the page", async () => {
    const order: string[] = [];
    const { recorder, repo, renderer } = createRecorder();
    const harness = createTarget("cloak", { order });

    await recorder.attachTarget(harness.target);
    await harness.target.navigate("https://example.test");

    expect(order).toEqual([
      "exposeBinding",
      "addInitScript",
      "evaluateCurrentPage",
      "control:true",
      "navigate",
    ]);
    expect(harness.exposeBinding).toHaveBeenCalledWith(
      "__anythingAnalyzerInteractionBinding",
      expect.any(Function),
    );
    const initSource = harness.addInitScript.mock.calls[0][0] as string;
    expect(initSource).toContain("__anythingAnalyzerInteractionInstalled");
    expect(initSource).toContain("__anythingAnalyzerInteractionBinding");
    expect(initSource).toContain("__testInteractionHook");

    await harness.invokeBinding(cloakMessage());

    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: "session-1",
        sequence: 7,
        type: "input",
        selector: "#\u7528\u6237\u540d",
        element_text: "\u4f60\u597d\uff0c\u4e16\u754c",
        attributes: JSON.stringify({ "aria-label": "\u8d26\u6237\u540d" }),
        input_value: "\u6d4b\u8bd5\ud83d\ude80",
        url: "https://example.test/\u8def\u5f84",
        page_title: "\u767b\u5f55\u9875",
      }),
    );
    expect(renderer.send).toHaveBeenCalledWith("interaction:recorded", {
      type: "input",
      sequence: 7,
      timestamp: 1_725_000_000_000,
    });
  });

  it("rejects malformed binding payloads instead of persisting page-controlled values", async () => {
    const { recorder, repo } = createRecorder();
    const harness = createTarget("cloak");
    await recorder.attachTarget(harness.target);

    await harness.invokeBinding(cloakMessage({ interactionType: "submit" }));
    await harness.invokeBinding(cloakMessage({ timestamp: Number.NaN }));
    await harness.invokeBinding(cloakMessage({ url: 42 }));

    expect(repo.getNextSequence).not.toHaveBeenCalled();
    expect(repo.insert).not.toHaveBeenCalled();
  });

  it("uses browser-neutral script APIs without opening CDP or enabling Fetch", async () => {
    const { recorder } = createRecorder();
    const harness = createTarget("electron");

    await recorder.attachTarget(harness.target);

    expect(harness.exposeBinding).not.toHaveBeenCalled();
    expect(harness.addInitScript).toHaveBeenCalledOnce();
    expect(harness.getCdpTransport).not.toHaveBeenCalled();
  });

  it("serializes pause, resume, and stop and leaves every target disabled", async () => {
    const controlStates: boolean[] = [];
    let activeControls = 0;
    let maxActiveControls = 0;
    const { recorder, repo } = createRecorder();
    const harness = createTarget("cloak", {
      controlDelayMs: 2,
      onControl(recording) {
        controlStates.push(recording);
        activeControls -= 1;
      },
    });
    const originalEvaluate = harness.target.evaluate.bind(harness.target);
    harness.target.evaluate = (async <T>(source: string): Promise<T> => {
      if (/recording:(true|false)/.test(source)) {
        activeControls += 1;
        maxActiveControls = Math.max(maxActiveControls, activeControls);
      }
      return originalEvaluate(source) as Promise<T>;
    }) as BrowserTarget["evaluate"];

    await recorder.attachTarget(harness.target);
    controlStates.length = 0;
    maxActiveControls = 0;

    recorder.pause();
    expect(recorder.isRecording()).toBe(false);
    await harness.invokeBinding(cloakMessage());
    expect(repo.insert).not.toHaveBeenCalled();

    recorder.resume();
    expect(recorder.isRecording()).toBe(true);
    await harness.invokeBinding(cloakMessage({ interactionType: "click" }));
    expect(repo.insert).toHaveBeenCalledOnce();

    const stopping = recorder.stop();
    recorder.resume();
    await stopping;

    expect(controlStates).toEqual([false, true, false]);
    expect(maxActiveControls).toBe(1);
    expect(recorder.isRecording()).toBe(false);
    expect(recorder.getSessionId()).toBeNull();

    await harness.invokeBinding(cloakMessage());
    expect(repo.insert).toHaveBeenCalledOnce();
  });

  it("syncs a target to paused state when it is attached while recording is paused", async () => {
    const order: string[] = [];
    const { recorder } = createRecorder();
    const harness = createTarget("cloak", { order });
    recorder.pause();

    await recorder.attachTarget(harness.target);

    expect(order.at(-1)).toBe("control:false");
  });
});
