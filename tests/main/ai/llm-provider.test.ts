import { describe, expect, it } from "vitest";
import type { LLMProviderConfig } from "../../../src/shared/types";
import {
  buildCallSettings,
  createLanguageModel,
  isAnthropicCompatible,
  mapReasoningEffort,
} from "../../../src/main/ai/llm-provider";

const base: LLMProviderConfig = {
  name: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "sk-test",
  model: "gpt-4o",
  maxTokens: 2048,
};

const noopFetch = (async () => new Response("{}")) as unknown as typeof fetch;

describe("createLanguageModel", () => {
  it("routes anthropic and minimax to the Anthropic provider", () => {
    for (const name of ["anthropic", "minimax"] as const) {
      const model = createLanguageModel({ ...base, name, model: "claude-x" }, noopFetch);
      expect(typeof model).toBe("object");
      expect((model as { provider: string }).provider).toContain(name);
      expect((model as { modelId: string }).modelId).toBe("claude-x");
    }
  });

  it("routes openai completions to the chat model and responses to the responses model", () => {
    const chat = createLanguageModel({ ...base, apiType: "completions" }, noopFetch) as { provider: string };
    const responses = createLanguageModel({ ...base, apiType: "responses" }, noopFetch) as { provider: string };
    expect(chat.provider).toBe("openai.chat");
    expect(responses.provider).toBe("openai.responses");
  });

  it("routes custom providers to openai-compatible chat, or openai responses when asked", () => {
    const compat = createLanguageModel({ ...base, name: "custom", baseUrl: "https://relay.test/v1" }, noopFetch) as { provider: string };
    const responses = createLanguageModel({ ...base, name: "custom", apiType: "responses" }, noopFetch) as { provider: string };
    expect(compat.provider).toBe("custom.chat");
    expect(responses.provider).toBe("custom.responses");
  });
});

describe("mapReasoningEffort", () => {
  it("maps app levels onto AI SDK levels and drops none", () => {
    expect(mapReasoningEffort(undefined)).toBeUndefined();
    expect(mapReasoningEffort("none")).toBeUndefined();
    expect(mapReasoningEffort("low")).toBe("low");
    expect(mapReasoningEffort("medium")).toBe("medium");
    expect(mapReasoningEffort("high")).toBe("high");
    expect(mapReasoningEffort("max")).toBe("xhigh");
  });
});

describe("buildCallSettings", () => {
  it("sends nothing but maxOutputTokens by default", () => {
    expect(buildCallSettings(base)).toEqual({ maxOutputTokens: 2048 });
  });

  it("maps temperature and reasoning", () => {
    const settings = buildCallSettings({ ...base, generation: { temperature: 0.5, reasoningEffort: "medium" } });
    expect(settings.temperature).toBe(0.5);
    expect(settings.reasoning).toBe("medium");
    expect(settings.providerOptions).toBeUndefined();
  });

  it("ignores non-finite temperature", () => {
    expect(buildCallSettings({ ...base, generation: { temperature: Number.NaN } }).temperature).toBeUndefined();
  });

  it("maps fastMode per provider and ignores it for custom", () => {
    expect(buildCallSettings({ ...base, generation: { fastMode: true } }).providerOptions).toEqual({
      openai: { serviceTier: "fast" },
    });
    expect(buildCallSettings({ ...base, name: "anthropic", generation: { fastMode: true } }).providerOptions).toEqual({
      anthropic: { speed: "fast" },
    });
    expect(buildCallSettings({ ...base, name: "minimax", generation: { fastMode: true } }).providerOptions).toEqual({
      anthropic: { speed: "fast" },
    });
    expect(buildCallSettings({ ...base, name: "custom", generation: { fastMode: true } }).providerOptions).toBeUndefined();
  });

  it("uses anthropic budget thinking instead of top-level reasoning when thinkingBudgetTokens is set", () => {
    const settings = buildCallSettings({
      ...base,
      name: "anthropic",
      generation: { reasoningEffort: "high", thinkingBudgetTokens: 3000.7 },
    });
    expect(settings.reasoning).toBeUndefined();
    expect(settings.providerOptions).toEqual({ anthropic: { thinking: { type: "enabled", budgetTokens: 3000 } } });
  });

  it("ignores thinkingBudgetTokens for non-anthropic providers and falls back to reasoning", () => {
    const settings = buildCallSettings({ ...base, generation: { reasoningEffort: "low", thinkingBudgetTokens: 3000 } });
    expect(settings.reasoning).toBe("low");
    expect(settings.providerOptions).toBeUndefined();
  });
});

describe("isAnthropicCompatible", () => {
  it("recognises anthropic and minimax only", () => {
    expect(isAnthropicCompatible({ name: "anthropic" })).toBe(true);
    expect(isAnthropicCompatible({ name: "minimax" })).toBe(true);
    expect(isAnthropicCompatible({ name: "openai" })).toBe(false);
    expect(isAnthropicCompatible({ name: "custom" })).toBe(false);
  });
});
