import { v4 as uuidv4 } from "uuid";
import type {
  AnalysisReport,
  AssembledData,
  ChatMessage,
  FilteredRequest,
  LLMProviderConfig,
  PromptTemplate,
  AiProgressEvent,
  AiRequestLogData,
  AiRequestLogType,
  RequestSummary,
} from "@shared/types";
import { resetEvent, statusEvent } from "@shared/ai-progress";
import { validateCitations } from "@shared/citations";
import {
  isEnrichmentFresh,
  parseProtocolSpecJson,
  parseSessionEnrichmentJson,
  toSessionEnrichment,
  type ProtocolSpec,
  type SessionEnrichment,
} from "@shared/protocol-spec";
import type {
  SessionsRepo,
  RequestsRepo,
  JsHooksRepo,
  StorageSnapshotsRepo,
  AnalysisReportsRepo,
  AiRequestLogRepo,
  InteractionEventsRepo,
} from "../db/repositories";
import { DataAssembler } from "./data-assembler";
import { PromptBuilder } from "./prompt-builder";
import { LLMRouter } from "./llm-router";
import { resolveRoleConfig } from "./llm-roles";
import { computeReportTokenBudget, extractProtocolSpec } from "./spec-extractor";
import { buildInitialChatMessages } from "./chat-prompt";
import type { MCPClientManager, MCPToolInfo } from "../mcp/mcp-manager";
import {
  applyUsageCalibration,
  compactMessagesToBudgetAsync,
  resolveContextBudget,
  type MessageLike,
} from "./context-budget";
import { BUILTIN_REQUEST_TOOLS, dispatchBuiltinRequestTool } from "./request-tools";
import { BUILTIN_CAPTURE_TOOLS, dispatchBuiltinCaptureTool } from "./capture-tools";
import { loadTokenCalibration, saveTokenCalibration } from "./token-calibration-store";
import { SubagentAnalyzer } from "./subagent-analyzer";
import {
  appendToolStateMarker,
  buildToolStateNote,
  getToolSessionState,
  hydrateToolSessionFromHistory,
  recordToolSessionActivity,
} from "./tool-session-state";

/** 请求数低于此值时跳过 Phase 1 预过滤（仅 legacy_inline） */
const PRE_FILTER_THRESHOLD = 20;
/** Phase 1 选出的请求少于此值时回退到全量分析 */
const PRE_FILTER_MIN_SELECTED = 3;
/** 需要全量请求的分析目的（不跳过任何请求） */
const SKIP_FILTER_PURPOSES = ["performance"];
/** 预过滤每次发送的请求摘要上限，避免单次上下文膨胀 */
const FILTER_BATCH_SIZE = 100;

/**
 * AiAnalyzer — Orchestrates data assembly, prompt building, LLM calling,
 * and report generation.
 */
export class AiAnalyzer {
  private mcpManager: MCPClientManager | null = null;

  constructor(
    private sessionsRepo: SessionsRepo,
    private requestsRepo: RequestsRepo,
    private jsHooksRepo: JsHooksRepo,
    private storageSnapshotsRepo: StorageSnapshotsRepo,
    private reportsRepo: AnalysisReportsRepo,
    private aiRequestLogRepo: AiRequestLogRepo,
    private interactionEventsRepo: InteractionEventsRepo,
  ) {}

  /**
   * 注入 MCP 客户端管理器（可选）
   */
  setMCPManager(manager: MCPClientManager): void {
    this.mcpManager = manager;
  }

  /**
   * Create a logging callback for LLMRouter that captures context via closure.
   */
  private createLogCallback(
    sessionId: string,
    reportId: string | null,
    type: AiRequestLogType,
    config: LLMProviderConfig,
  ) {
    return (data: AiRequestLogData) => {
      try {
        return this.aiRequestLogRepo.insert({
          session_id: sessionId,
          report_id: reportId,
          type,
          provider: config.name,
          model: config.model,
          ...data,
          prompt_tokens: 0,
          completion_tokens: 0,
          created_at: Date.now(),
        });
      } catch (e) {
        console.warn("[AiRequestLog] Failed to insert log:", e);
        return undefined;
      }
    };
  }

