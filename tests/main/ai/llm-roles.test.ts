import { describe, expect, it } from "vitest";
import type { LLMProviderConfig } from "../../../src/shared/types";
import {
  EXTRACT_SPEC_OUTPUT_TOKENS,
  EXTRACT_UNKNOWN_MODEL_OUTPUT_TOKENS,
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
  it("does not follow a small main config down", () => {
    // 主配置是为聊天设的；抽取被截断等于全失败，不能跟着它往下走
    const small = { ...base, maxTokens: 1024, contextBudget: { maxContextTokens: 40_000, autoContextWindow: false } };
    expect(resolveExtractMaxTokens(small, "mystery-1")).toBe(10_000);
    expect(resolveRoleConfig(small, "extract").maxTokens).toBe(10_000);
  });

  it("follows the model's own output limit, up to what a Spec needs", () => {
    // 改之前所有模型都被压在写死的 8192
    const big = { ...base, maxTokens: 1024, contextBudget: { maxContextTokens: 1_000_000, autoContextWindow: false } };
    // 声明得比一份 Spec 需要的还多时，多出来的那部分只会从报告预算里扣，所以不要
    expect(resolveExtractMaxTokens(big, "gpt-5")).toBe(EXTRACT_SPEC_OUTPUT_TOKENS);
    expect(resolveExtractMaxTokens(big, "o3")).toBe(EXTRACT_SPEC_OUTPUT_TOKENS);
    // 声明得少的就按它自己的来，不会被顶上去
    expect(resolveExtractMaxTokens(big, "claude-sonnet-4-5")).toBe(64_000);
    expect(resolveExtractMaxTokens(big, "gpt-4o")).toBe(16_384);
    expect(resolveExtractMaxTokens(big, "claude-3-5-sonnet-20241022")).toBe(8_192);
  });

  it("still lets the window share bound a model that claims a lot", () => {
    // gpt-5 声明 128k 输出，但 200k 窗口里 25% 的份额只有 50k——再多提示词就没地方放了
    const tight = { ...base, maxTokens: 1024, contextBudget: { maxContextTokens: 200_000, autoContextWindow: false } };
    expect(resolveExtractMaxTokens(tight, "gpt-5")).toBe(50_000);
  });

  it("stays conservative for a model the table does not know", () => {
    // 用户实际配置：1M 窗口 + 主配置 4096 输出 + 中转的自定义模型名。
    // 改之前这里是 8192，抽取每次正好吐满 8192、JSON 断在半截。
    const reported = {
      ...base,
      maxTokens: 4_096,
      contextBudget: { maxContextTokens: 1_000_000, autoContextWindow: true },
    };
    expect(resolveExtractMaxTokens(reported, "step-3.7-flash")).toBe(EXTRACT_UNKNOWN_MODEL_OUTPUT_TOKENS);

    // 窗口再大也不替一个不认识的模型开更高的口
    const huge = { ...base, maxTokens: 1024, contextBudget: { maxContextTokens: 4_000_000, autoContextWindow: false } };
    expect(resolveExtractMaxTokens(huge, "mystery-1")).toBe(EXTRACT_UNKNOWN_MODEL_OUTPUT_TOKENS);
  });

  it("respects a model whose own output limit is lower than 8192", () => {
    expect(resolveExtractMaxTokens({ ...base, maxTokens: 1024 }, "claude-3-haiku-20240307")).toBe(4_096);
    expect(resolveExtractMaxTokens({ ...base, maxTokens: 1024 }, "gpt-4-turbo")).toBe(4_096);
  });

  it("keeps a larger user-configured limit", () => {
    // 用户配置比我们自己算出来的目标还大时照样保留（gpt-5 自身上限 128k，400k 窗口份额 100k）
    expect(resolveExtractMaxTokens({ ...base, maxTokens: 80_000 }, "gpt-5")).toBe(80_000);
    // 但仍然不能突破窗口份额
    expect(resolveExtractMaxTokens({ ...base, maxTokens: 200_000 }, "gpt-5")).toBe(100_000);
  });

  it("will not let the output limit eat a small window", () => {
    // 16k 窗口配 8192 输出，提示词就只剩一半，索引加报告根本放不下
    expect(resolveExtractMaxTokens({ ...base, maxTokens: 8_192 }, "gpt-3.5-turbo")).toBe(4_096);

    // 模型认不出来时按配置的窗口算，同样要受份额约束
    const unknownSmall = { ...base, maxTokens: 8_192, contextBudget: { maxContextTokens: 16_000, autoContextWindow: false } };
    expect(resolveExtractMaxTokens(unknownSmall, "mystery-1")).toBe(4_000);

    // 大窗口给到未知模型的保守值
    const unknownLarge = { ...base, maxTokens: 8_192, contextBudget: { maxContextTokens: 200_000, autoContextWindow: false } };
    expect(resolveExtractMaxTokens(unknownLarge, "mystery-1")).toBe(EXTRACT_UNKNOWN_MODEL_OUTPUT_TOKENS);
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
