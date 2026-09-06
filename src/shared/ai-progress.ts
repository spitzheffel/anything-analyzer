/**
 * AI 分析 / 追问过程中通过 `ai:progress` 推送到渲染进程的流式事件。
 *
 * - text：模型正文增量，直接拼进报告 / 回复正文
 * - reasoning：模型思考过程增量，在界面单独折叠展示，不写入正文
 * - status：过程提示（工具调用、子分析、上下文压缩等），以引用行形式并入正文流
 * - reset：清空当前流式区域（例如整体重试前），避免新旧内容拼在一起
 */
export type AiProgressTextEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "status"; text: string };

export type AiProgressEvent = AiProgressTextEvent | { kind: "reset" };

export type AiProgressListener = (event: AiProgressEvent) => void;

export function textEvent(text: string): AiProgressEvent {
  return { kind: "text", text };
}

export function reasoningEvent(text: string): AiProgressEvent {
  return { kind: "reasoning", text };
}

export function statusEvent(text: string): AiProgressEvent {
  return { kind: "status", text };
}

export function resetEvent(): AiProgressEvent {
  return { kind: "reset" };
}

/**
 * 将 status 事件渲染成与历史行为一致的 markdown 引用行。
 * 调用方约定 text 本身不含前导 "> "。
 */
export function formatStatusLine(text: string): string {
  const trimmed = text.replace(/^\n+|\n+$/g, "");
  return `\n\n> ${trimmed}\n\n`;
}
