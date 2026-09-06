import { describe, expect, it } from "vitest";
import {
  clampReserveCompletionTokens,
  DEFAULT_CONTEXT_BUDGET,
  normalizeContextBudget,
} from "../../src/shared/context-budget-config";
import { buildContextUsageSnapshot } from "../../src/shared/token-estimate";

describe("clampReserveCompletionTokens", () => {
  it("keeps sane reserves and caps at half the window", () => {
    expect(clampReserveCompletionTokens(8_192, 200_000)).toBe(8_192);
    expect(clampReserveCompletionTokens(128_000, 128_000)).toBe(64_000);
    expect(clampReserveCompletionTokens(64_000, 200_000)).toBe(64_000);
    expect(clampReserveCompletionTokens(0, 200_000)).toBe(DEFAULT_CONTEXT_BUDGET.reserveCompletionTokens);
    expect(clampReserveCompletionTokens(100, 200_000)).toBe(256);
  });
});

describe("normalizeContextBudget", () => {
  it("returns defaults for an empty budget", () => {
    expect(normalizeContextBudget(undefined)).toEqual(DEFAULT_CONTEXT_BUDGET);
    expect(normalizeContextBudget(null)).toEqual(DEFAULT_CONTEXT_BUDGET);
  });

  it("never lets the reserve starve the input side", () => {
    const budget = normalizeContextBudget({ maxContextTokens: 128_000, reserveCompletionTokens: 128_000 });
    expect(budget.reserveCompletionTokens).toBe(64_000);
  });

  it("infers autoContextWindow for legacy configs", () => {
    expect(normalizeContextBudget({}).autoContextWindow).toBe(true);
    expect(normalizeContextBudget({ maxContextTokens: 200_000 }).autoContextWindow).toBe(true);
    expect(normalizeContextBudget({ maxContextTokens: 128_000 }).autoContextWindow).toBe(false);
    expect(normalizeContextBudget({ maxContextTokens: 200_000, autoContextWindow: false }).autoContextWindow).toBe(false);
    expect(normalizeContextBudget({ maxContextTokens: 128_000, autoContextWindow: true }).autoContextWindow).toBe(true);
  });
});

describe("buildContextUsageSnapshot", () => {
  it("applies the same reserve clamp so the usage bar cannot show a starved budget", () => {
    const snapshot = buildContextUsageSnapshot(1_000, { maxContextTokens: 128_000, reserveCompletionTokens: 128_000 });
    expect(snapshot.reserveCompletionTokens).toBe(64_000);
    expect(snapshot.usableTokens).toBe(64_000);
  });
});