  private readonly updateLogTokens = (
    logId: number,
    promptTokens: number,
    completionTokens: number,
  ): void => {
    try {
      this.aiRequestLogRepo.updateTokensById(logId, promptTokens, completionTokens);
    } catch (error) {
      console.warn("[AiRequestLog] Failed to update tokens:", error);
    }
  };

  private readonly updateLogResponseBody = (
    logId: number,
    body: string,
    durationMs: number,
  ): void => {
    try {
      this.aiRequestLogRepo.updateResponseBodyById(logId, body, durationMs);
    } catch (error) {
      console.warn("[AiRequestLog] Failed to update response body:", error);
    }
  };

  private createRouter(
    sessionId: string,
    reportId: string | null,
    type: AiRequestLogType,
    config: LLMProviderConfig,
  ): LLMRouter {
    return new LLMRouter(
      config,
      this.createLogCallback(sessionId, reportId, type, config),
      this.updateLogTokens,
      this.updateLogResponseBody,
    );
  }

  private createBuiltinToolRouter(
    sessionId: string,
    reportId: string | null | undefined,
    requestMap: Map<number, FilteredRequest>,
    summaries: RequestSummary[],
  ) {
    return async (name: string, args: Record<string, unknown>): Promise<string> => {
      const builtin = dispatchBuiltinRequestTool(name, args, requestMap, summaries);
      if (builtin) {
        recordToolSessionActivity(sessionId, reportId, builtin.fetchedSeqs, builtin.refLine);
        return builtin.result;
      }
      const captureBuiltin = dispatchBuiltinCaptureTool(
        name,
        args,
        this.jsHooksRepo.findBySession(sessionId),
        this.interactionEventsRepo.findBySession(sessionId, 10_000),
      );
      if (captureBuiltin) {
        recordToolSessionActivity(
          sessionId,
          reportId,
          captureBuiltin.fetchedSeqs,
          captureBuiltin.refLine,
        );
        return captureBuiltin.result;
      }
      if (this.mcpManager) return this.mcpManager.callTool(name, args);
      throw new Error(`Tool not found: ${name}`);
    };
  }

  private collectTools(hasRequests: boolean): MCPToolInfo[] {
    const builtinTools = [
      ...(hasRequests ? BUILTIN_REQUEST_TOOLS : []),
      ...BUILTIN_CAPTURE_TOOLS,
    ];
    const mcpTools = this.mcpManager?.hasConnections() ? this.mcpManager.listAllTools() : [];
    return [...builtinTools, ...mcpTools];
  }

  private async buildSubagentContext(
    sessionId: string,
    config: LLMProviderConfig,
    summaries: RequestSummary[],
    purpose: string | undefined,
    template: PromptTemplate | undefined,
    onProgress?: (event: AiProgressEvent) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    loadTokenCalibration(config);
    const budget = resolveContextBudget(config);
    if (!budget.subagentEnabled || summaries.length < budget.subagentThreshold) return "";

    const workerConfig = resolveRoleConfig(config, "subagent");
    const analysisFocus = template?.requirements || purpose || "自动识别协议场景与关键请求链路";
    const analyzer = new SubagentAnalyzer(
      async (input) => {
        signal?.throwIfAborted();
        onProgress?.(statusEvent(
          `子分析 ${input.chunkIndex + 1}/${input.totalChunks}：正在扫描 ${input.summaries.length} 条请求摘要...`,
        ));

        loadTokenCalibration(workerConfig);
        const router = this.createRouter(sessionId, null, "subagent", workerConfig);
        const messages: MessageLike[] = [
          {
            role: "system",
            content:
              "你是主分析器的并行子任务。只根据请求摘要发现值得主模型验证的线索；不要推断未出现的请求体字段。严格按用户要求返回 JSON。",
          },
          {
            role: "user",
            content: `${input.prompt}\n\n本次总体分析重点：\n${analysisFocus}`,
          },
        ];
        const result = await router.complete(messages, undefined, signal);
        applyUsageCalibration(messages, result.promptTokens);
        saveTokenCalibration(workerConfig);
        return result.content;
      },
      {
        threshold: budget.subagentThreshold - 1,
        chunkSize: budget.subagentChunkSize,
        maxConcurrency: budget.maxSubagents,
      },
    );

    onProgress?.(statusEvent(
      `请求数达到 ${summaries.length}，启动最多 ${budget.maxSubagents} 个并行子分析任务。`,
    ));
    let result: Awaited<ReturnType<SubagentAnalyzer["analyze"]>>;
    try {
      result = await analyzer.analyze(summaries);
    } finally {
      loadTokenCalibration(config);
    }
    signal?.throwIfAborted();
    if (!result.applied || result.succeededChunks === 0 || result.findings.length === 0) {
      if (result.applied) {
        onProgress?.(statusEvent("子分析未产生可用线索，主分析继续按请求工具链执行。"));
      }
      return "";
    }
    onProgress?.(statusEvent(
      `子分析完成：${result.succeededChunks}/${result.chunkCount} 个分块成功，聚合 ${result.findings.length} 条导航线索。`,
    ));
    return result.compactSummary;
  }

