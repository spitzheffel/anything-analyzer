import type { ContextBudgetConfig, LLMProviderConfig } from "./types";
import { clampReserveCompletionTokens, normalizeContextBudget } from "./context-budget-config";

export interface ModelContextWindow {
  /** 模型总上下文窗口（输入 + 输出），单位 token */
  contextTokens: number;
  /** 模型单次最大输出，单位 token */
  maxOutputTokens: number;
}

interface ModelWindowRule {
  pattern: RegExp;
  contextTokens: number;
  maxOutputTokens: number;
}

const K = 1_024;

/**
 * 常见模型家族的上下文窗口。规则按顺序匹配，更具体的放前面。
 * 数值取厂商公开的默认窗口（不含需要 beta 头的扩展窗口），拿不准时偏保守。
 */
const MODEL_WINDOW_RULES: ModelWindowRule[] = [
  // ---- OpenAI ----
  { pattern: /^gpt-5/, contextTokens: 400_000, maxOutputTokens: 128_000 },
  { pattern: /^gpt-4\.1/, contextTokens: 1_047_576, maxOutputTokens: 32_768 },
  { pattern: /^(gpt-4o|chatgpt-4o)/, contextTokens: 128 * K, maxOutputTokens: 16_384 },
  { pattern: /^gpt-4-turbo/, contextTokens: 128 * K, maxOutputTokens: 4_096 },
  { pattern: /^gpt-4-32k/, contextTokens: 32 * K, maxOutputTokens: 32 * K },
  { pattern: /^gpt-4(-|$)/, contextTokens: 8 * K, maxOutputTokens: 8 * K },
  { pattern: /^gpt-3\.5/, contextTokens: 16_385, maxOutputTokens: 4_096 },
  { pattern: /^gpt-oss/, contextTokens: 131_072, maxOutputTokens: 131_072 },
  { pattern: /^o1-mini/, contextTokens: 128 * K, maxOutputTokens: 65_536 },
  { pattern: /^(o1|o3|o4)(-|$)/, contextTokens: 200_000, maxOutputTokens: 100_000 },

  // ---- Anthropic ----
  { pattern: /^claude-3-5/, contextTokens: 200_000, maxOutputTokens: 8_192 },
  { pattern: /^claude-3-7/, contextTokens: 200_000, maxOutputTokens: 64_000 },
  { pattern: /^claude-3-haiku|^claude-3-opus|^claude-3-sonnet/, contextTokens: 200_000, maxOutputTokens: 4_096 },
  { pattern: /^claude-opus-4(-0|-1|-20)/, contextTokens: 200_000, maxOutputTokens: 32_000 },
  { pattern: /^claude-/, contextTokens: 200_000, maxOutputTokens: 64_000 },

  // ---- Google ----
  { pattern: /^gemini-2\.0-flash/, contextTokens: 1_048_576, maxOutputTokens: 8_192 },
  { pattern: /^gemini-(2\.5|3)/, contextTokens: 1_048_576, maxOutputTokens: 65_536 },
  { pattern: /^gemini-1\.5-pro/, contextTokens: 2_097_152, maxOutputTokens: 8_192 },
  { pattern: /^gemini-1\.5/, contextTokens: 1_048_576, maxOutputTokens: 8_192 },

  // ---- DeepSeek ----
  { pattern: /^deepseek-reasoner|^deepseek-r1/, contextTokens: 131_072, maxOutputTokens: 65_536 },
  { pattern: /^deepseek/, contextTokens: 131_072, maxOutputTokens: 8_192 },

  // ---- Qwen ----
  { pattern: /^qwen-turbo/, contextTokens: 1_000_000, maxOutputTokens: 16_384 },
  { pattern: /^qwen-max/, contextTokens: 32_768, maxOutputTokens: 8_192 },
  { pattern: /^qwen3|^qwen-plus|^qwq|^qwen-long/, contextTokens: 131_072, maxOutputTokens: 32_768 },
  { pattern: /^qwen/, contextTokens: 131_072, maxOutputTokens: 8_192 },

  // ---- MiniMax ----
  { pattern: /^minimax-m1/, contextTokens: 1_000_000, maxOutputTokens: 80_000 },
  { pattern: /^minimax-m2/, contextTokens: 204_800, maxOutputTokens: 131_072 },
  { pattern: /^minimax-text-01|^abab/, contextTokens: 1_000_000, maxOutputTokens: 8_192 },

  // ---- Zhipu GLM ----
  { pattern: /^glm-4\.5/, contextTokens: 131_072, maxOutputTokens: 98_304 },
  { pattern: /^glm-(4\.[6-9]|5)/, contextTokens: 204_800, maxOutputTokens: 131_072 },
  { pattern: /^glm-4/, contextTokens: 131_072, maxOutputTokens: 4_096 },

  // ---- Moonshot Kimi ----
  { pattern: /^kimi-k2/, contextTokens: 262_144, maxOutputTokens: 32_768 },
  { pattern: /^moonshot-v1-8k/, contextTokens: 8 * K, maxOutputTokens: 4_096 },
  { pattern: /^moonshot-v1-32k/, contextTokens: 32 * K, maxOutputTokens: 8_192 },
  { pattern: /^moonshot-v1-128k/, contextTokens: 128 * K, maxOutputTokens: 16_384 },

  // ---- xAI Grok ----
  { pattern: /^grok-4-fast|^grok-4-1-fast/, contextTokens: 2_000_000, maxOutputTokens: 32_768 },
  { pattern: /^grok-4/, contextTokens: 262_144, maxOutputTokens: 32_768 },
  { pattern: /^grok-3/, contextTokens: 131_072, maxOutputTokens: 16_384 },

  // ---- Mistral ----
  { pattern: /^codestral/, contextTokens: 262_144, maxOutputTokens: 32_768 },
  { pattern: /^mistral-(large|medium|small)|^magistral|^devstral/, contextTokens: 131_072, maxOutputTokens: 32_768 },

  // ---- Meta Llama ----
  { pattern: /^(meta-)?llama-?4/, contextTokens: 1_048_576, maxOutputTokens: 32_768 },
  { pattern: /^(meta-)?llama-?3\.[1-3]/, contextTokens: 131_072, maxOutputTokens: 32_768 },

  // ---- ByteDance Doubao ----
  { pattern: /^doubao-seed-1\.[6-9]/, contextTokens: 262_144, maxOutputTokens: 32_768 },
  { pattern: /^doubao/, contextTokens: 131_072, maxOutputTokens: 16_384 },
];

