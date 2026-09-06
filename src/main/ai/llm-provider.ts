import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel, streamText } from "ai";
import type { LLMProviderConfig, ReasoningEffort } from "@shared/types";
import type { FetchLike } from "./llm-fetch";
import { installAiSdkWarningFilter } from "./llm-warnings";

type StreamTextOptions = Parameters<typeof streamText>[0];
export type ProviderOptions = NonNullable<StreamTextOptions["providerOptions"]>;
export type SdkReasoning = NonNullable<StreamTextOptions["reasoning"]>;

export interface LLMCallSettings {
  maxOutputTokens: number;
  temperature?: number;
  reasoning?: SdkReasoning;
  providerOptions?: ProviderOptions;
}

export const ANTHROPIC_COMPATIBLE_PROVIDERS: ReadonlySet<LLMProviderConfig["name"]> = new Set(["anthropic", "minimax"]);

export function isAnthropicCompatible(config: Pick<LLMProviderConfig, "name">): boolean {
  return ANTHROPIC_COMPATIBLE_PROVIDERS.has(config.name);
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/**
 * 按 provider / apiType 选择 AI SDK provider 并实例化模型。
 * 所有 HTTP 都经由传入的 fetch（日志 / 超时 / extraBody 在那一层处理）。
 */
export function createLanguageModel(config: LLMProviderConfig, fetchImpl: FetchLike): LanguageModel {
  installAiSdkWarningFilter();
  const baseURL = normalizeBaseUrl(config.baseUrl);
  const apiKey = config.apiKey;
  const fetch = fetchImpl as typeof globalThis.fetch;

  if (isAnthropicCompatible(config)) {
    return createAnthropic({ baseURL, apiKey, fetch, name: config.name })(config.model);
  }

  const useResponses = config.apiType === "responses";

  if (config.name === "openai") {
    const openai = createOpenAI({ baseURL, apiKey, fetch });
    return useResponses ? openai.responses(config.model) : openai.chat(config.model);
  }

  if (useResponses) {
    return createOpenAI({ baseURL, apiKey, fetch, name: "custom" }).responses(config.model);
  }

  return createOpenAICompatible({
    name: "custom",
    baseURL,
    apiKey,
    fetch,
    includeUsage: true,
  }).chatModel(config.model);
}

const REASONING_TO_SDK: Record<Exclude<ReasoningEffort, "none">, SdkReasoning> = {
  low: "low",
  medium: "medium",
  high: "high",
  max: "xhigh",
};

export function mapReasoningEffort(effort: ReasoningEffort | undefined): SdkReasoning | undefined {
  if (!effort || effort === "none") return undefined;
  return REASONING_TO_SDK[effort];
}

/**
 * 把配置里的生成参数映射为 streamText 的调用参数。
 * 默认什么都不发送，只有用户显式设置的才带上，避免中转站不兼容。
 */
export function buildCallSettings(config: LLMProviderConfig): LLMCallSettings {
  const generation = config.generation ?? {};
  const settings: LLMCallSettings = { maxOutputTokens: config.maxTokens };

  if (typeof generation.temperature === "number" && Number.isFinite(generation.temperature)) {
    settings.temperature = generation.temperature;
  }

  const anthropicLike = isAnthropicCompatible(config);
  const providerOptions: ProviderOptions = {};
  const anthropicOptions: Record<string, unknown> = {};
  const openaiOptions: Record<string, unknown> = {};

  const budget = generation.thinkingBudgetTokens;
  const hasBudget = anthropicLike && typeof budget === "number" && Number.isFinite(budget) && budget > 0;
  if (hasBudget) {
    anthropicOptions.thinking = { type: "enabled", budgetTokens: Math.floor(budget) };
  } else {
    const reasoning = mapReasoningEffort(generation.reasoningEffort);
    if (reasoning) settings.reasoning = reasoning;
  }

  if (generation.fastMode) {
    if (anthropicLike) anthropicOptions.speed = "fast";
    else if (config.name === "openai") openaiOptions.serviceTier = "fast";
  }

  if (Object.keys(anthropicOptions).length > 0) {
    providerOptions.anthropic = anthropicOptions as ProviderOptions[string];
  }
  if (Object.keys(openaiOptions).length > 0) {
    providerOptions.openai = openaiOptions as ProviderOptions[string];
  }
  if (Object.keys(providerOptions).length > 0) {
    settings.providerOptions = providerOptions;
  }

  return settings;
}
