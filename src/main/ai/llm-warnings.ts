import type { LogWarningsFunction } from "ai";

/**
 * AI SDK 会把 provider 返回的 warning 直接打到 process.emitWarning。
 * 其中"responseFormat 不支持"在通用 OpenAI 兼容中转上每次结构化抽取都会出现一次，
 * 我们已经把 schema 写进提示词处理过了，属于已知噪音；其余 warning 照常输出。
 */
const IGNORED_UNSUPPORTED_FEATURES: ReadonlySet<string> = new Set(["responseFormat"]);

type WarningLoggerGlobal = typeof globalThis & { AI_SDK_LOG_WARNINGS?: LogWarningsFunction | false };

let installed = false;

export function installAiSdkWarningFilter(): void {
  if (installed) return;
  installed = true;
  const target = globalThis as WarningLoggerGlobal;
  // 用户或测试已经显式关掉 / 接管日志时不覆盖
  if (target.AI_SDK_LOG_WARNINGS !== undefined) return;

  target.AI_SDK_LOG_WARNINGS = ({ warnings, provider, model }) => {
    const remaining = warnings.filter((warning) =>
      !(warning.type === "unsupported" && IGNORED_UNSUPPORTED_FEATURES.has(warning.feature)));
    if (remaining.length === 0) return;
    const scope = provider ? ` (${provider}${model ? ` / ${model}` : ""})` : "";
    for (const warning of remaining) {
      const detail = "details" in warning && warning.details ? `: ${warning.details}` : "";
      const feature = "feature" in warning ? ` "${warning.feature}"` : "";
      console.warn(`[AI SDK]${scope} ${warning.type}${feature}${detail}`);
    }
  };
}
