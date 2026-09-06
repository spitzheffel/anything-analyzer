import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, splitUrlTemplate } from "../../src/shared/openapi-export";
import { sampleSpec } from "./fixtures/protocol-spec.fixture";

describe("splitUrlTemplate", () => {
  it("splits server and decoded path, collecting template query params", () => {
    expect(splitUrlTemplate("https://api.example.com/v1/users/{id}?page={page}&size=10")).toEqual({
      server: "https://api.example.com",
      path: "/v1/users/{id}",
      templateQueryParams: ["page", "size"],
    });
  });

  it("keeps relative templates as paths", () => {
    expect(splitUrlTemplate("v1/ping")).toEqual({ server: null, path: "/v1/ping", templateQueryParams: [] });
  });

  it("survives a bare % in the template instead of throwing on decode", () => {
    const split = splitUrlTemplate("https://api.example.com/discount/100%/items/{id}");
    expect(split.server).toBe("https://api.example.com");
    expect(split.path).toContain("/items/");
    expect(() => buildOpenApiDocument({
      ...sampleSpec,
      endpoints: [{ ...sampleSpec.endpoints[0], urlTemplate: "https://api.example.com/discount/100%/items/{id}" }],
    })).not.toThrow();
  });
});

describe("buildOpenApiDocument", () => {
  const doc = buildOpenApiDocument(sampleSpec, {
    sessionName: "demo",
    targetUrl: "https://example.com",
    generatedAt: Date.UTC(2026, 8, 6),
  });

  it("produces a 3.1 document with servers, info and extensions", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("demo API");
    expect(doc.info.description).toBe(sampleSpec.summary);
    expect(doc.info["x-scene"]).toBe("login");
    expect(doc.info["x-target-url"]).toBe("https://example.com");
    expect(doc.servers).toEqual([{ url: "https://api.example.com" }]);
    expect(doc["x-flows"]).toEqual(sampleSpec.flows);
    expect(doc["x-auth-chain"]).toEqual(sampleSpec.authChain);
    expect(doc["x-risks"]).toEqual(sampleSpec.risks);
    expect(doc["x-open-questions"]).toBeUndefined();
  });

  it("turns endpoints into path operations with parameters, bodies and security", () => {
    const login = doc.paths["/v1/login"].post as Record<string, unknown>;
    expect(login.operationId).toBe("login");
    expect(login.summary).toBe("登录");
    expect(login.security).toBeUndefined();
    expect(login["x-evidence-seqs"]).toEqual([3]);
    const body = login.requestBody as { required: boolean; content: Record<string, { schema: { properties: Record<string, unknown>; required: string[] }; example: string }> };
    expect(body.required).toBe(true);
    expect(Object.keys(body.content)).toEqual(["application/json"]);
    expect(body.content["application/json"].schema.required).toEqual(["username", "password"]);
    expect(body.content["application/json"].example).toBe('{"username":"a","password":"b"}');

    const profile = doc.paths["/v1/users/{id}"].get as Record<string, unknown>;
    expect(profile.parameters).toEqual([
      { name: "id", in: "path", required: true, description: "用户 id", schema: { type: "string" } },
    ]);
    expect(profile.security).toEqual([{ bearerAuth: [] }]);
    expect(profile["x-depends-on"]).toEqual(["login"]);
    expect(profile.requestBody).toBeUndefined();
    expect(doc.components.securitySchemes).toEqual({ bearerAuth: { type: "http", scheme: "bearer" } });
  });

  it("names cookie / api-key security schemes after the real keys found in the auth chain", () => {
    const withCookie = buildOpenApiDocument({
      ...sampleSpec,
      endpoints: [
        { ...sampleSpec.endpoints[1], id: "a", auth: "cookie" },
        { ...sampleSpec.endpoints[1], id: "b", auth: "api-key" },
        { ...sampleSpec.endpoints[1], id: "c", auth: "signature" },
      ],
      authChain: [
        { credentialType: "Session Cookie", obtainedFrom: "login", carriedIn: "cookie", keyName: "PHPSESSID", refreshFlow: null, evidenceSeqs: [] },
        { credentialType: "App Key", obtainedFrom: "config", carriedIn: "query", keyName: "appkey", refreshFlow: null, evidenceSeqs: [] },
        { credentialType: "Request Signature", obtainedFrom: "js", carriedIn: "header", keyName: "X-Sign", refreshFlow: null, evidenceSeqs: [] },
      ],
    });
    expect(withCookie.components.securitySchemes).toEqual({
      cookieAuth: { type: "apiKey", in: "cookie", name: "PHPSESSID" },
      apiKeyAuth: { type: "apiKey", in: "query", name: "appkey" },
      signatureAuth: { type: "apiKey", in: "header", name: "X-Sign", description: "请求签名，算法见 x-crypto" },
    });

    const fallback = buildOpenApiDocument({ ...sampleSpec, authChain: [], endpoints: [{ ...sampleSpec.endpoints[1], auth: "cookie" }] });
    expect(fallback.components.securitySchemes).toEqual({ cookieAuth: { type: "apiKey", in: "cookie", name: "session" } });
  });

  it("adds path params found only in the template and per-operation servers when origins differ", () => {
    const multi = buildOpenApiDocument({
      ...sampleSpec,
      baseUrls: [],
      endpoints: [
        { ...sampleSpec.endpoints[0], id: "a", urlTemplate: "https://a.example.com/items/{itemId}?q={q}", params: [] },
        { ...sampleSpec.endpoints[0], id: "a", urlTemplate: "https://b.example.com/items", params: [], streaming: "sse", responseContentType: null },
      ],
    });
    expect(multi.servers.map((server) => server.url).sort()).toEqual(["https://a.example.com", "https://b.example.com"]);
    const first = multi.paths["/items/{itemId}"].post as Record<string, unknown>;
    expect(first.parameters).toEqual([
      { name: "itemId", in: "path", required: true, schema: { type: "string" } },
      { name: "q", in: "query", required: false, schema: { type: "string" } },
    ]);
    expect(first.servers).toEqual([{ url: "https://a.example.com" }]);
    const second = multi.paths["/items"].post as Record<string, unknown>;
    expect(second.operationId).toBe("a-2");
    expect(second["x-streaming"]).toBe("sse");
    const responses = second.responses as { "200": { content: Record<string, unknown> } };
    expect(Object.keys(responses["200"].content)).toEqual(["text/event-stream"]);
  });
});
