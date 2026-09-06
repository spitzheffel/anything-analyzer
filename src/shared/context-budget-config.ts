import type { ContextBudgetConfig, ContextMode, CompressionMode } from "./types";

export const DEFAULT_CONTEXT_BUDGET: ContextBudgetConfig = {
  maxContextTokens: 200_000,
  compressionPeak: 0.85,
  compressionTarget: 0.55,
  reserveCompletionTokens: 8_192,
  contextMode: "index_first",
  compressionMode: "rules",
  subagentEnabled: true,
  subagentThreshold: 400,
  subagentChunkSize: 120,
  maxSubagents: 3,
  autoContextWindow: true,
};

/** 预留输出最多占窗口的这个比例，避免把输入侧饿死 */
export const MAX_RESERVE_RATIO = 0.5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 预留输出 tokens 的下限 256，上限为窗口的一半。
 */
export function clampReserveCompletionTokens(reserve: number, maxContextTokens: number): number {
  const requested = Math.max(256, Math.floor(reserve || DEFAULT_CONTEXT_BUDGET.reserveCompletionTokens));
  const ceiling = Math.max(256, Math.floor(maxContextTokens * MAX_RESERVE_RATIO));
  return Math.min(requested, ceiling);
}

/**
 * 旧配置没有 autoContextWindow 字段：如果用户从没动过窗口值（缺省或等于默认 200000），
 * 视为希望自动匹配；填过具体数值的则尊重手填值。
 */
function inferAutoContextWindow(partial: Partial<ContextBudgetConfig> | null | undefined): boolean {
  if (partial?.autoContextWindow !== undefined) return partial.autoContextWindow === true;
  const configured = partial?.maxContextTokens;
  return configured === undefined || configured === DEFAULT_CONTEXT_BUDGET.maxContextTokens;
}

export function normalizeContextBudget(
  partial?: Partial<ContextBudgetConfig> | null,
): ContextBudgetConfig {
  const merged: ContextBudgetConfig = {
    ...DEFAULT_CONTEXT_BUDGET,
    ...(partial ?? {}),
  };

  const contextMode: ContextMode =
    merged.contextMode === "legacy_inline" ? "legacy_inline" : "index_first";
  const compressionMode: CompressionMode =
    merged.compressionMode === "hybrid" ? "hybrid" : "rules";
  const maxContextTokens = Math.max(4_096, Math.floor(merged.maxContextTokens || DEFAULT_CONTEXT_BUDGET.maxContextTokens));

  return {
    maxContextTokens,
    compressionPeak: clamp(merged.compressionPeak || DEFAULT_CONTEXT_BUDGET.compressionPeak, 0.5, 0.95),
    compressionTarget: clamp(merged.compressionTarget || DEFAULT_CONTEXT_BUDGET.compressionTarget, 0.2, 0.8),
    reserveCompletionTokens: clampReserveCompletionTokens(merged.reserveCompletionTokens, maxContextTokens),
    contextMode,
    compressionMode,
    subagentEnabled: merged.subagentEnabled !== false,
    subagentThreshold: Math.max(100, Math.floor(merged.subagentThreshold || DEFAULT_CONTEXT_BUDGET.subagentThreshold)),
    subagentChunkSize: Math.max(40, Math.min(250, Math.floor(merged.subagentChunkSize || DEFAULT_CONTEXT_BUDGET.subagentChunkSize))),
    maxSubagents: Math.max(1, Math.min(8, Math.floor(merged.maxSubagents || DEFAULT_CONTEXT_BUDGET.maxSubagents))),
    autoContextWindow: inferAutoContextWindow(partial),
  };
}
