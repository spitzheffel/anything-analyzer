import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogWarningsFunction } from "ai";
import { installAiSdkWarningFilter } from "../../../src/main/ai/llm-warnings";

type WarningGlobal = typeof globalThis & { AI_SDK_LOG_WARNINGS?: LogWarningsFunction | false };

describe("installAiSdkWarningFilter", () => {
  let previous: LogWarningsFunction | false | undefined;

  beforeEach(() => {
    previous = (globalThis as WarningGlobal).AI_SDK_LOG_WARNINGS;
    delete (globalThis as WarningGlobal).AI_SDK_LOG_WARNINGS;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    (globalThis as WarningGlobal).AI_SDK_LOG_WARNINGS = previous;
    vi.restoreAllMocks();
  });

  it("swallows the known responseFormat warning but still logs everything else", () => {
    installAiSdkWarningFilter();
    const logger = (globalThis as WarningGlobal).AI_SDK_LOG_WARNINGS;
    expect(typeof logger).toBe("function");

    (logger as LogWarningsFunction)({
      provider: "custom.chat",
      model: "relay",
      warnings: [{ type: "unsupported", feature: "responseFormat", details: "JSON schema only with structuredOutputs" }],
    });
    expect(console.warn).not.toHaveBeenCalled();

    (logger as LogWarningsFunction)({
      provider: "openai.chat",
      model: "gpt-4o",
      warnings: [
        { type: "unsupported", feature: "responseFormat" },
        { type: "unsupported", feature: "topK", details: "not supported" },
      ],
    });
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(String((console.warn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toContain('"topK"');
  });
});
