import type { LLMProviderConfig, RequestSummary } from "@shared/types";
import {
  ProtocolSpecSchema,
  sanitizeSpecReferences,
  type ProtocolSpec,
  type SessionEnrichment,
} from "@shared/protocol-spec";
import { extractCitedSeqs } from "@shared/citations";
import { resolveContextBudget } from "@shared/model-context-windows";
import { estimateTextTokens } from "@shared/token-estimate";
import type { LLMRouter } from "./llm-router";
import { PromptBuilder } from "./prompt-builder";
import type { MessageLike } from "./context-budget";

/** 索引超过这个数时，只给报告引用过的 + 头部这么多条 */
const INDEX_HEAD_LIMIT = 120;
/** 报告正文喂给抽取器的上限（token）；再大也没必要 */
export const MAX_REPORT_TOKENS = 20_000;
/** 报告正文至少保留这么多 token，再少抽不出东西 */
export const MIN_REPORT_TOKENS = 3_000;
/** 索引（最多 120 行）+ 系统提示 + 线索 + schema 提示的预留，单位 token */
const PROMPT_OVERHEAD_TOKENS = 12_000;
const REPORT_TRUNCATION_MARKER = "\n...[报告过长，已截断]";

export interface SpecExtractionInput {
  reportContent: string;
  summaries: RequestSummary[];
  enrichment: SessionEnrichment | null;
  purpose?: string | null;
  /** 报告正文 token 上限；不传则按 MAX_REPORT_TOKENS */
  maxReportTokens?: number;
}

/**
 * 按抽取角色的上下文窗口算报告正文能塞多少 token：窗口 − 输出上限 − 提示词预留。
 */
export function computeReportTokenBudget(extractConfig: LLMProviderConfig): number {
  const budget = resolveContextBudget(extractConfig);
  const inputTokens = budget.maxContextTokens - extractConfig.maxTokens - PROMPT_OVERHEAD_TOKENS;
  return Math.max(MIN_REPORT_TOKENS, Math.min(MAX_REPORT_TOKENS, inputTokens));
}

/**
 * 按 token 预算截取报告开头：用项目自带的中英混排估算器二分找最长合法前缀，
 * 比固定"每 token N 个字符"的折算对中文靠谱得多。
 */
export function truncateReportToTokenBudget(report: string, maxTokens: number): string {
  if (estimateTextTokens(report) <= maxTokens) return report;
  const markerTokens = estimateTextTokens(REPORT_TRUNCATION_MARKER);
  const bodyBudget = Math.max(1, maxTokens - markerTokens);
  let low = 0;
  let high = report.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateTextTokens(report.slice(0, mid)) <= bodyBudget) low = mid;
    else high = mid - 1;
  }
  return `${report.slice(0, low)}${REPORT_TRUNCATION_MARKER}`;
}

export interface SpecExtractionResult {
  spec: ProtocolSpec;
  promptTokens: number;
  completionTokens: number;
  degraded: boolean;
}

const SYSTEM_PROMPT = `你是协议分析结果的结构化抽取器。给定一份人工可读的协议分析报告和请求索引，把报告中的事实整理成机器可读的 ProtocolSpec JSON。
规则：
1. 只整理报告和索引里出现过的信息，不要补充报告没有的新结论。
2. 所有 exampleSeqs / evidenceSeqs 只能使用请求索引中真实存在的 #seq 数字。
3. endpoints[].id 用小写 kebab-case 短标识（如 login、send-message），flows[].steps[].endpointId 与 dependsOn 必须引用这些 id。
4. urlTemplate 写完整 URL，路径中的可变部分用 {name} 表示。
5. 报告里有复现代码就放进 reproduction，没有则为 null。
6. 文本字段使用简体中文，枚举和标识符保持英文。`;

function selectIndexLines(summaries: RequestSummary[], reportContent: string, builder: PromptBuilder): string[] {
  if (summaries.length <= INDEX_HEAD_LIMIT) return summaries.map((summary) => builder.formatIndexLine(summary));
  const cited = new Set(extractCitedSeqs(reportContent));
  const picked = new Map<number, RequestSummary>();
  for (const summary of summaries) {
    if (picked.size >= INDEX_HEAD_LIMIT) break;
    picked.set(summary.seq, summary);
  }
  for (const summary of summaries) {
    if (cited.has(summary.seq)) picked.set(summary.seq, summary);
  }
  return [...picked.values()]
    .sort((left, right) => left.seq - right.seq)
    .map((summary) => builder.formatIndexLine(summary));
}

function formatEnrichment(enrichment: SessionEnrichment | null): string {
  if (!enrichment) return "（无）";
  const scenes = enrichment.sceneHints.length
    ? enrichment.sceneHints.map((hint) => `- ${hint.scene} [${hint.confidence}] ${hint.evidence} ${hint.relatedRequestIds.join(" ")}`).join("\n")
    : "- 场景线索：无";
  const auth = enrichment.authChain.length
    ? enrichment.authChain.map((item) => `- ${item.credentialType} 来源: ${item.source}; 使用者: ${item.consumers.join(", ") || "无"}`).join("\n")
    : "- 鉴权链：无";
  const streaming = enrichment.streamingSeqs.length
    ? `- 流式请求: ${enrichment.streamingSeqs.map((seq) => `#${seq}`).join(" ")}`
    : "- 流式请求：无";
  return `${scenes}\n${auth}\n${streaming}`;
}

export function buildSpecExtractionMessages(input: SpecExtractionInput): MessageLike[] {
  const builder = new PromptBuilder();
  const indexLines = selectIndexLines(input.summaries, input.reportContent, builder);
  const reportTokenLimit = Math.max(MIN_REPORT_TOKENS, Math.min(MAX_REPORT_TOKENS, input.maxReportTokens ?? MAX_REPORT_TOKENS));
  const report = truncateReportToTokenBudget(input.reportContent, reportTokenLimit);

  const user = `## 分析目的
${input.purpose?.trim() || "auto"}

## 规则派生线索（程序自动计算，可作为补充依据）
${formatEnrichment(input.enrichment)}

## 请求索引（共 ${input.summaries.length} 条${indexLines.length < input.summaries.length ? `，此处列出 ${indexLines.length} 条` : ""}）
格式: #seq METHOD URL @ time -> status [content-type] body=.. resp=..
${indexLines.join("\n")}

## 分析报告
${report}

请输出 ProtocolSpec JSON。`;

  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

/**
 * 用轻量模型把 Markdown 报告抽取成 ProtocolSpec；调用方负责选好角色配置和错误处理。
 */
export async function extractProtocolSpec(
  router: LLMRouter,
  input: SpecExtractionInput,
  signal?: AbortSignal,
): Promise<SpecExtractionResult> {
  const messages = buildSpecExtractionMessages(input);
  const result = await router.completeStructured(messages, ProtocolSpecSchema, signal);
  const knownSeqs = new Set(input.summaries.map((summary) => summary.seq));
  return {
    spec: sanitizeSpecReferences(result.output, knownSeqs),
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    degraded: result.degraded,
  };
}
