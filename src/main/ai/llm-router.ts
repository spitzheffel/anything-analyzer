import {
  APICallError,
  JSONParseError,
  NoObjectGeneratedError,
  Output,
  RetryError,
  TypeValidationError,
  generateText,
  jsonSchema,
  stepCountIs,
  streamText,
  tool,
  type JSONSchema7,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type PrepareStepResult,
  type ToolModelMessage,
  type ToolSet,
} from "ai";
import { z } from "zod";
import type { AiProgressEvent, AiRequestLogData, LLMProviderConfig } from "@shared/types";
import { reasoningEvent, statusEvent, textEvent } from "@shared/ai-progress";
import { resolveContextBudget } from "@shared/model-context-windows";
import type { MCPToolInfo } from "../mcp/mcp-manager";
import {
  compactMessagesToBudget,
  estimateTokens,
  getCompressionTargetTokens,
  getCompressionTriggerTokens,
  type MessageLike,
} from "./context-budget";
import { createLoggingFetch, hostOf, LLMRequestCancelledError, type FetchLike } from "./llm-fetch";
import { buildCallSettings, createLanguageModel, type ProviderOptions } from "./llm-provider";

export interface LLMResponse {
  content: string;
  /** 模型思考过程（若 provider 返回） */
  reasoning?: string;
  promptTokens: number;
  completionTokens: number;
}

export interface LLMStructuredResponse<T> {
  output: T;
  promptTokens: number;
  completionTokens: number;
  /** true 表示 provider 原生结构化输出失败，走了"普通回复 + 手动解析"的降级路径 */
  degraded: boolean;
}

export type LLMProgressListener = (event: AiProgressEvent) => void;
export type LLMToolExecutor = (name: string, args: Record<string, unknown>) => Promise<string>;

export interface LLMRouterOptions {
  /** 测试注入：绕过 provider 直接使用给定模型 */
  model?: LanguageModel;
  /** 测试注入：底层 fetch */
  fetchImpl?: FetchLike;
}

export const DEFAULT_MAX_TOOL_ROUNDS = 64;
const TOOL_RESULT_BUDGET_RATIO = 0.75;
const TOOL_RESULT_TRUNCATION_MARKER = "\n...[tool result truncated to stay within context budget]";
const TOOL_RESULT_OMITTED = "[tool result omitted: context budget exhausted; query a narrower range]";

interface ToolBinding {
  exposedName: string;
  tool: MCPToolInfo;
}

export function createToolBindings(tools: MCPToolInfo[]): ToolBinding[] {
  const usedNames = new Set<string>();
  return tools.map((tool, index) => {
    const baseName = tool.name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || `tool_${index + 1}`;
    let exposedName = baseName;
    let suffix = 2;
    while (usedNames.has(exposedName)) {
      const suffixText = `_${suffix}`;
      exposedName = `${baseName.slice(0, 64 - suffixText.length)}${suffixText}`;
      suffix += 1;
    }
    usedNames.add(exposedName);
    return { exposedName, tool };
  });
}

function truncateTextToTokenBudget(content: string, maxTokens: number): string {
  if (maxTokens <= 0) return TOOL_RESULT_OMITTED;
  if (estimateTokens(content) <= maxTokens) return content;

  const markerTokens = estimateTokens(TOOL_RESULT_TRUNCATION_MARKER);
  if (maxTokens <= markerTokens) return TOOL_RESULT_OMITTED;

  let low = 0;
  let high = content.length;
  let best = TOOL_RESULT_OMITTED;
  while (low <= high) {
    const keepChars = Math.floor((low + high) / 2);
    const headChars = Math.ceil(keepChars * 0.7);
    const tailChars = Math.max(0, keepChars - headChars);
    const candidate = `${content.slice(0, headChars)}${TOOL_RESULT_TRUNCATION_MARKER}${tailChars > 0 ? content.slice(-tailChars) : ""}`;
    if (estimateTokens(candidate) <= maxTokens) {
      best = candidate;
      low = keepChars + 1;
    } else {
      high = keepChars - 1;
    }
  }
  return best;
}

