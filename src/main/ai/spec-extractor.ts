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
/** 索引行数硬上限：引用再多也不能把提示词撑爆 */
export const INDEX_TOTAL_LIMIT = 240;
/** 窗口装不下时索引压缩到的行数；再少就没有定位价值了 */
export const INDEX_MIN_LIMIT = 40;
/** 报告正文喂给抽取器的上限（token）；再大也没必要 */
export const MAX_REPORT_TOKENS = 20_000;
/** 报告正文至少保留这么多 token，再少抽不出东西 */
export const MIN_REPORT_TOKENS = 3_000;
/** token 估算有误差，给服务端留一点余量 */
const SAFETY_MARGIN_TOKENS = 1_000;

export interface SpecExtractionInput {
  reportContent: string;
  summaries: RequestSummary[];
  enrichment: SessionEnrichment | null;
  purpose?: string | null;
  /** 报告正文 token 上限；给了就按它来，不再按窗口实测 */
  maxReportTokens?: number;
  /** 抽取角色的配置：用真实窗口和输出上限把报告预算算准，而不是靠一个常量预留 */
  extractConfig?: LLMProviderConfig;
}

/**
 * 按 token 预算裁剪报告：保留头 70% / 尾 30%，中段省略。
 * 只留开头会把复现代码、风险和未决问题整段丢掉，而那些正是 Spec 要抽的东西。
 */
export function truncateReportToTokenBudget(report: string, maxTokens: number): string {
  if (estimateTextTokens(report) <= maxTokens) return report;
  const marker = `\n...[报告中段已省略，原文共 ${report.length} 字符]\n`;
  if (maxTokens <= estimateTextTokens(marker)) return marker.trim();

  let low = 0;
  let high = report.length;
  let best = marker.trim();
  while (low <= high) {
    const keepChars = Math.floor((low + high) / 2);
    const headChars = Math.ceil(keepChars * 0.7);
    const tailChars = Math.max(0, keepChars - headChars);
    const candidate = `${report.slice(0, headChars)}${marker}${tailChars > 0 ? report.slice(-tailChars) : ""}`;
    if (estimateTextTokens(candidate) <= maxTokens) {
      best = candidate;
      low = keepChars + 1;
    } else {
      high = keepChars - 1;
    }
  }
  return best;
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

function selectIndexLines(
  summaries: RequestSummary[],
  reportContent: string,
  builder: PromptBuilder,
  totalLimit: number = INDEX_TOTAL_LIMIT,
): string[] {
  if (summaries.length <= Math.min(INDEX_HEAD_LIMIT, totalLimit)) {
    return summaries.map((summary) => builder.formatIndexLine(summary));
  }
  const cited = new Set(extractCitedSeqs(reportContent));
  const picked = new Map<number, RequestSummary>();
  // 引用过的优先：Spec 的 exampleSeqs / evidenceSeqs 只能落在索引里真实出现过的行上
  for (const summary of summaries) {
    if (picked.size >= totalLimit) break;
    if (cited.has(summary.seq)) picked.set(summary.seq, summary);
  }
  // 再用头部补出会话起始的脉络，总量仍受硬上限约束
  const headTarget = Math.min(totalLimit, picked.size + INDEX_HEAD_LIMIT);
  for (const summary of summaries) {
    if (picked.size >= headTarget) break;
    picked.set(summary.seq, summary);
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

function buildUserMessage(input: SpecExtractionInput, indexLines: string[], report: string): string {
  return `## 分析目的
${input.purpose?.trim() || "auto"}

## 规则派生线索（程序自动计算，可作为补充依据）
${formatEnrichment(input.enrichment)}

## 请求索引（共 ${input.summaries.length} 条${indexLines.length < input.summaries.length ? `，此处列出 ${indexLines.length} 条` : ""}）
格式: #seq METHOD URL @ time -> status [content-type] body=.. resp=..
${indexLines.join("\n")}

## 分析报告
${report}

请输出 ProtocolSpec JSON。`;
}

/** 除报告正文之外的一切（系统提示 + 线索 + 索引）实际占多少 token */
function measureScaffold(input: SpecExtractionInput, totalLimit: number): { indexLines: string[]; tokens: number } {
  const indexLines = selectIndexLines(input.summaries, input.reportContent, new PromptBuilder(), totalLimit);
  const scaffold = `${SYSTEM_PROMPT}\n${buildUserMessage(input, indexLines, "")}`;
  return { indexLines, tokens: estimateTextTokens(scaffold) };
}

/** 报告正文还剩多少 token 可用：给了 maxReportTokens 就照它，否则按真实窗口减去实测占用 */
function resolveReportBudget(input: SpecExtractionInput, scaffoldTokens: number): number {
  if (input.maxReportTokens !== undefined) {
    return Math.max(MIN_REPORT_TOKENS, Math.min(MAX_REPORT_TOKENS, input.maxReportTokens));
  }
  if (!input.extractConfig) return MAX_REPORT_TOKENS;
  const window = resolveContextBudget(input.extractConfig).maxContextTokens;
  const available = window - input.extractConfig.maxTokens - scaffoldTokens - SAFETY_MARGIN_TOKENS;
  return Math.min(MAX_REPORT_TOKENS, available);
}

export function buildSpecExtractionMessages(input: SpecExtractionInput): MessageLike[] {
  // 先把提示词建出来量一遍，再决定报告能塞多少——预留量不该是个常量猜测
  let { indexLines, tokens } = measureScaffold(input, INDEX_TOTAL_LIMIT);
  let reportBudget = resolveReportBudget(input, tokens);

  // 装不下就先缩索引，再不行才认输
  if (reportBudget < MIN_REPORT_TOKENS) {
    ({ indexLines, tokens } = measureScaffold(input, INDEX_MIN_LIMIT));
    reportBudget = resolveReportBudget(input, tokens);
  }
  if (reportBudget < MIN_REPORT_TOKENS) {
    const config = input.extractConfig!;
    const window = resolveContextBudget(config).maxContextTokens;
    throw new Error(
      `抽取模型上下文窗口不足：窗口 ${window} token，要装下输出上限 ${config.maxTokens} ` +
      `和提示词约 ${tokens} token（索引已压到 ${indexLines.length} 行），报告正文只剩 ${Math.max(0, reportBudget)} token，` +
      `低于最低需要的 ${MIN_REPORT_TOKENS}。请在设置里为轻量模型（lightweightModel）换一个窗口更大的模型。`,
    );
  }

  const report = truncateReportToTokenBudget(input.reportContent, reportBudget);
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserMessage(input, indexLines, report) },
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
