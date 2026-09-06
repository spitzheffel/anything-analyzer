import type { ProtocolEndpoint, ProtocolSpec } from "./protocol-spec";

/**
 * 由 ProtocolSpec 生成 OpenAPI 3.1 文档（纯函数）。
 * 抓包推断的信息不完整，所以 schema 只到"类型描述 + 示例"的粒度；
 * 依据序号、依赖关系、流程等放在 `x-` 扩展字段里，不丢信息。
 */

export interface OpenApiMeta {
  title?: string;
  version?: string;
  sessionName?: string;
  targetUrl?: string;
  generatedAt?: number;
}

export type OpenApiDocument = Record<string, unknown> & {
  openapi: "3.1.0";
  info: Record<string, unknown>;
  servers: Array<{ url: string }>;
  paths: Record<string, Record<string, unknown>>;
  components: { securitySchemes: Record<string, unknown> };
};

type EndpointAuth = Exclude<ProtocolEndpoint["auth"], "none">;

const SECURITY_SCHEME_NAMES: Record<EndpointAuth, string> = {
  bearer: "bearerAuth",
  cookie: "cookieAuth",
  "api-key": "apiKeyAuth",
  signature: "signatureAuth",
  other: "otherAuth",
};

/**
 * 安全方案的 cookie / header 名优先取鉴权链里抓到的真实键名，取不到再用通用占位。
 */
export function buildSecuritySchemes(spec: ProtocolSpec, used: ReadonlySet<EndpointAuth>): Record<string, unknown> {
  const chain = spec.authChain;
  const named = (predicate: (entry: ProtocolSpec["authChain"][number]) => boolean): string | null =>
    chain.find((entry) => entry.keyName && predicate(entry))?.keyName ?? null;

  const cookieName = named((entry) => entry.carriedIn === "cookie") ?? "session";
  const apiKeyEntry = chain.find((entry) =>
    entry.keyName
    && entry.carriedIn !== "cookie"
    && !/bearer/i.test(entry.credentialType)
    && !/sign/i.test(entry.credentialType)
    && entry.keyName.toLowerCase() !== "authorization");
  const signatureEntry = chain.find((entry) => entry.keyName && /sign/i.test(entry.credentialType));

  const schemes: Record<EndpointAuth, Record<string, unknown>> = {
    bearer: { type: "http", scheme: "bearer" },
    cookie: { type: "apiKey", in: "cookie", name: cookieName },
    "api-key": {
      type: "apiKey",
      in: apiKeyEntry?.carriedIn === "query" ? "query" : "header",
      name: apiKeyEntry?.keyName ?? "X-API-Key",
    },
    signature: {
      type: "apiKey",
      in: signatureEntry?.carriedIn === "query" ? "query" : "header",
      name: signatureEntry?.keyName ?? "X-Signature",
      description: "请求签名，算法见 x-crypto",
    },
    other: { type: "apiKey", in: "header", name: "Authorization", description: "抓包未能归类的鉴权方式" },
  };

  const result: Record<string, unknown> = {};
  for (const auth of used) result[SECURITY_SCHEME_NAMES[auth]] = schemes[auth];
  return result;
}

interface SplitUrl {
  server: string | null;
  path: string;
  templateQueryParams: string[];
}

/**
 * 把 urlTemplate 拆成 server 与 path。URL 解析会把 `{` 转义，这里解码回来。
 */
export function splitUrlTemplate(urlTemplate: string): SplitUrl {
  const trimmed = urlTemplate.trim();
  const questionMark = trimmed.indexOf("?");
  const withoutQuery = questionMark >= 0 ? trimmed.slice(0, questionMark) : trimmed;
  const query = questionMark >= 0 ? trimmed.slice(questionMark + 1) : "";
  const templateQueryParams = query
    .split("&")
    .map((pair) => pair.split("=")[0]?.trim())
    .filter((name): name is string => Boolean(name));

  try {
    const url = new URL(withoutQuery);
    return { server: url.origin, path: safeDecodePath(url.pathname), templateQueryParams };
  } catch {
    const path = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
    return { server: null, path, templateQueryParams };
  }
}

/** URL 解析会把 `{` 转成 %7B，这里解回来；模板里出现裸 `%` 时 decode 会抛，退回原样 */
function safeDecodePath(pathname: string): string {
  try {
    return decodeURIComponent(pathname) || "/";
  } catch {
    return pathname || "/";
  }
}

function pathParamNames(path: string): string[] {
  return [...path.matchAll(/\{([^{}/]+)\}/g)].map((match) => match[1]);
}

function typeToSchema(type: string): Record<string, unknown> {
  const lower = type.trim().toLowerCase();
  if (/^(int|integer|long)/.test(lower)) return { type: "integer" };
  if (/^(number|float|double|decimal)/.test(lower)) return { type: "number" };
  if (/^bool/.test(lower)) return { type: "boolean" };
  if (/^(array|list)/.test(lower)) return { type: "array", items: {} };
  if (/^(object|json|map|dict)/.test(lower)) return { type: "object" };
  return { type: "string", ...(lower && lower !== "string" ? { description: type } : {}) };
}

function contentTypeKey(contentType: string | null | undefined, fallback: string): string {
  return (contentType ?? fallback).split(";")[0].trim() || fallback;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "op";
}

