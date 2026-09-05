import { describe, expect, it, vi } from "vitest";
import type {
  BrowserTarget,
  CdpLease,
  CdpMessage,
  CdpTransport,
} from "../../../src/main/browser/contracts";
import { ReplayEngine } from "../../../src/main/capture/replay-engine";
import type { InteractionEvent } from "../../../src/shared/types";

interface ReplayHarness {
  target: BrowserTarget;
  lease: CdpLease;
  send: ReturnType<typeof vi.fn>;
  acquire: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  transportClose: ReturnType<typeof vi.fn>;
  transportForceClose: ReturnType<typeof vi.fn>;
  nativeDetach: ReturnType<typeof vi.fn>;
  getNativeHandle: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
  setClosed(closed: boolean): void;
}

function createHarness(
  onSend?: (
    method: string,
    params: Record<string, unknown>,
  ) => unknown | Promise<unknown>,
): ReplayHarness {
  let closed = false;
  let released = false;
  const send = vi.fn(
    async (method: string, params: Record<string, unknown> = {}) =>
      onSend?.(method, params) ?? {},
  );
  const release = vi.fn(async () => {
    released = true;
  });
  const lease = {
    owner: "replay",
    targetId: "tab-1",
    get connected() {
      return !released;
    },
    get released() {
      return released;
    },
    send,
    onMessage: vi.fn(() => () => undefined),
    onDisconnect: vi.fn(() => () => undefined),
    release,
  } as unknown as CdpLease;
  const acquire = vi.fn(async () => lease);
  const transportClose = vi.fn(async () => undefined);
  const transportForceClose = vi.fn(async () => undefined);
  const transport = {
    targetId: "tab-1",
    connected: true,
    acquire,
    connect: vi.fn(),
    send: vi.fn(),
    onMessage: vi.fn((_listener: (message: CdpMessage) => void) => () => undefined),
    onDisconnect: vi.fn(() => () => undefined),
    close: transportClose,
    forceClose: transportForceClose,
  } as unknown as CdpTransport;
  const nativeDetach = vi.fn();
  const getNativeHandle = vi.fn(() => ({
    debugger: { detach: nativeDetach },
  }));
  const navigate = vi.fn(async () => undefined);
  const target = {
    id: "tab-1",
    tabId: "tab-1",
    sessionId: "session-1",
    contextId: "context-1",
    backendKind: "cloak",
    url: "https://example.test",
    title: "Example",
    isClosed: () => closed,
    navigate,
    getCdpTransport: vi.fn(async () => transport),
    getNativeHandle,
  } as unknown as BrowserTarget;

  return {
    target,
    lease,
    send,
    acquire,
    release,
    transportClose,
    transportForceClose,
    nativeDetach,
    getNativeHandle,
    navigate,
    setClosed(value: boolean): void {
      closed = value;
    },
  };
}

function interaction(
  overrides: Partial<InteractionEvent> = {},
): InteractionEvent {
  return {
    id: 1,
    session_id: "session-1",
    sequence: 1,
    type: "click",
    timestamp: 1_000,
    x: 10,
    y: 20,
    viewport_x: 30,
    viewport_y: 40,
    selector: null,
    xpath: null,
    tag_name: null,
    element_text: null,
    attributes: null,
    bounding_rect: null,
    input_value: null,
    key: null,
    scroll_x: null,
    scroll_y: null,
    scroll_dx: null,
    scroll_dy: null,
    url: "https://example.test",
    page_title: "Example",
    path: null,
    created_at: 1_000,
    ...overrides,
  };
}

function expectSharedTransportPreserved(harness: ReplayHarness): void {
  expect(harness.transportClose).not.toHaveBeenCalled();
  expect(harness.transportForceClose).not.toHaveBeenCalled();
  expect(harness.getNativeHandle).not.toHaveBeenCalled();
  expect(harness.nativeDetach).not.toHaveBeenCalled();
}

