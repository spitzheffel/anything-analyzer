import { describe, expect, it } from "vitest";
import {
  ProtocolSpecSchema,
  isEnrichmentFresh,
  parseProtocolSpec,
  parseProtocolSpecJson,
  parseSessionEnrichmentJson,
  restrictSpecEndpointRefs,
  restrictSpecSeqs,
  sanitizeSpecReferences,
  toSessionEnrichment,
} from "../../src/shared/protocol-spec";
import type { AssembledData } from "../../src/shared/types";
import { sampleSpec } from "./fixtures/protocol-spec.fixture";

describe("ProtocolSpecSchema", () => {
  it("accepts a complete spec", () => {
    expect(ProtocolSpecSchema.safeParse(sampleSpec).success).toBe(true);
  });

  it("fills missing arrays with defaults so a partial model answer still parses", () => {
    const parsed = parseProtocolSpec({
      specVersion: 1,
      scene: "x",
      summary: "y",
      reproduction: null,
      endpoints: [{
        id: "a", method: "GET", urlTemplate: "https://a.b/c", purpose: "p", auth: "none",
        requestContentType: null, requestExample: null, responseContentType: null,
        responseDescription: "", responseExample: null, streaming: null,
      }],
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.baseUrls).toEqual([]);
    expect(parsed?.authChain).toEqual([]);
    expect(parsed?.endpoints[0].params).toEqual([]);
    expect(parsed?.endpoints[0].exampleSeqs).toEqual([]);
  });

  it("rejects wrong versions and invalid enums, but tolerates a missing version", () => {
    expect(parseProtocolSpec({ ...sampleSpec, specVersion: 2 })).toBeNull();
    expect(parseProtocolSpec({ ...sampleSpec, endpoints: [{ ...sampleSpec.endpoints[0], auth: "magic" }] })).toBeNull();
    const { specVersion: _dropped, ...withoutVersion } = sampleSpec;
    expect(parseProtocolSpec(withoutVersion)?.specVersion).toBe(1);
  });

  it("parses JSON strings and tolerates garbage", () => {
    expect(parseProtocolSpecJson(JSON.stringify(sampleSpec))?.scene).toBe("login");
    expect(parseProtocolSpecJson("not json")).toBeNull();
    expect(parseProtocolSpecJson(null)).toBeNull();
  });
});

describe("restrictSpecSeqs", () => {
  it("drops sequence numbers that do not exist in the session and dedupes", () => {
    const restricted = restrictSpecSeqs(
      { ...sampleSpec, endpoints: [{ ...sampleSpec.endpoints[1], exampleSeqs: [7, 999, 7] }] },
      new Set([3, 7]),
    );
    expect(restricted.endpoints[0].exampleSeqs).toEqual([7]);
    expect(restricted.authChain[0].evidenceSeqs).toEqual([3, 7]);
    expect(restricted.storage[0].evidenceSeqs).toEqual([3]);
  });
});

describe("restrictSpecEndpointRefs", () => {
  it("drops dangling dependsOn ids, self references and flow steps, and removes emptied flows", () => {
    const cleaned = restrictSpecEndpointRefs({
      ...sampleSpec,
      endpoints: [
        { ...sampleSpec.endpoints[0], dependsOn: ["login", "ghost"] },
        { ...sampleSpec.endpoints[1], dependsOn: ["login", "login", "nope"] },
      ],
      flows: [
        { name: "ok", description: "", steps: [{ endpointId: "login", note: "" }, { endpointId: "missing", note: "" }] },
        { name: "all-missing", description: "", steps: [{ endpointId: "missing", note: "" }] },
      ],
    });
    expect(cleaned.endpoints[0].dependsOn).toEqual([]);
    expect(cleaned.endpoints[1].dependsOn).toEqual(["login"]);
    expect(cleaned.flows).toEqual([{ name: "ok", description: "", steps: [{ endpointId: "login", note: "" }] }]);
  });

  it("sanitizeSpecReferences applies both seq and endpoint cleanup", () => {
    const cleaned = sanitizeSpecReferences(
      { ...sampleSpec, flows: [{ name: "x", description: "", steps: [{ endpointId: "ghost", note: "" }] }] },
      new Set([3]),
    );
    expect(cleaned.flows).toEqual([]);
    expect(cleaned.endpoints[1].exampleSeqs).toEqual([]);
    expect(cleaned.authChain[0].evidenceSeqs).toEqual([3]);
  });

  it("normalizes methods to upper case and trims identifiers before matching references", () => {
    const cleaned = sanitizeSpecReferences(
      {
        ...sampleSpec,
        endpoints: [
          { ...sampleSpec.endpoints[0], id: " login ", method: "post" },
          { ...sampleSpec.endpoints[1], method: "Get", dependsOn: ["login "] },
        ],
        flows: [{ name: "f", description: "", steps: [{ endpointId: " login", note: "" }] }],
      },
      new Set([3, 7]),
    );
    expect(cleaned.endpoints.map((e) => e.method)).toEqual(["POST", "GET"]);
    expect(cleaned.endpoints[0].id).toBe("login");
    expect(cleaned.endpoints[1].dependsOn).toEqual(["login"]);
    expect(cleaned.flows[0].steps[0].endpointId).toBe("login");
  });
});

describe("isEnrichmentFresh", () => {
  it("only trusts a cached enrichment whose totalRequests matches", () => {
    const base = toSessionEnrichment({ requests: [], streamingRequests: [], sceneHints: [], authChain: [], storageDiff: {} } as never, 5);
    expect(isEnrichmentFresh(base, 5)).toBe(true);
    expect(isEnrichmentFresh(base, 6)).toBe(false);
    expect(isEnrichmentFresh({ ...base, totalRequests: undefined }, 5)).toBe(false);
    expect(isEnrichmentFresh(null, 5)).toBe(false);
  });
});

describe("SessionEnrichment", () => {
  it("is derived from assembled data without touching bodies", () => {
    const data = {
      requests: [{ seq: 1 }, { seq: 2 }],
      streamingRequests: [{ seq: 2 }],
      sceneHints: [{ scene: "login", confidence: "high", evidence: "POST /login", relatedRequestIds: ["#1"] }],
      authChain: [{ source: "POST /login 响应", credentialType: "Bearer Token", credential: "abc...xyz", consumers: ["/me"] }],
      storageDiff: { cookies: { added: {}, changed: {}, removed: [] }, localStorage: { added: { token: "x" }, changed: {}, removed: [] }, sessionStorage: { added: {}, changed: {}, removed: [] } },
    } as unknown as AssembledData;
    const enrichment = toSessionEnrichment(data);
    expect(enrichment.requestCount).toBe(2);
    expect(enrichment.streamingSeqs).toEqual([2]);
    expect(enrichment.sceneHints[0].scene).toBe("login");
    expect(parseSessionEnrichmentJson(JSON.stringify(enrichment))?.authChain[0].credentialType).toBe("Bearer Token");
    expect(parseSessionEnrichmentJson("{}")).toBeNull();
  });
});