function buildOperation(endpoint: ProtocolEndpoint, split: SplitUrl, needsServer: boolean): Record<string, unknown> {
  const declaredPathParams = new Set(pathParamNames(split.path));
  const parameters: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  for (const param of endpoint.params) {
    if (param.in === "body") continue;
    const key = `${param.in}:${param.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parameters.push({
      name: param.name,
      in: param.in,
      required: param.in === "path" ? true : param.required,
      description: param.description,
      schema: typeToSchema(param.type),
    });
    if (param.in === "path") declaredPathParams.delete(param.name);
  }
  // 模板里出现但模型没列出的路径 / 查询参数也要补上，否则文档不合法
  for (const name of declaredPathParams) {
    parameters.push({ name, in: "path", required: true, schema: { type: "string" } });
  }
  for (const name of split.templateQueryParams) {
    if (seen.has(`query:${name}`)) continue;
    parameters.push({ name, in: "query", required: false, schema: { type: "string" } });
  }

  const bodyParams = endpoint.params.filter((param) => param.in === "body");
  const hasBody = bodyParams.length > 0 || endpoint.requestExample !== null;
  const requestBody = hasBody
    ? {
        required: bodyParams.some((param) => param.required),
        content: {
          [contentTypeKey(endpoint.requestContentType, "application/json")]: {
            schema: bodyParams.length > 0
              ? {
                  type: "object",
                  properties: Object.fromEntries(bodyParams.map((param) => [param.name, { ...typeToSchema(param.type), description: param.description }])),
                  required: bodyParams.filter((param) => param.required).map((param) => param.name),
                }
              : {},
            ...(endpoint.requestExample !== null ? { example: endpoint.requestExample } : {}),
          },
        },
      }
    : undefined;

  const responseContentType = contentTypeKey(
    endpoint.responseContentType,
    endpoint.streaming === "sse" ? "text/event-stream" : "application/json",
  );
  const responses = {
    "200": {
      description: endpoint.responseDescription || "成功响应",
      content: {
        [responseContentType]: {
          schema: {},
          ...(endpoint.responseExample !== null ? { example: endpoint.responseExample } : {}),
        },
      },
    },
  };

  const operation: Record<string, unknown> = {
    operationId: slugify(endpoint.id),
    summary: endpoint.purpose,
    parameters,
    responses,
    "x-evidence-seqs": endpoint.exampleSeqs,
    "x-depends-on": endpoint.dependsOn,
  };
  if (requestBody) operation.requestBody = requestBody;
  if (endpoint.streaming) operation["x-streaming"] = endpoint.streaming;
  if (endpoint.auth !== "none") operation.security = [{ [SECURITY_SCHEME_NAMES[endpoint.auth]]: [] }];
  if (needsServer && split.server) operation.servers = [{ url: split.server }];
  return operation;
}

export function buildOpenApiDocument(spec: ProtocolSpec, meta: OpenApiMeta = {}): OpenApiDocument {
  const splits = spec.endpoints.map((endpoint) => ({ endpoint, split: splitUrlTemplate(endpoint.urlTemplate) }));
  const servers = [...new Set([
    ...spec.baseUrls.map((url) => url.replace(/\/+$/, "")),
    ...splits.map(({ split }) => split.server).filter((server): server is string => Boolean(server)),
  ])];
  const needsPerOperationServer = servers.length > 1;

  const paths: Record<string, Record<string, unknown>> = {};
  const usedOperationIds = new Set<string>();
  for (const { endpoint, split } of splits) {
    const method = endpoint.method.trim().toLowerCase() || "get";
    const pathItem = (paths[split.path] ??= {});
    const operation = buildOperation(endpoint, split, needsPerOperationServer);
    let operationId = operation.operationId as string;
    let suffix = 2;
    while (usedOperationIds.has(operationId)) {
      operationId = `${operation.operationId as string}-${suffix}`;
      suffix += 1;
    }
    usedOperationIds.add(operationId);
    operation.operationId = operationId;
    if (pathItem[method]) {
      // 同一路径同一方法出现两次（不同用途）：保留第一份，把后者的依据合并进去
      const existing = pathItem[method] as Record<string, unknown>;
      existing["x-evidence-seqs"] = [...new Set([...(existing["x-evidence-seqs"] as number[]), ...endpoint.exampleSeqs])];
      continue;
    }
    pathItem[method] = operation;
  }

  const usedAuth = new Set<EndpointAuth>();
  for (const endpoint of spec.endpoints) {
    if (endpoint.auth !== "none") usedAuth.add(endpoint.auth);
  }
  const securitySchemes = buildSecuritySchemes(spec, usedAuth);

  const info: Record<string, unknown> = {
    title: meta.title ?? (meta.sessionName ? `${meta.sessionName} API` : "Captured API"),
    version: meta.version ?? "1.0.0",
    description: spec.summary,
    "x-scene": spec.scene,
    "x-generated-by": "Anything Analyzer",
  };
  if (meta.targetUrl) info["x-target-url"] = meta.targetUrl;
  if (meta.generatedAt) info["x-generated-at"] = new Date(meta.generatedAt).toISOString();

  const document: OpenApiDocument = {
    openapi: "3.1.0",
    info,
    servers: servers.map((url) => ({ url })),
    paths,
    components: { securitySchemes },
    "x-auth-chain": spec.authChain,
    "x-flows": spec.flows,
    "x-storage": spec.storage,
    "x-crypto": spec.crypto,
  };
  if (spec.risks.length > 0) document["x-risks"] = spec.risks;
  if (spec.openQuestions.length > 0) document["x-open-questions"] = spec.openQuestions;
  return document;
}
