import type { AiRequestLogType, LLMGenerationOptions, LLMProviderConfig } from "@shared/types";
import { lookupModelContextWindow, resolveContextBudget } from "@shared/model-context-windows";

/** 与 AiRequestLogType 一一对应的调用角色 */
export type LLMRole = AiRequestLogType;

/** 摘要 / 过滤类轻量角色：输出上限压到 1024 就够 */
const SUMMARY_ROLES: ReadonlySet<LLMRole> = new Set(["filter", "compress", "subagent"]);

/** 与历史行为一致的默认轻量上限 */
export const LIGHTWEIGHT_MAX_TOKENS = 1024;
/**
 * 一份 ProtocolSpec 的 JSON 顶天需要多少输出。
 *
 * 不是"模型能吐多少就要多少"——spec-extractor 的报告预算是
 * `窗口 − 输出上限 − 提示词实测 − 余量`，多报的每一个 token 都是从喂进去的报告里扣的。
 * gpt-5 声明 128k 输出，真按 128k 报，400k 窗口里报告就少了 12.8 万 token 的位置。
 */
export const EXTRACT_SPEC_OUTPUT_TOKENS = 65_536;
/**
 * 模型表里查不到输出上限时用的保守值（多半是中转的自定义模型名）。
 * 表里 44 条规则有 32 条的上限不到 64k，对一个不认识的模型报高了会被服务端 400；
 * 认识的模型按它自己声明的来，不受这个值约束。
 */
export const EXTRACT_UNKNOWN_MODEL_OUTPUT_TOKENS = 32_768;
/** 输出上限最多吃掉窗口的这个比例：小窗口模型上大输出会让提示词无处可放 */
export const EXTRACT_OUTPUT_WINDOW_SHARE = 0.25;

export function isLightweightRole(role: LLMRole): boolean {
  return role === "extract" || SUMMARY_ROLES.has(role);
}

/**
 * 抽取角色的输出上限，取三条约束里最小的：
 * 1. 模型自己声明能吐多少（表里没有的保守按 EXTRACT_UNKNOWN_MODEL_OUTPUT_TOKENS 算）；
 * 2. 一份 Spec 顶天需要多少（EXTRACT_SPEC_OUTPUT_TOKENS）——多报的都从报告预算里扣；
 * 3. 窗口能匀出的份额——16k 窗口配 8192 输出，提示词就只剩一半，必然装不下。
 *
 * 但不跟着主配置往下走：主配置是为聊天设的，而抽取被截断等于全失败。
 */
export function resolveExtractMaxTokens(config: LLMProviderConfig, model: string): number {
  const modelCap = lookupModelContextWindow(model)?.maxOutputTokens;
  const window = resolveContextBudget({ model, contextBudget: config.contextBudget }).maxContextTokens;
  const share = Math.floor(window * EXTRACT_OUTPUT_WINDOW_SHARE);
  const target = Math.min(
    modelCap ?? EXTRACT_UNKNOWN_MODEL_OUTPUT_TOKENS,
    EXTRACT_SPEC_OUTPUT_TOKENS,
    share,
  );
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
