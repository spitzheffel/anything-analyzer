import { describe, expect, it } from "vitest";
import {
  checkReportEvidence,
  countEvidenceGaps,
  endpointMatchesCapture,
  parseReportEvidenceJson,
  urlTemplateToRegExp,
} from "../../src/shared/spec-evidence";
import { sampleSpec } from "./fixtures/protocol-spec.fixture";
import type { ProtocolSpec } from "../../src/shared/protocol-spec";

const requests = [
  { seq: 1, method: "POST", url: "https://api.example.com/v1/login" },
  { seq: 2, method: "GET", url: "https://api.example.com/v1/users/42?expand=profile" },
  { seq: 3, method: "GET", url: "https://api.example.com/v1/orders" },
];

function specWith(overrides: Partial<ProtocolSpec>): ProtocolSpec {
  return { ...sampleSpec, endpoints: [], authChain: [], storage: [], crypto: [], ...overrides };
}

function endpoint(partial: Partial<ProtocolSpec["endpoints"][number]>): ProtocolSpec["endpoints"][number] {
  return {
    id: "ep", method: "GET", urlTemplate: "https://api.example.com/v1/orders", purpose: "",
    auth: "none", params: [], requestContentType: null, requestExample: null,
    responseContentType: null, responseDescription: "", responseExample: null,
    streaming: null, exampleSeqs: [3], dependsOn: [],
    ...partial,
  };
}

describe("urlTemplateToRegExp", () => {
  it("turns path variables into one path segment and ignores the query", () => {
    const pattern = urlTemplateToRegExp("https://api.example.com/v1/users/{id}")!;
    expect(pattern.test("https://api.example.com/v1/users/42")).toBe(true);
    expect(pattern.test("https://api.example.com/v1/users/42/orders")).toBe(false);
    expect(pattern.test("https://api.example.com/v1/teams/42")).toBe(false);

    // 模板自带查询串也不该影响匹配
    expect(urlTemplateToRegExp("https://h/a?x=1")!.test("https://h/a")).toBe(true);
    expect(urlTemplateToRegExp("   ")).toBeNull();
  });

  it("does not let regex characters in the template escape", () => {
    const pattern = urlTemplateToRegExp("https://api.example.com/v1/a.b+c")!;
    expect(pattern.test("https://api.example.com/v1/a.b+c")).toBe(true);
    expect(pattern.test("https://api.example.com/v1/axbxc")).toBe(false);
  });
});

describe("endpointMatchesCapture", () => {
  it("matches on method and path, tolerating query strings and trailing slashes", () => {
    expect(endpointMatchesCapture({ method: "GET", urlTemplate: "https://api.example.com/v1/users/{id}" }, requests)).toBe(true);
    expect(endpointMatchesCapture({ method: "get", urlTemplate: "https://api.example.com/v1/orders/" }, requests)).toBe(true);
    // 方法对不上就是对不上
    expect(endpointMatchesCapture({ method: "DELETE", urlTemplate: "https://api.example.com/v1/orders" }, requests)).toBe(false);
    // 完全编出来的端点
    expect(endpointMatchesCapture({ method: "POST", urlTemplate: "https://api.example.com/v1/admin/wipe" }, requests)).toBe(false);
  });
});

describe("checkReportEvidence", () => {
  it("reports citations that point at requests which do not exist", () => {
    const evidence = checkReportEvidence({
      reportContent: "登录见 [#1]，另见 [#99] 和 [#100]。",
      spec: null,
      requests,
    });
    expect(evidence.unknownCitations).toEqual([99, 100]);
    expect(countEvidenceGaps(evidence)).toBe(2);
  });

  it("flags endpoints and entries that cite nothing at all", () => {
    const evidence = checkReportEvidence({
      reportContent: "报告",
      spec: specWith({
        endpoints: [endpoint({ id: "orders", exampleSeqs: [3] }), endpoint({ id: "ghost", exampleSeqs: [] })],
        authChain: [
          { credentialType: "Bearer Token", obtainedFrom: "login", carriedIn: "header", keyName: "Authorization", refreshFlow: null, evidenceSeqs: [1] },
          { credentialType: "Session Cookie", obtainedFrom: "?", carriedIn: "cookie", keyName: null, refreshFlow: null, evidenceSeqs: [] },
        ],
        storage: [{ type: "localStorage", key: "token", role: "", evidenceSeqs: [] }],
        crypto: [{ algorithm: "HMAC-SHA256", location: "", inputs: "", output: "", notes: "", evidenceSeqs: [] }],
      }),
      requests,
    });

    expect(evidence.endpointsWithoutEvidence).toEqual(["ghost"]);
    expect(evidence.entriesWithoutEvidence).toEqual([
      { kind: "authChain", label: "Session Cookie" },
      { kind: "storage", label: "localStorage:token" },
      { kind: "crypto", label: "HMAC-SHA256" },
    ]);
  });

  it("flags an endpoint whose URL matches nothing that was captured", () => {
    const evidence = checkReportEvidence({
      reportContent: "报告",
      spec: specWith({
        endpoints: [
          endpoint({ id: "orders" }),
          // 序号是真的，URL 是编的：两个信号各自独立
          endpoint({ id: "invented", method: "POST", urlTemplate: "https://api.example.com/v1/admin/wipe", exampleSeqs: [1] }),
        ],
      }),
      requests,
    });

    expect(evidence.endpointsNotInCapture).toEqual(["invented"]);
    expect(evidence.endpointsWithoutEvidence).toEqual([]);
  });

  it("says nothing when every claim can be backed up", () => {
    const evidence = checkReportEvidence({
      reportContent: "登录见 [#1]，资料见 [#2]。",
      spec: specWith({ endpoints: [endpoint({ id: "orders" })] }),
      requests,
    });
    expect(countEvidenceGaps(evidence)).toBe(0);
  });
});

describe("parseReportEvidenceJson", () => {
  it("round-trips and rejects junk", () => {
    const evidence = checkReportEvidence({ reportContent: "见 [#99]", spec: null, requests });
    expect(parseReportEvidenceJson(JSON.stringify(evidence))).toEqual(evidence);
    expect(parseReportEvidenceJson(null)).toBeNull();
    expect(parseReportEvidenceJson("not json")).toBeNull();
    expect(parseReportEvidenceJson('{"unknownCitations":["x",7]}')?.unknownCitations).toEqual([7]);
    expect(parseReportEvidenceJson('{"entriesWithoutEvidence":[{"kind":"bogus","label":"a"}]}')?.entriesWithoutEvidence).toEqual([]);
  });
});
