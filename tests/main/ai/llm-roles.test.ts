import { describe, expect, it } from "vitest";
import type { LLMProviderConfig } from "../../../src/shared/types";
import {
  EXTRACT_MAX_TOKENS,
  isLightweightRole,
  LIGHTWEIGHT_MAX_TOKENS,
  resolveExtractMaxTokens,
  resolveRoleConfig,
} from "../../../src/main/ai/llm-roles";

const base: LLMProviderConfig = {
  name: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-test",
  model: "gpt-5",
  maxTokens: 8192,
  lightweightModel: "gpt-5-mini",
  generation: { reasoningEffort: "high", fastMode: true, temperature: 0.4, thinkingBudgetTokens: 2048, extraBody: { top_k: 3 } },
  contextBudget: { maxContextTokens: 400_000 },
};

describe("isLightweightRole", () => {
  it("treats filter/compress/subagent/extract as lightweight and analyze/chat as main", () => {
    expect(isLightweightRole("filter")).toBe(true);
    expect(isLightweightRole("compress")).toBe(true);
    expect(isLightweightRole("subagent")).toBe(true);
    expect(isLightweightRole("extract")).toBe(true);
    expect(isLightweightRole("analyze")).toBe(false);
    expect(isLightweightRole("chat")).toBe(false);
  });
});

describe("extract role output cap", () => {
  it("never shrinks below 8192 just because the main config is small", () => {
    expect(resolveExtractMaxTokens({ ...base, maxTokens: 1024 }, "gpt-5-mini")).toBe(EXTRACT_MAX_TOKENS);
    expect(resolveRoleConfig({ ...base, maxTokens: 1024 }, "extract").maxTokens).toBe(EXTRACT_MAX_TOKENS);
  });

  it("respects a model whose own output limit is lower than 8192", () => {
    expect(resolveExtractMaxTokens({ ...base, maxTokens: 1024 }, "claude-3-haiku-20240307")).toBe(4_096);
    expect(resolveExtractMaxTokens({ ...base, maxTokens: 1024 }, "gpt-4-turbo")).toBe(4_096);
  });

  it("keeps a larger user-configured limit", () => {
    expect(resolveExtractMaxTokens({ ...base, maxTokens: 32_000 }, "gpt-5")).toBe(32_000);
  });

  it("uses the lightweight model when deciding the cap", () => {
    const resolved = resolveRoleConfig({ ...base, maxTokens: 512, lightweightModel: "gpt-4-turbo" }, "extract");
    expect(resolved.model).toBe("gpt-4-turbo");
    expect(resolved.maxTokens).toBe(4_096);
    expect(resolved.generation?.reasoningEffort).toBe("none");
  });
});

describe("resolveRoleConfig", () => {
  it("returns the main config untouched for analyze and chat", () => {
    expect(resolveRoleConfig(base, "analyze")).toBe(base);
    expect(resolveRoleConfig(base, "chat")).toBe(base);
  });

  it("switches summary roles to the lightweight model, disables thinking/fast mode and caps output at 1024", () => {
    for (const role of ["filter", "compress", "subagent"] as const) {
      const resolved = resolveRoleConfig(base, role);
      expect(resolved.model).toBe("gpt-5-mini");
      expect(resolved.maxTokens).toBe(LIGHTWEIGHT_MAX_TOKENS);
      expect(resolved.generation).toEqual({
        reasoningEffort: "none",
        fastMode: false,
        temperature: 0.4,
        extraBody: { top_k: 3 },
      });
      // provider / credentials / context budget stay shared
      expect(resolved.baseUrl).toBe(base.baseUrl);
      expect(resolved.apiKey).toBe(base.apiKey);
      expect(resolved.contextBudget).toBe(base.contextBudget);
    }
  });

  it("falls back to the main model when lightweightModel is empty", () => {
    expect(resolveRoleConfig({ ...base, lightweightModel: "   " }, "filter").model).toBe("gpt-5");
    expect(resolveRoleConfig({ ...base, lightweightModel: undefined }, "subagent").model).toBe("gpt-5");
  });

  it("never raises maxTokens above the main config", () => {
    expect(resolveRoleConfig({ ...base, maxTokens: 512 }, "compress").maxTokens).toBe(512);
  });

  it("handles a config without generation", () => {
    const resolved = resolveRoleConfig({ ...base, generation: undefined }, "filter");
    expect(resolved.generation).toEqual({ reasoningEffort: "none", fastMode: false });
  });
});