describe("ReplayEngine", () => {
  it("completes a replay and releases only its shared CDP lease", async () => {
    const harness = createHarness();
    const engine = new ReplayEngine();
    const events = [
      interaction(),
      interaction({
        id: 2,
        sequence: 2,
        type: "scroll",
        timestamp: 1_001,
        scroll_dx: 5,
        scroll_dy: 120,
      }),
    ];

    await expect(
      engine.replay(harness.target, events, { speed: 2, skipMoves: false }),
    ).resolves.toEqual({ success: true, stepsCompleted: 2 });

    expect(harness.acquire).toHaveBeenCalledWith("replay");
    expect(harness.send.mock.calls.map(([method]) => method)).toEqual([
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
    ]);
    expect(harness.release).toHaveBeenCalledOnce();
    expect(harness.lease.released).toBe(true);
    expectSharedTransportPreserved(harness);
  });

  it("cancels an in-flight replay and still releases the lease", async () => {
    const harness = createHarness();
    const engine = new ReplayEngine();
    const replaying = engine.replay(
      harness.target,
      [
        interaction(),
        interaction({ id: 2, sequence: 2, timestamp: 10_000 }),
      ],
      { speed: 1, skipMoves: false },
    );
    await vi.waitFor(() => expect(harness.send).toHaveBeenCalledTimes(3));

    engine.abort();

    await expect(replaying).resolves.toEqual({
      success: false,
      stepsCompleted: 1,
      error: "Replay cancelled",
    });
    expect(harness.release).toHaveBeenCalledOnce();
    expectSharedTransportPreserved(harness);
  });

  it("reports a target that closes between steps and releases the lease", async () => {
    const harness = createHarness();
    harness.navigate.mockImplementationOnce(async () => {
      harness.setClosed(true);
    });
    const engine = new ReplayEngine();

    const result = await engine.replay(
      harness.target,
      [
        interaction({ type: "navigate", url: "https://next.test" }),
        interaction({ id: 2, sequence: 2, timestamp: 1_001 }),
      ],
      { speed: 1, skipMoves: false },
    );

    expect(result).toEqual({
      success: false,
      stepsCompleted: 1,
      error: "Browser target closed during replay",
    });
    expect(harness.release).toHaveBeenCalledOnce();
    expectSharedTransportPreserved(harness);
  });

  it("returns action failures without leaking its lease", async () => {
    const harness = createHarness(async (method) => {
      if (method === "Input.dispatchMouseEvent") {
        throw new Error("CDP input failed");
      }
      return {};
    });
    const engine = new ReplayEngine();

    await expect(
      engine.executeAction(harness.target, { type: "click", x: 1, y: 2 }),
    ).resolves.toEqual({ success: false, error: "CDP input failed" });
    expect(harness.acquire).toHaveBeenCalledWith("replay:action");
    expect(harness.release).toHaveBeenCalledOnce();
    expectSharedTransportPreserved(harness);
  });

  it("stops on a failed replay step, preserves progress, and releases the lease", async () => {
    let inputCommands = 0;
    const harness = createHarness(async (method) => {
      if (method === "Input.dispatchMouseEvent") {
        inputCommands += 1;
        if (inputCommands === 4) throw new Error("second step failed");
      }
      return {};
    });
    const engine = new ReplayEngine();

    const result = await engine.replay(
      harness.target,
      [
        interaction(),
        interaction({
          id: 2,
          sequence: 2,
          type: "scroll",
          timestamp: 1_001,
          scroll_dy: 100,
        }),
      ],
      { speed: 1, skipMoves: false },
    );

    expect(result).toEqual({
      success: false,
      stepsCompleted: 1,
      error: "second step failed",
    });
    expect(harness.release).toHaveBeenCalledOnce();
    expectSharedTransportPreserved(harness);
  });

  it("uses Input.insertText for Unicode text in replay and direct actions", async () => {
    const replayHarness = createHarness();
    const actionHarness = createHarness();
    const engine = new ReplayEngine();
    const text = "\u5bc6\u7801\ud83d\ude80\ud840\udc00";

    await engine.replay(
      replayHarness.target,
      [interaction({ type: "input", selector: "#\u8d26\u6237", input_value: text })],
      { speed: 1, skipMoves: false },
    );
    await engine.executeAction(actionHarness.target, {
      type: "type",
      selector: "#\u8d26\u6237",
      text,
    });

    for (const harness of [replayHarness, actionHarness]) {
      expect(harness.send).toHaveBeenCalledWith("Input.insertText", { text });
      expect(harness.send).not.toHaveBeenCalledWith(
        "Input.dispatchKeyEvent",
        expect.anything(),
      );
      expect(harness.release).toHaveBeenCalledOnce();
      expectSharedTransportPreserved(harness);
    }
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid replay speed %s before acquiring CDP",
    async (speed) => {
      const harness = createHarness();
      const engine = new ReplayEngine();

      await expect(
        engine.replay(harness.target, [interaction()], {
          speed,
          skipMoves: false,
        }),
      ).resolves.toEqual({
        success: false,
        stepsCompleted: 0,
        error: "Replay speed must be greater than 0",
      });
      expect(harness.acquire).not.toHaveBeenCalled();
      expect(harness.release).not.toHaveBeenCalled();
      expectSharedTransportPreserved(harness);
    },
  );

  it("does not acquire a lease when the target is already closed", async () => {
    const harness = createHarness();
    harness.setClosed(true);
    const engine = new ReplayEngine();

    await expect(engine.replay(harness.target, [interaction()])).resolves.toEqual({
      success: false,
      stepsCompleted: 0,
      error: "Browser target is closed",
    });
    expect(harness.acquire).not.toHaveBeenCalled();
    expectSharedTransportPreserved(harness);
  });
});
