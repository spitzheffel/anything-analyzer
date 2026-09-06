import { describe, expect, it } from "vitest";
import { applyProgressEvent } from "../../src/renderer/hooks/useCapture";
import { formatStatusLine, reasoningEvent, resetEvent, statusEvent, textEvent } from "../../src/shared/ai-progress";

describe("applyProgressEvent", () => {
  const empty = { streamingContent: "", streamingReasoning: "" };

  it("appends text deltas to the body", () => {
    const once = applyProgressEvent(empty, textEvent("Hel"));
    const twice = applyProgressEvent(once, textEvent("lo"));
    expect(twice).toEqual({ streamingContent: "Hello", streamingReasoning: "" });
  });

  it("renders status events as markdown quote lines in the body", () => {
    const next = applyProgressEvent(empty, statusEvent("🔧 调用工具: get_request_detail"));
    expect(next.streamingContent).toBe(formatStatusLine("🔧 调用工具: get_request_detail"));
    expect(next.streamingContent).toContain("> 🔧 调用工具: get_request_detail");
    expect(next.streamingReasoning).toBe("");
  });

  it("keeps reasoning out of the body", () => {
    const next = applyProgressEvent(
      applyProgressEvent(empty, reasoningEvent("think ")),
      reasoningEvent("more"),
    );
    expect(next).toEqual({ streamingContent: "", streamingReasoning: "think more" });
  });

  it("clears both areas on reset so a retry starts from a blank slate", () => {
    const filled = applyProgressEvent(applyProgressEvent(empty, textEvent("partial")), reasoningEvent("hmm"));
    const next = applyProgressEvent(filled, resetEvent());
    expect(next).toEqual({ streamingContent: "", streamingReasoning: "" });
    expect(applyProgressEvent(next, statusEvent("正在重试")).streamingContent).toContain("> 正在重试");
  });
});

describe("formatStatusLine", () => {
  it("wraps the text in blank lines and a quote marker, trimming stray newlines", () => {
    expect(formatStatusLine("\n\nhello\n")).toBe("\n\n> hello\n\n");
  });
});
