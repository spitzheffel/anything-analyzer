import type { CapturedRequest, ChatMessage, JsHookRecord } from "@shared/types";
import { CITATION_RULE } from "./prompt-builder";

const REQUEST_SUMMARY_LIMIT = 50;
const HOOK_SUMMARY_LIMIT = 20;

export interface FollowUpPromptInput {
  requests: Pick<CapturedRequest, "sequence" | "method" | "url" | "status_code">[];
  hooks: Pick<JsHookRecord, "hook_type" | "function_name">[];
}

/**
 * 追问对话的 system prompt。渲染进程、MCP 与主进程都从这里取，避免三处各写一份。
 */
export function buildFollowUpSystemPrompt(input: FollowUpPromptInput): string {
  const reqSummary = input.requests.slice(0, REQUEST_SUMMARY_LIMIT).map((r) => {
    let path = r.url;
    try {
      path = new URL(r.url).pathname;
    } catch {
      /* keep full url */
    }
    return `#${r.sequence} ${r.method} ${path} → ${r.status_code ?? "?"}`;
  }).join("\n");

  const hookSummary = input.hooks.length > 0
    ? "\n\nDetected hooks:\n" + input.hooks.slice(0, HOOK_SUMMARY_LIMIT).map((h) => `[${h.hook_type}] ${h.function_name}`).join("\n")
    : "";

  const contextBlock = reqSummary
    ? `\n\n<captured_data_summary>\nCaptured ${input.requests.length} requests:\n${reqSummary}${input.requests.length > REQUEST_SUMMARY_LIMIT ? `\n... and ${input.requests.length - REQUEST_SUMMARY_LIMIT} more` : ""}${hookSummary}\n</captured_data_summary>`
    : "";

  return `你是一位网站协议分析专家。基于之前的分析报告和捕获数据，回答用户的追问。保持技术精确，用中文回复。

你可以使用 get_request_detail 工具，通过传入请求序号(seq)来查看任意请求的完整详情（请求头、请求体、响应头、响应体）。当用户追问某个具体请求或需要更多细节时，请主动调用此工具获取数据。${CITATION_RULE}${contextBlock}`;
}

/**
 * 一份报告的初始对话：system prompt + 报告正文作为 assistant 首条消息。
 */
export function buildInitialChatMessages(input: FollowUpPromptInput, reportContent: string): ChatMessage[] {
  return [
    { role: "system", content: buildFollowUpSystemPrompt(input) },
    { role: "assistant", content: reportContent },
  ];
}