  private async packMessages(
    messages: MessageLike[],
    config: LLMProviderConfig,
    sessionId: string,
    reportId: string | null | undefined,
    onProgress?: (event: AiProgressEvent) => void,
    signal?: AbortSignal,
  ): Promise<MessageLike[]> {
    loadTokenCalibration(config);
    const budget = resolveContextBudget(config);
    const summarize =
      budget.compressionMode === "hybrid"
        ? async (middleText: string) => {
            onProgress?.(statusEvent("混合压缩：正在生成中间历史摘要..."));
            const summaryConfig = resolveRoleConfig(config, "compress");
            const router = this.createRouter(sessionId, reportId ?? null, "compress", summaryConfig);
            const summaryMessages: MessageLike[] = [
              {
                role: "system",
                content:
                  "你是上下文压缩器。将多轮协议分析对话压缩为简洁中文要点，保留：已确认的 API/鉴权结论、关键请求序号、未决问题。不要编造未出现的字段。",
              },
              { role: "user", content: middleText },
            ];
            // 校准存储是进程级单例：轻量模型的 scope 用完必须切回主模型，否则后续估算和回写都会串
            loadTokenCalibration(summaryConfig);
            try {
              const result = await router.complete(summaryMessages, undefined, signal);
              applyUsageCalibration(summaryMessages, result.promptTokens);
              saveTokenCalibration(summaryConfig);
              return result.content;
            } finally {
              loadTokenCalibration(config);
            }
          }
        : undefined;

    const packed = await compactMessagesToBudgetAsync(messages, budget, summarize);
    if (packed.compressed) {
      onProgress?.(statusEvent(
        `上下文达到峰值（${Math.round(budget.compressionPeak * 100)}%），已${packed.mode === "hybrid" ? "混合" : "规则"}压缩 ${packed.beforeTokens} → ${packed.afterTokens} tokens。`,
      ));
    }
    return packed.messages;
  }

