import type { AiRequestLogType, LLMGenerationOptions, LLMProviderConfig } from "@shared/types";
import { lookupModelContextWindow, resolveContextBudget } from "@shared/model-context-windows";

/** 与 AiRequestLogType 一一对应的调用角色 */
export type LLMRole = AiRequestLogType;

/** 摘要 / 过滤类轻量角色：输出上限压到 1024 就够 */
const SUMMARY_ROLES: ReadonlySet<LLMRole> = new Set(["filter", "compress", "subagent"]);

/** 与历史行为一致的默认轻量上限 */
export const LIGHTWEIGHT_MAX_TOKENS = 1024;
/**
 * 抽取输出的封顶值。原来这里是写死的 8192，实测 465 条请求的会话每次都正好吐满 8192、
 * JSON 断在半截——而被截断的 JSON 等于全失败。但也不能按窗口无限放大：1M 窗口按份额
 * 算出来是 25 万，没有服务端会接受这个输出上限。
 */
export const EXTRACT_MAX_OUTPUT_TOKENS = 32_768;
/** 输出上限最多吃掉窗口的这个比例：小窗口模型上大输出会让提示词无处可放 */
export const EXTRACT_OUTPUT_WINDOW_SHARE = 0.25;

export function isLightweightRole(role: LLMRole): boolean {
  return role === "extract" || SUMMARY_ROLES.has(role);
}

/**
 * 抽取角色的输出上限：按窗口份额给，封顶 EXTRACT_MAX_OUTPUT_TOKENS，且不低于用户主配置，
 * 但都不能突破模型自身的输出能力和窗口能承受的份额——16k 窗口配 8192 输出，
 * 提示词就只剩一半，必然装不下。
 */
export function resolveExtractMaxTokens(config: LLMProviderConfig, model: string): number {
  const modelCap = lookupModelContextWindow(model)?.maxOutputTokens;
  const window = resolveContextBudget({ model, contextBudget: config.contextBudget }).maxContextTokens;
  const share = Math.floor(window * EXTRACT_OUTPUT_WINDOW_SHARE);
  // 不看主配置：抽取被截断等于全失败，不能跟着一个为聊天设的小 maxTokens 往下走
  const target = Math.min(EXTRACT_MAX_OUTPUT_TOKENS, share);
  const ceiling = Math.max(1_024, Math.min(modelCap ?? window, share));
  return Math.min(Math.max(config.maxTokens || 0, target), ceiling);
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
