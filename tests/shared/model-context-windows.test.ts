import { describe, expect, it } from "vitest";
import {
  lookupModelContextWindow,
  normalizeModelId,
  resolveContextBudget,
} from "../../src/shared/model-context-windows";
import { DEFAULT_CONTEXT_BUDGET } from "../../src/shared/context-budget-config";

describe("normalizeModelId", () => {
  it("lowercases and strips provider prefixes", () => {
    expect(normalizeModelId("GPT-4o")).toBe("gpt-4o");
    expect(normalizeModelId("openai/gpt-4.1-mini")).toBe("gpt-4.1-mini");
    expect(normalizeModelId("accounts/fireworks/models/qwen3-235b")).toBe("qwen3-235b");
    expect(normalizeModelId("  claude-sonnet-4-6 ")).toBe("claude-sonnet-4-6");
  });
});

describe("lookupModelContextWindow", () => {
  it("returns null for empty or unknown models", () => {
    expect(lookupModelContextWindow("")).toBeNull();
    expect(lookupModelContextWindow(undefined)).toBeNull();
    expect(lookupModelContextWindow("my-private-finetune")).toBeNull();
  });

  it.each([
    ["gpt-5.2", 400_000],
    ["gpt-5-mini", 400_000],
    ["gpt-4.1", 1_047_576],
    ["gpt-4o-mini", 128 * 1024],
    ["gpt-4-turbo-2024-04-09", 128 * 1024],
    ["gpt-4", 8 * 1024],
    ["o3-mini", 200_000],
    ["o4-mini", 200_000],
    ["claude-sonnet-4-6", 200_000],
    ["claude-opus-4-20250514", 200_000],
    ["claude-3-5-sonnet-20241022", 200_000],
    ["gemini-2.5-pro", 1_048_576],
    ["deepseek-reasoner", 131_072],
    ["deepseek-chat", 131_072],
    ["qwen3-235b-a22b", 131_072],
    ["MiniMax-M2.7", 204_800],
    ["glm-4.6", 204_800],
    ["kimi-k2-0905-preview", 262_144],
    ["grok-4-fast-reasoning", 2_000_000],
    ["anthropic/claude-haiku-4-5", 200_000],
  ])("knows the window of %s", (model, contextTokens) => {
    expect(lookupModelContextWindow(model)?.contextTokens).toBe(contextTokens);
  });

  it("prefers the more specific rule", () => {
    expect(lookupModelContextWindow("gpt-4-32k")?.contextTokens).toBe(32 * 1024);
    expect(lookupModelContextWindow("o1-mini")?.maxOutputTokens).toBe(65_536);
    expect(lookupModelContextWindow("claude-opus-4-1")?.maxOutputTokens).toBe(32_000);
    expect(lookupModelContextWindow("claude-opus-4-6")?.maxOutputTokens).toBe(64_000);
  });
});

describe("resolveContextBudget", () => {
  it("keeps a hand-tuned window for legacy configs without the flag", () => {
    const budget = resolveContextBudget({ model: "gpt-4o", contextBudget: { maxContextTokens: 50_000 } });
    expect(budget.maxContextTokens).toBe(50_000);
    expect(budget.autoContextWindow).toBe(false);
  });

  it("treats legacy configs still on the default window as auto", () => {
    const budget = resolveContextBudget({ model: "gpt-4o", contextBudget: { maxContextTokens: 200_000 } });
    expect(budget.autoContextWindow).toBe(true);
    expect(budget.maxContextTokens).toBe(128 * 1024);
  });

  it("respects an explicit autoContextWindow=false even on the default window", () => {
    const budget = resolveContextBudget({
      model: "gpt-4o",
      contextBudget: { maxContextTokens: 200_000, autoContextWindow: false },
    });
    expect(budget.autoContextWindow).toBe(false);
    expect(budget.maxContextTokens).toBe(200_000);
  });

  it("overrides the window from the lookup table when autoContextWindow is on", () => {
    const budget = resolveContextBudget({
      model: "gpt-4o",
      contextBudget: { maxContextTokens: 50_000, autoContextWindow: true },
    });
    expect(budget.maxContextTokens).toBe(128 * 1024);
    expect(budget.autoContextWindow).toBe(true);
  });

  it("falls back to the configured value when the model is unknown", () => {
    const budget = resolveContextBudget({
      model: "mystery-model",
      contextBudget: { maxContextTokens: 77_000, autoContextWindow: true },
    });
    expect(budget.maxContextTokens).toBe(77_000);
  });

  it("uses defaults (auto window) when no budget is configured", () => {
    const budget = resolveContextBudget({ model: "gpt-4o" });
    expect(budget.autoContextWindow).toBe(true);
    expect(budget.maxContextTokens).toBe(128 * 1024);
    expect(budget.compressionPeak).toBe(DEFAULT_CONTEXT_BUDGET.compressionPeak);
    expect(resolveContextBudget({ model: "unknown-model" }).maxContextTokens).toBe(DEFAULT_CONTEXT_BUDGET.maxContextTokens);
  });

  it("re-clamps the reserved output when the looked-up window is smaller", () => {
    const budget = resolveContextBudget({
      model: "gpt-4",
      contextBudget: { maxContextTokens: 200_000, reserveCompletionTokens: 8_192, autoContextWindow: true },
    });
    expect(budget.maxContextTokens).toBe(8 * 1024);
    expect(budget.reserveCompletionTokens).toBe(4 * 1024);
  });
});