  async analyze(
    sessionId: string,
    config: LLMProviderConfig,
    onProgress?: (event: AiProgressEvent) => void,
    purpose?: string,
    template?: PromptTemplate,
    selectedSeqs?: number[],
    signal?: AbortSignal,
  ): Promise<AnalysisReport> {
    loadTokenCalibration(config);
    const budget = resolveContextBudget(config);
    const indexFirst = budget.contextMode === "index_first";

    const session = this.sessionsRepo.findById(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    let platformName = "unknown";
    try {
      platformName = new URL(session.target_url).hostname;
    } catch {
      /* ignore */
    }

    const assembler = new DataAssembler(
      this.requestsRepo,
      this.jsHooksRepo,
      this.storageSnapshotsRepo,
    );
    const fullData = assembler.assemble(sessionId);
    const allSummaries: RequestSummary[] = assembler.extractSummaries(fullData);

    let analysisData: AssembledData = fullData;
    let filterPromptTokens: number | null = null;
    let filterCompletionTokens: number | null = null;
    const manualSelection = selectedSeqs && selectedSeqs.length > 0;
    let filteredApplied = false;

    if (manualSelection) {
      analysisData = assembler.filterBySeqs(fullData, selectedSeqs!);
      filteredApplied = true;
      onProgress?.(statusEvent(`使用手动选择的 ${selectedSeqs!.length} 条请求进行分析。`));
    } else if (indexFirst) {
      analysisData = fullData;
      onProgress?.(statusEvent(
        `索引优先模式：向模型提供 ${fullData.requests.length} 条请求索引（不内联正文），可使用 list_requests / search_requests / get_request_detail。`,
      ));
    } else {
      const skipFilter = purpose && SKIP_FILTER_PURPOSES.includes(purpose);
      if (!skipFilter && fullData.requests.length >= PRE_FILTER_THRESHOLD) {
        try {
          onProgress?.(statusEvent(`请求数量较多（${fullData.requests.length} 条），正在进行智能预过滤...`));
          const phase1Config = resolveRoleConfig(config, "filter");
          const phase1Router = this.createRouter(sessionId, null, "filter", phase1Config);
          const validSeqs = new Set(fullData.requests.map((r) => r.seq));
          const selected = new Set<number>();

          for (let batchStart = 0; batchStart < allSummaries.length; batchStart += FILTER_BATCH_SIZE) {
            const batchSummaries = allSummaries.slice(batchStart, batchStart + FILTER_BATCH_SIZE);
            const filterPrompt = new PromptBuilder().buildFilterPrompt(
              batchSummaries,
              fullData.sceneHints,
              purpose,
              template,
            );
            const phase1Messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
              { role: "system", content: filterPrompt.system },
              { role: "user", content: filterPrompt.user },
            ];

            const batchNumber = Math.floor(batchStart / FILTER_BATCH_SIZE) + 1;
            const batchCount = Math.ceil(allSummaries.length / FILTER_BATCH_SIZE);
            onProgress?.(statusEvent(`正在过滤第 ${batchNumber}/${batchCount} 批请求（${batchSummaries.length} 条）...`));
            signal?.throwIfAborted();
            const phase1Result = await phase1Router.complete(phase1Messages, undefined, signal);
            filterPromptTokens = (filterPromptTokens ?? 0) + phase1Result.promptTokens;
            filterCompletionTokens = (filterCompletionTokens ?? 0) + phase1Result.completionTokens;
            this.parseFilterResponse(phase1Result.content, validSeqs)?.forEach((seq) => selected.add(seq));
          }

          const filteredSeqs = [...selected];
          if (filteredSeqs.length >= PRE_FILTER_MIN_SELECTED) {
            analysisData = assembler.filterBySeqs(fullData, filteredSeqs);
            filteredApplied = true;
            onProgress?.(statusEvent(
              `过滤完成：从 ${fullData.requests.length} 条中选出 ${filteredSeqs.length} 条相关请求进行深度分析。`,
            ));
          } else {
            onProgress?.(statusEvent(`过滤结果不足，使用全部 ${fullData.requests.length} 条请求分析。`));
          }
        } catch {
          onProgress?.(statusEvent(`预过滤失败，使用全部 ${fullData.requests.length} 条请求分析。`));
        }
      }
    }

    const subagentContext = indexFirst && !manualSelection
      ? await this.buildSubagentContext(
          sessionId,
          config,
          allSummaries,
          purpose,
          template,
          onProgress,
          signal,
        )
      : "";

    const promptBuilder = new PromptBuilder();
    const summariesForPrompt = indexFirst || filteredApplied ? allSummaries : undefined;
    const { system, user: baseUser } = promptBuilder.build(
      analysisData,
      platformName,
      purpose,
      template,
      summariesForPrompt,
      budget.contextMode,
    );
    const user = subagentContext
      ? `${baseUser}\n\n## 并行子分析导航（仅作定位线索，正文仍需工具验证）\n${subagentContext}`
      : baseUser;

    const router = this.createRouter(sessionId, null, "analyze", config);
    let content = "";
    let promptTokens = 0;
    let completionTokens = 0;

    const requestMap = new Map(fullData.requests.map((r) => [r.seq, r]));
    const allTools = this.collectTools(fullData.requests.length > 0);
    const callTool = this.createBuiltinToolRouter(sessionId, null, requestMap, allSummaries);

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        signal?.throwIfAborted();
        let messages: MessageLike[] = [
          { role: "system", content: system },
          { role: "user", content: user },
        ];
        messages = await this.packMessages(messages, config, sessionId, null, onProgress, signal);

        let result;
        if (allTools.length > 0) {
          result = await router.completeWithTools(
            messages,
            allTools,
            callTool,
            onProgress,
            undefined,
            signal,
          );
        } else {
          result = await router.complete(messages, onProgress, signal);
        }

        content = result.content;
        promptTokens = result.promptTokens;
        completionTokens = result.completionTokens;
        if (allTools.length === 0) {
          applyUsageCalibration(messages, result.promptTokens);
          saveTokenCalibration(config);
        }
        break;
      } catch (err) {
        if (signal?.aborted) throw err;
        const message = err instanceof Error ? err.message : String(err);
        if (attempt === 1) {
          throw new Error(`AI 分析失败（已重试）: ${message}`);
        }
        // 首次失败时可能已经流出了部分正文：先让界面清空，再提示重试，避免新旧内容拼在一起
        onProgress?.(resetEvent());
        onProgress?.(statusEvent(`分析请求失败（${message}），正在重试...`));
      }
    }

    // 引用校验只提示不阻断：报告已经生成，未知序号更可能是模型手滑
    const citation = validateCitations(content, allSummaries.map((summary) => summary.seq));
    if (citation.unknown.length > 0) {
      onProgress?.(statusEvent(
        `报告引用了不存在的请求序号：${citation.unknown.slice(0, 10).map((seq) => `#${seq}`).join(" ")}${citation.unknown.length > 10 ? " ..." : ""}`,
      ));
    }

    const enrichment = toSessionEnrichment(fullData, this.requestsRepo.countBySession(sessionId));
    const report: AnalysisReport = {
      id: uuidv4(),
      session_id: sessionId,
      created_at: Date.now(),
      llm_provider: config.name,
      llm_model: config.model,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      report_content: content,
      filter_prompt_tokens: filterPromptTokens,
      filter_completion_tokens: filterCompletionTokens,
      purpose: template?.id ?? purpose ?? null,
      spec_json: null,
      spec_error: null,
      enrichment_json: JSON.stringify(enrichment),
    };

    // 先落库再抽取：抽取失败或被取消时报告本身已经安全
    this.reportsRepo.insert(report);
    if (signal?.aborted) return report;

    onProgress?.(statusEvent("正在抽取结构化数据（ProtocolSpec）..."));
    return this.extractAndStoreSpec(report, config, allSummaries, enrichment, signal);
  }

  /**
   * 用轻量模型把报告抽取成 ProtocolSpec 并落库。失败只记 spec_error，永不抛出（取消除外）。
   */
  private async extractAndStoreSpec(
    report: AnalysisReport,
    config: LLMProviderConfig,
    summaries: RequestSummary[],
    enrichment: SessionEnrichment | null,
    signal?: AbortSignal,
  ): Promise<AnalysisReport> {
    const extractConfig = resolveRoleConfig(config, "extract");
    const router = this.createRouter(report.session_id, report.id, "extract", extractConfig);
    try {
      const result = await extractProtocolSpec(router, {
        reportContent: report.report_content,
        summaries,
        enrichment,
        purpose: report.purpose,
        maxReportTokens: computeReportTokenBudget(extractConfig),
      }, signal);
      const specJson = JSON.stringify(result.spec);
      this.reportsRepo.updateSpec(report.id, specJson, null);
      return { ...report, spec_json: specJson, spec_error: null };
    } catch (error) {
      // 报告此时已经落库；取消抽取不应该让整次分析以失败收场，记一笔留给 ensureSpec 补抽
      const message = signal?.aborted
        ? "抽取已取消"
        : error instanceof Error ? error.message : String(error);
      if (!signal?.aborted) {
        console.warn(`[AiAnalyzer] ProtocolSpec extraction failed for report ${report.id}: ${message}`);
      }
      this.reportsRepo.updateSpec(report.id, null, message);
      return { ...report, spec_json: null, spec_error: message };
    }
  }

  /**
   * 保证报告带有 ProtocolSpec：已有则直接返回，否则（含上次失败）现在补抽并落库。
   */
  async ensureSpec(reportId: string, config: LLMProviderConfig, signal?: AbortSignal): Promise<AnalysisReport> {
    const report = this.reportsRepo.findById(reportId);
    if (!report) throw new Error(`Report ${reportId} not found`);
    if (report.spec_json) return report;

    const assembler = new DataAssembler(this.requestsRepo, this.jsHooksRepo, this.storageSnapshotsRepo);
    const fullData = assembler.assemble(report.session_id);
    const summaries = assembler.extractSummaries(fullData);
    const enrichment = parseSessionEnrichmentJson(report.enrichment_json)
      ?? toSessionEnrichment(fullData, this.requestsRepo.countBySession(report.session_id));
    return this.extractAndStoreSpec(report, config, summaries, enrichment, signal);
  }

  /**
   * 会话的规则派生数据。最新报告里缓存的一份在请求总数没变时直接复用，避免每次都重新组装整个会话。
   */
  getSessionEnrichment(sessionId: string): SessionEnrichment {
    const totalRequests = this.requestsRepo.countBySession(sessionId);
    const latest = this.reportsRepo.findBySession(sessionId)[0];
    const cached = latest ? parseSessionEnrichmentJson(latest.enrichment_json) : null;
    if (isEnrichmentFresh(cached, totalRequests)) return cached;
    const assembler = new DataAssembler(this.requestsRepo, this.jsHooksRepo, this.storageSnapshotsRepo);
    return toSessionEnrichment(assembler.assemble(sessionId), totalRequests);
  }

  /**
   * 读取报告的结构化 Spec（不触发抽取）。
   */
  getSpec(report: AnalysisReport): ProtocolSpec | null {
    return parseProtocolSpecJson(report.spec_json);
  }

  /**
   * 一份报告的初始追问对话（system prompt + 报告正文）。渲染进程和 MCP 都从这里取，保证 prompt 一致。
   */
  buildInitialChatMessages(report: Pick<AnalysisReport, "session_id" | "report_content">): ChatMessage[] {
    return buildInitialChatMessages(
      {
        requests: this.requestsRepo.findBySession(report.session_id),
        hooks: this.jsHooksRepo.findBySession(report.session_id),
      },
      report.report_content,
    );
  }

  private parseFilterResponse(raw: string, validSeqs: Set<number>): number[] | null {
    let cleaned = raw.trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");

    try {
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) return null;
      const nums = parsed.filter((n): n is number => typeof n === "number" && validSeqs.has(n));
      return nums.length > 0 ? nums : null;
    } catch {
      return null;
    }
  }

  async chat(
    sessionId: string,
    config: LLMProviderConfig,
    history: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    userMessage: string,
    onProgress?: (event: AiProgressEvent) => void,
    reportId?: string,
  ): Promise<string> {
    // 从历史恢复侧态，并注入紧凑说明（无正文）
    const snapshot = hydrateToolSessionFromHistory(sessionId, reportId, history);
    const stateNote = buildToolStateNote(snapshot);

    const messages: MessageLike[] = [
      ...history.map((m) => ({ role: m.role, content: m.content })),
      {
        role: "user",
        content: stateNote ? `${stateNote}\n\n## 用户追问\n${userMessage}` : userMessage,
      },
    ];

    const compactedMessages = await this.packMessages(
      messages,
      config,
      sessionId,
      reportId,
      onProgress,
    );

    const router = this.createRouter(sessionId, reportId ?? null, "chat", config);

    const assembler = new DataAssembler(
      this.requestsRepo,
      this.jsHooksRepo,
      this.storageSnapshotsRepo,
    );
    const fullData = assembler.assemble(sessionId);
    const summaries = assembler.extractSummaries(fullData);
    const requestMap = new Map(fullData.requests.map((r) => [r.seq, r]));
    const allTools = this.collectTools(fullData.requests.length > 0);
    const callTool = this.createBuiltinToolRouter(sessionId, reportId, requestMap, summaries);

    let replyContent: string;

    if (allTools.length > 0) {
      try {
        const result = await router.completeWithTools(
          compactedMessages,
          allTools,
          callTool,
          onProgress,
        );
        replyContent = result.content;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`追问工具调用失败：${message}`);
      }
    } else {
      const result = await router.complete(compactedMessages, onProgress);
      applyUsageCalibration(compactedMessages, result.promptTokens);
      saveTokenCalibration(config);
      replyContent = result.content;
    }

    // 仅附加极简 <tool_state>，不再粘贴 tool 正文
    const finalSnap = getToolSessionState(sessionId, reportId);
    return appendToolStateMarker(replyContent, finalSnap);
  }
}