export function createToolResultLimiter(config: LLMProviderConfig): (results: string[]) => string[] {
  const budget = resolveContextBudget(config);
  const toolResultTokens = Math.max(
    512,
    Math.floor(
      (getCompressionTriggerTokens(budget) - getCompressionTargetTokens(budget))
      * TOOL_RESULT_BUDGET_RATIO,
    ),
  );
  let remainingTokens = toolResultTokens;

  return (results: string[]): string[] => results.map((result, index) => {
    if (remainingTokens <= 0) return TOOL_RESULT_OMITTED;
    const remainingResults = results.length - index;
    const resultBudget = Math.max(1, Math.floor(remainingTokens / remainingResults));
    const limited = truncateTextToTokenBudget(result, resultBudget);
    remainingTokens = Math.max(0, remainingTokens - estimateTokens(limited));
    return limited;
  });
}

function normalizeMaxToolRounds(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_TOOL_ROUNDS;
  return Math.max(1, Math.floor(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toModelMessages(messages: MessageLike[]): { system?: string; messages: ModelMessage[] } {
  const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);
  const rest: ModelMessage[] = [];
  for (const message of messages) {
    if (message.role === "user") rest.push({ role: "user", content: message.content });
    else if (message.role === "assistant") rest.push({ role: "assistant", content: message.content });
  }
  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: rest,
  };
}

type ToolResultOutput = Extract<ToolModelMessage["content"][number], { type: "tool-result" }>["output"];

function toolOutputToText(output: ToolResultOutput): string | null {
  switch (output.type) {
    case "text":
    case "error-text":
      return output.value;
    case "json":
    case "error-json":
      return JSON.stringify(output.value);
    default:
      return null;
  }
}

/**
 * 对上一轮新追加的 tool 消息做预算截断；没有可截断内容时返回 undefined。
 */
export function truncateTrailingToolResults(
  messages: ModelMessage[],
  limit: (results: string[]) => string[],
): ModelMessage[] | undefined {
  let start = messages.length;
  while (start > 0 && messages[start - 1].role === "tool") start -= 1;
  if (start === messages.length) return undefined;

  const trailing = messages.slice(start) as ToolModelMessage[];
  const texts: string[] = [];
  for (const message of trailing) {
    for (const part of message.content) {
      if (part.type !== "tool-result") continue;
      const text = toolOutputToText(part.output);
      if (text !== null) texts.push(text);
    }
  }
  if (texts.length === 0) return undefined;

  const limited = limit(texts);
  if (limited.every((text, index) => text === texts[index])) return undefined;

  let cursor = 0;
  const rebuilt: ToolModelMessage[] = trailing.map((message) => ({
    ...message,
    content: message.content.map((part) => {
      if (part.type !== "tool-result" || toolOutputToText(part.output) === null) return part;
      const value = limited[cursor];
      cursor += 1;
      return { ...part, output: { type: "text" as const, value } };
    }),
  }));
  return [...messages.slice(0, start), ...rebuilt];
}

/**
 * 从模型的自由文本里抠出 JSON：去掉 ``` 围栏，取第一个 { 到最后一个 } 之间的内容。
 */
export function extractJsonObjectText(text: string): string | null {
  const unfenced = text.replace(/```(?:json)?\s*([\s\S]*?)```/gi, "$1");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return unfenced.slice(start, end + 1);
}

/** 结构化输出这一路关闭 OpenAI 的 strict schema：schema 里有 default / nullable，strict 模式会拒绝 */
function withRelaxedSchemaOptions(providerOptions: ProviderOptions | undefined): ProviderOptions {
  const openai = { ...(providerOptions?.openai ?? {}), strictJsonSchema: false };
  return { ...(providerOptions ?? {}), openai } as ProviderOptions;
}

/**
 * 把 zod schema 渲染成提示词里的 JSON Schema 块。
 * 通用 OpenAI 兼容中转（json_object 模式）和降级路径都不会通过 API 传 schema，只能写进提示词。
 */
export function buildSchemaHint(schema: z.ZodType): string {
  const jsonSchema = z.toJSONSchema(schema, { io: "input" });
  return `输出必须是一个 JSON 对象，且严格符合以下 JSON Schema（不要输出 Schema 本身）：\n\`\`\`json\n${JSON.stringify(jsonSchema)}\n\`\`\``;
}

function appendToLastUserMessage(messages: MessageLike[], suffix: string): MessageLike[] {
  const copy = messages.map((message) => ({ ...message }));
  for (let index = copy.length - 1; index >= 0; index -= 1) {
    if (copy[index].role === "user") {
      copy[index].content = `${copy[index].content}\n\n${suffix}`;
      return copy;
    }
  }
  copy.push({ role: "user", content: suffix });
  return copy;
}

/**
 * 原生结构化输出失败时，只有"输出形态"类错误值得降级重试：
 * 模型没给出合法对象、schema 校验不过、或 provider 拒绝 response_format（400 / 422）。
 * 鉴权、限流、网络、5xx 再来一次也是同样结果，直接抛出。
 */
export function isStructuredOutputShapeError(error: unknown): boolean {
  if (RetryError.isInstance(error)) return isStructuredOutputShapeError(error.lastError);
  if (NoObjectGeneratedError.isInstance(error)) return true;
  if (TypeValidationError.isInstance(error) || JSONParseError.isInstance(error)) return true;
  if (APICallError.isInstance(error)) {
    return error.statusCode === 400 || error.statusCode === 422;
  }
  return false;
}

function normalizeLLMError(error: unknown, signal?: AbortSignal): Error {
  if (signal?.aborted) return new LLMRequestCancelledError();
  if (RetryError.isInstance(error)) return normalizeLLMError(error.lastError, signal);
  if (APICallError.isInstance(error)) {
    const body = (error.responseBody ?? error.message ?? "").slice(0, 200);
    const status = error.statusCode !== undefined ? `${error.statusCode} ` : "";
    return new Error(`LLM 请求失败 (${hostOf(error.url)}): ${status}${body}`);
  }
  if (error instanceof Error) return error;
  return new Error(String(error));
}

/**
 * LLMRouter — 基于 AI SDK 的统一调用入口。
 * 覆盖 OpenAI Chat Completions / Responses、Anthropic Messages（含 MiniMax）与 OpenAI 兼容中转。
 */
export class LLMRouter {
  constructor(
    private readonly config: LLMProviderConfig,
    private readonly onRequestComplete?: (log: AiRequestLogData) => number | void,
    private readonly onRequestUsage?: (logId: number, promptTokens: number, completionTokens: number) => void,
    private readonly onResponseBody?: (logId: number, body: string, durationMs: number) => void,
    private readonly options: LLMRouterOptions = {},
  ) {}

  async complete(
    messages: MessageLike[],
    onEvent?: LLMProgressListener,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    return this.run(messages, undefined, undefined, onEvent, DEFAULT_MAX_TOOL_ROUNDS, signal);
  }

  /**
   * Agentic loop：模型 ↔ 工具多轮调用，全程流式。
   */
  async completeWithTools(
    messages: MessageLike[],
    tools: MCPToolInfo[],
    callTool: LLMToolExecutor,
    onEvent?: LLMProgressListener,
    maxRounds = DEFAULT_MAX_TOOL_ROUNDS,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    const budget = resolveContextBudget(this.config);
    const toolLoopMessages = compactMessagesToBudget(messages, {
      ...budget,
      compressionPeak: Math.max(0.5, Math.min(budget.compressionPeak, budget.compressionTarget)),
    }).messages;
    return this.run(toolLoopMessages, tools, callTool, onEvent, normalizeMaxToolRounds(maxRounds), signal);
  }

  private buildToolSet(tools: MCPToolInfo[], callTool: LLMToolExecutor): { toolSet: ToolSet; displayNames: Map<string, string> } {
    const bindings = createToolBindings(tools);
    const toolSet: ToolSet = {};
    const displayNames = new Map<string, string>();
    for (const binding of bindings) {
      displayNames.set(binding.exposedName, binding.tool.name);
      toolSet[binding.exposedName] = tool({
        description: binding.tool.description,
        inputSchema: jsonSchema<Record<string, unknown>>(binding.tool.inputSchema as JSONSchema7),
        execute: async (input: unknown) => {
          try {
            return await callTool(binding.tool.name, isRecord(input) ? input : {});
          } catch (err) {
            return `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      });
    }
    return { toolSet, displayNames };
  }

  /**
   * 一次调用共用的准备工作：消息转换、参数映射、带日志的 fetch、以及"把 step usage 回写到对应日志行"的追踪器。
   */
  private prepareCall(messages: MessageLike[]) {
    const { system, messages: modelMessages } = toModelMessages(messages);
    const settings = buildCallSettings(this.config);

    let lastLoggedId: number | undefined;
    const loggingFetch = createLoggingFetch({
      extraBody: this.config.generation?.extraBody,
      fetchImpl: this.options.fetchImpl,
      onRequestComplete: this.onRequestComplete,
      onResponseBody: this.onResponseBody,
      onRequestLogged: (logId, log) => {
        if (log.error === null) lastLoggedId = logId;
      },
    });
    const model = this.options.model ?? createLanguageModel(this.config, loggingFetch);

    const totals = { promptTokens: 0, completionTokens: 0 };
    const recordStepUsage = (usage: LanguageModelUsage): void => {
      const stepPrompt = usage.inputTokens ?? 0;
      const stepCompletion = usage.outputTokens ?? 0;
      totals.promptTokens += stepPrompt;
      totals.completionTokens += stepCompletion;
      if (lastLoggedId !== undefined) {
        this.onRequestUsage?.(lastLoggedId, stepPrompt, stepCompletion);
        lastLoggedId = undefined;
      }
    };

    return { system, modelMessages, settings, model, totals, recordStepUsage };
  }

  /**
   * 结构化输出：优先用 provider 原生能力（AI SDK Output.object），
   * 不支持或解析失败时降级为"普通回复 + 手动抠 JSON + schema 校验"。
   */
  async completeStructured<T>(
    messages: MessageLike[],
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<LLMStructuredResponse<T>> {
    signal?.throwIfAborted();
    const schemaHint = buildSchemaHint(schema);
    // 通用中转走 json_object 模式，SDK 不会把 schema 传给 API，必须写进提示词；官方 provider 通过 API 传 schema，不重复占用 token
    const primaryMessages = this.config.name === "custom" ? appendToLastUserMessage(messages, schemaHint) : messages;
    const call = this.prepareCall(primaryMessages);

    try {
      const result = await generateText({
        model: call.model,
        system: call.system,
        messages: call.modelMessages,
        maxOutputTokens: call.settings.maxOutputTokens,
        temperature: call.settings.temperature,
        reasoning: call.settings.reasoning,
        providerOptions: withRelaxedSchemaOptions(call.settings.providerOptions),
        output: Output.object({ schema }),
        maxRetries: 1,
        abortSignal: signal,
        onStepEnd: ({ usage }) => call.recordStepUsage(usage),
      });
      const parsed = schema.safeParse(result.output);
      if (parsed.success) {
        return { output: parsed.data, ...call.totals, degraded: false };
      }
      // 对象生成了但不符合 schema：走降级路径再试一次
    } catch (error) {
      if (signal?.aborted) throw new LLMRequestCancelledError();
      if (!isStructuredOutputShapeError(error)) throw normalizeLLMError(error, signal);
      // provider 不支持 / 未生成合法对象：下面走降级路径
    }

    const instruction: MessageLike = {
      role: "user",
      content: `请只输出一个 JSON 对象，不要任何解释、前后缀或 Markdown 代码围栏。\n\n${schemaHint}`,
    };
    const fallback = await this.complete([...messages, instruction], undefined, signal);
    const jsonText = extractJsonObjectText(fallback.content);
    if (!jsonText) throw new Error("结构化输出解析失败: 回复中没有 JSON 对象");
    let candidate: unknown;
    try {
      candidate = JSON.parse(jsonText);
    } catch {
      throw new Error("结构化输出解析失败: JSON 语法错误");
    }
    const parsed = schema.safeParse(candidate);
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0];
      const where = firstIssue ? `${firstIssue.path.join(".") || "(root)"}: ${firstIssue.message}` : "unknown";
      throw new Error(`结构化输出不符合 schema: ${where}`);
    }
    return {
      output: parsed.data,
      promptTokens: call.totals.promptTokens + fallback.promptTokens,
      completionTokens: call.totals.completionTokens + fallback.completionTokens,
      degraded: true,
    };
  }

  private async run(
    messages: MessageLike[],
    tools: MCPToolInfo[] | undefined,
    callTool: LLMToolExecutor | undefined,
    onEvent: LLMProgressListener | undefined,
    maxRounds: number,
    signal: AbortSignal | undefined,
  ): Promise<LLMResponse> {
    signal?.throwIfAborted();

    const { system, modelMessages, settings, model, totals, recordStepUsage } = this.prepareCall(messages);

    const hasTools = !!tools && tools.length > 0 && !!callTool;
    const bound = hasTools ? this.buildToolSet(tools, callTool) : undefined;
    const limitToolResults = createToolResultLimiter(this.config);

    const prepareStep = bound
      ? ({ stepNumber, messages: stepMessages }: { stepNumber: number; messages: ModelMessage[] }): PrepareStepResult<ToolSet> => {
          const overrides: PrepareStepResult<ToolSet> = {};
          if (stepNumber >= maxRounds) {
            // 只禁止调用，不能去掉 tools 定义：历史里已有 tool_use/tool_result 块时 Anthropic 要求 tools 必须存在
            overrides.toolChoice = "none";
          }
          if (stepNumber > 0) {
            const truncated = truncateTrailingToolResults(stepMessages, limitToolResults);
            if (truncated) overrides.messages = truncated;
          }
          return overrides;
        }
      : undefined;

    const result = streamText({
      model,
      system,
      messages: modelMessages,
      maxOutputTokens: settings.maxOutputTokens,
      temperature: settings.temperature,
      reasoning: settings.reasoning,
      providerOptions: settings.providerOptions,
      tools: bound?.toolSet,
      stopWhen: stepCountIs(bound ? maxRounds + 1 : 1),
      prepareStep,
      maxRetries: 1,
      abortSignal: signal,
      // 错误会作为 error part 出现在流里并由下方循环抛出；关掉 SDK 默认的 console.error
      onError: () => {},
    });

    // 每一步的正文单独累计，最后用空行拼接：用户在流式过程中看到的所有正文都会进入结果
    const stepTexts: string[] = [];
    let reasoning = "";

    try {
      for await (const part of result.fullStream) {
        switch (part.type) {
          case "start-step":
            stepTexts.push("");
            break;
          case "text-delta":
            if (part.text) {
              if (stepTexts.length === 0) stepTexts.push("");
              stepTexts[stepTexts.length - 1] += part.text;
              onEvent?.(textEvent(part.text));
            }
            break;
          case "reasoning-delta":
            if (part.text) {
              reasoning += part.text;
              onEvent?.(reasoningEvent(part.text));
            }
            break;
          case "tool-call": {
            const displayName = bound?.displayNames.get(part.toolName) ?? part.toolName;
            onEvent?.(statusEvent(`🔧 调用工具: ${displayName}`));
            break;
          }
          case "finish-step":
            recordStepUsage(part.usage);
            break;
          case "abort":
            throw new LLMRequestCancelledError();
          case "error":
            throw part.error;
          default:
            break;
        }
      }
    } catch (error) {
      throw normalizeLLMError(error, signal);
    }

    if (signal?.aborted) throw new LLMRequestCancelledError();

    const content = stepTexts.map((text) => text.trim()).filter((text) => text.length > 0).join("\n\n");
    if (content.length === 0) {
      throw new Error("LLM 响应格式异常: 未返回正文内容");
    }

    return {
      content,
      reasoning: reasoning.length > 0 ? reasoning : undefined,
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens,
    };
  }
}
