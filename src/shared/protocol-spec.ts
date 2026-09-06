import { z } from "zod";
import type { AssembledData, AuthChainItem, SceneHint, StorageDiff } from "./types";

/**
 * ProtocolSpec：给机器读的结构化分析产物。
 *
 * 设计约束：
 * - 同一份 zod schema 同时用于 AI SDK 结构化输出、落库校验与 MCP / 导出。
 * - 字段用 nullable 而不是 optional：OpenAI strict JSON schema 要求所有字段出现。
 * - 数组一律 default([])，模型漏字段时不至于整份失败。
 * - 所有 *Seqs 只允许出现请求索引里存在的序号，由抽取器在解析后二次过滤。
 */

export const PROTOCOL_SPEC_VERSION = 1 as const;

export const EndpointAuthSchema = z.enum(["none", "bearer", "cookie", "api-key", "signature", "other"]);
export const ParamLocationSchema = z.enum(["path", "query", "header", "body"]);
export const StreamingKindSchema = z.enum(["sse", "websocket"]);
export const CredentialCarrierSchema = z.enum(["header", "cookie", "query", "body"]);
export const StorageKindSchema = z.enum(["cookie", "localStorage", "sessionStorage"]);
export const ReproductionLanguageSchema = z.enum(["python", "javascript", "other"]);

const seqList = z.array(z.number().int().nonnegative()).default([]);
const stringList = z.array(z.string()).default([]);

export const EndpointParamSchema = z.object({
  name: z.string().describe("参数名"),
  in: ParamLocationSchema.describe("参数位置"),
  type: z.string().describe("类型描述，如 string / number / object"),
  required: z.boolean().describe("是否必填"),
  description: z.string().describe("用途说明"),
});

export const EndpointSchema = z.object({
  id: z.string().describe("端点短标识，小写 kebab-case，如 login、send-message"),
  method: z.string().describe("HTTP 方法，大写"),
  urlTemplate: z.string().describe("完整 URL 模板，路径变量用 {name}"),
  purpose: z.string().describe("端点用途"),
  auth: EndpointAuthSchema.describe("鉴权方式"),
  params: z.array(EndpointParamSchema).default([]),
  requestContentType: z.string().nullable(),
  requestExample: z.string().nullable().describe("请求体示例（截断到必要长度）"),
  responseContentType: z.string().nullable(),
  responseDescription: z.string().describe("响应结构说明"),
  responseExample: z.string().nullable(),
  streaming: StreamingKindSchema.nullable(),
  exampleSeqs: seqList.describe("作为依据的请求序号"),
  dependsOn: stringList.describe("依赖的其他端点 id"),
});

export const AuthChainEntrySchema = z.object({
  credentialType: z.string().describe("凭据类型，如 Bearer Token / Session Cookie"),
  obtainedFrom: z.string().describe("凭据来源：端点 id 或描述"),
  carriedIn: CredentialCarrierSchema,
  keyName: z.string().nullable().describe("携带凭据的 header / cookie / 参数名"),
  refreshFlow: z.string().nullable().describe("刷新 / 续期方式"),
  evidenceSeqs: seqList,
});

export const FlowStepSchema = z.object({
  endpointId: z.string(),
  note: z.string(),
});

export const FlowSchema = z.object({
  name: z.string(),
  description: z.string(),
  steps: z.array(FlowStepSchema).default([]),
});

export const StorageUsageSchema = z.object({
  type: StorageKindSchema,
  key: z.string(),
  role: z.string().describe("该键的作用"),
  evidenceSeqs: seqList,
});

export const CryptoUsageSchema = z.object({
  algorithm: z.string(),
  location: z.string().describe("发生位置：脚本 URL / 函数名 / 请求字段"),
  inputs: z.string(),
  output: z.string(),
  notes: z.string(),
  evidenceSeqs: seqList,
});

export const ReproductionSchema = z.object({
  language: ReproductionLanguageSchema,
  code: z.string(),
});

export const ProtocolSpecSchema = z.object({
  specVersion: z.literal(PROTOCOL_SPEC_VERSION).default(PROTOCOL_SPEC_VERSION),
  scene: z.string().describe("业务场景标签或简述"),
  summary: z.string().describe("2~4 句总体结论"),
  baseUrls: stringList,
  endpoints: z.array(EndpointSchema).default([]),
  authChain: z.array(AuthChainEntrySchema).default([]),
  flows: z.array(FlowSchema).default([]),
  storage: z.array(StorageUsageSchema).default([]),
  crypto: z.array(CryptoUsageSchema).default([]),
  reproduction: ReproductionSchema.nullable(),
  risks: stringList,
  openQuestions: stringList,
});

export type ProtocolSpec = z.infer<typeof ProtocolSpecSchema>;
export type ProtocolEndpoint = z.infer<typeof EndpointSchema>;
export type ProtocolAuthChainEntry = z.infer<typeof AuthChainEntrySchema>;

/**
 * 解析并校验一份 Spec；返回 null 表示不合法。
 */