/**
 * 归一化模型 ID：去掉 "openai/"、"accounts/fireworks/models/" 这类前缀，转小写。
 */
export function normalizeModelId(modelId: string): string {
  const trimmed = modelId.trim().toLowerCase();
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

export function lookupModelContextWindow(modelId: string | undefined | null): ModelContextWindow | null {
  if (!modelId) return null;
  const normalized = normalizeModelId(modelId);
  if (!normalized) return null;
  for (const rule of MODEL_WINDOW_RULES) {
    if (rule.pattern.test(normalized)) {
      return { contextTokens: rule.contextTokens, maxOutputTokens: rule.maxOutputTokens };
    }
  }
  return null;
}

/**
 * 在 normalizeContextBudget 之上，按 autoContextWindow 用模型查表值覆盖 maxContextTokens。
 * 查不到表时保留用户配置值。
 */
export function resolveContextBudget(
  config: Pick<LLMProviderConfig, "model" | "contextBudget">,
): ContextBudgetConfig {
  const budget = normalizeContextBudget(config.contextBudget);
  if (!budget.autoContextWindow) return budget;
  const window = lookupModelContextWindow(config.model);
  if (!window) return budget;
  return {
    ...budget,
    maxContextTokens: window.contextTokens,
    // 窗口变小后预留也要跟着重新钳一次
    reserveCompletionTokens: clampReserveCompletionTokens(budget.reserveCompletionTokens, window.contextTokens),
  };
}
