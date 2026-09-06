import type { AiRequestLogType, LLMGenerationOptions, LLMProviderConfig } from "@shared/types";
import { lookupModelContextWindow } from "@shared/model-context-windows";

/** 与 AiRequestLogType 一一对应的调用角色 */
export type LLMRole = AiRequestLogType;

/** 摘要 / 过滤类轻量角色：输出上限压到 1024 就够 */
const SUMMARY_ROLES: ReadonlySet<LLMRole> = new Set(["filter", "compress", "subagent"]);

/** 与历史行为一致的默认轻量上限 */
export const LIGHTWEIGHT_MAX_TOKENS = 1024;
/** 结构化抽取要装下整份 Spec；被截断的 JSON 等于全失败，所以不能跟着主配置往下压 */
export const EXTRACT_MAX_TOKENS = 8192;

export function isLightweightRole(role: LLMRole): boolean {
  return role === "extract" || SUMMARY_ROLES.has(role);
}

/**
 * 抽取角色的输出上限：至少 8192（或模型自身能给的最大输出），且不低于用户主配置。
 */
export function resolveExtractMaxTokens(config: LLMProviderConfig, model: string): number {
  const modelCap = lookupModelContextWindow(model)?.maxOutputTokens;
  const target = modelCap !== undefined ? Math.min(EXTRACT_MAX_TOKENS, modelCap) : EXTRACT_MAX_TOKENS;
  return Math.max(config.maxTokens || 0, target);
}

/**
 * 按角色派生实际调用配置。
 * - analyze / chat：原样使用主配置
 * - filter / compress / subagent：换用 lightweightModel（若配置），关闭思考与快速模式，输出上限压到 1024
 * - extract：同上换模型 / 关思考，但输出上限放宽（见 resolveExtractMaxTokens）
 */
export function resolveRoleConfig(config: LLMProviderConfig, role: LLMRole): LLMProviderConfig {
  if (!isLightweightRole(role)) return config;

  const lightweightModel = config.lightweightModel?.trim();
  const model = lightweightModel || config.model;
  const maxTokens = role === "extract"
    ? resolveExtractMaxTokens(config, model)
    : Math.min(config.maxTokens || LIGHTWEIGHT_MAX_TOKENS, LIGHTWEIGHT_MAX_TOKENS);
  const generation: LLMGenerationOptions = { reasoningEffort: "none", fastMode: false };
  if (config.generation?.temperature !== undefined) generation.temperature = config.generation.temperature;
  if (config.generation?.extraBody) generation.extraBody = config.generation.extraBody;

  return {
    ...config,
    model,
    maxTokens,
    generation,
  };
}