export function parseProtocolSpec(value: unknown): ProtocolSpec | null {
  const result = ProtocolSpecSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parseProtocolSpecJson(json: string | null | undefined): ProtocolSpec | null {
  if (!json) return null;
  try {
    return parseProtocolSpec(JSON.parse(json));
  } catch {
    return null;
  }
}

/**
 * 把 Spec 里所有序号引用限制在已知集合内，去掉模型编造的序号。
 */
export function restrictSpecSeqs(spec: ProtocolSpec, knownSeqs: ReadonlySet<number>): ProtocolSpec {
  const keep = (seqs: number[]): number[] => [...new Set(seqs.filter((seq) => knownSeqs.has(seq)))];
  return {
    ...spec,
    endpoints: spec.endpoints.map((endpoint) => ({ ...endpoint, exampleSeqs: keep(endpoint.exampleSeqs) })),
    authChain: spec.authChain.map((entry) => ({ ...entry, evidenceSeqs: keep(entry.evidenceSeqs) })),
    storage: spec.storage.map((entry) => ({ ...entry, evidenceSeqs: keep(entry.evidenceSeqs) })),
    crypto: spec.crypto.map((entry) => ({ ...entry, evidenceSeqs: keep(entry.evidenceSeqs) })),
  };
}

/**
 * 去掉指向不存在端点的引用：dependsOn 里的悬空 id 直接丢弃，flows 里的悬空步骤删掉，
 * 删空的 flow 也一并去掉，避免 OpenAPI 的 x-depends-on / x-flows 指向不存在的操作。
 */
export function restrictSpecEndpointRefs(spec: ProtocolSpec): ProtocolSpec {
  const ids = new Set(spec.endpoints.map((endpoint) => endpoint.id));
  return {
    ...spec,
    endpoints: spec.endpoints.map((endpoint) => ({
      ...endpoint,
      dependsOn: [...new Set(endpoint.dependsOn.filter((id) => ids.has(id) && id !== endpoint.id))],
    })),
    flows: spec.flows
      .map((flow) => ({ ...flow, steps: flow.steps.filter((step) => ids.has(step.endpointId)) }))
      .filter((flow) => flow.steps.length > 0),
  };
}

/**
 * 字段归一化：HTTP 方法统一大写，标识符去掉首尾空白。
 * 模型偶尔给 `post` / ` login `，不归一会让面板、OpenAPI 和 dependsOn 匹配各自表现不一致。
 */
export function normalizeSpecFields(spec: ProtocolSpec): ProtocolSpec {
  return {
    ...spec,
    endpoints: spec.endpoints.map((endpoint) => ({
      ...endpoint,
      id: endpoint.id.trim(),
      method: endpoint.method.trim().toUpperCase(),
      dependsOn: endpoint.dependsOn.map((id) => id.trim()),
    })),
    flows: spec.flows.map((flow) => ({
      ...flow,
      steps: flow.steps.map((step) => ({ ...step, endpointId: step.endpointId.trim() })),
    })),
  };
}

/** 抽取后的统一清洗：字段归一化 → 序号引用 → 端点引用 */
export function sanitizeSpecReferences(spec: ProtocolSpec, knownSeqs: ReadonlySet<number>): ProtocolSpec {
  return restrictSpecEndpointRefs(restrictSpecSeqs(normalizeSpecFields(spec), knownSeqs));
}

// ---- SessionEnrichment：规则派生、零 LLM 成本 ----

export interface SessionEnrichment {
  generatedAt: number;
  /** 参与分析的请求数（静态资源等已过滤） */
  requestCount: number;
  /** 会话抓到的请求总数；用作缓存是否过期的判断依据，旧数据里可能没有 */
  totalRequests?: number;
  sceneHints: SceneHint[];
  authChain: AuthChainItem[];
  storageDiff: {
    cookies: StorageDiff;
    localStorage: StorageDiff;
    sessionStorage: StorageDiff;
  };
  streamingSeqs: number[];
}

export function toSessionEnrichment(data: AssembledData, totalRequests?: number): SessionEnrichment {
  return {
    generatedAt: Date.now(),
    requestCount: data.requests.length,
    ...(totalRequests !== undefined ? { totalRequests } : {}),
    sceneHints: data.sceneHints,
    authChain: data.authChain,
    storageDiff: data.storageDiff,
    streamingSeqs: data.streamingRequests.map((request) => request.seq),
  };
}

/**
 * 缓存的 enrichment 是否仍然可用：请求总数没变就认为会话数据没变。
 */
export function isEnrichmentFresh(cached: SessionEnrichment | null, totalRequests: number): cached is SessionEnrichment {
  return cached !== null && cached.totalRequests === totalRequests;
}

export function parseSessionEnrichmentJson(json: string | null | undefined): SessionEnrichment | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<SessionEnrichment>;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.sceneHints)) return null;
    return parsed as SessionEnrichment;
  } catch {
    return null;
  }
}
