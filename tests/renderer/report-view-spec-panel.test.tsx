import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ReportView from "../../src/renderer/components/ReportView";
import { LocaleProvider } from "../../src/renderer/i18n";
import type { AnalysisReport } from "../../src/shared/types";
import { sampleSpec } from "../shared/fixtures/protocol-spec.fixture";

function report(overrides: Partial<AnalysisReport> = {}): AnalysisReport {
  return {
    id: "r1",
    session_id: "s1",
    created_at: Date.UTC(2026, 8, 6),
    llm_provider: "openai",
    llm_model: "gpt-4o",
    prompt_tokens: 100,
    completion_tokens: 50,
    report_content: "# 报告\n\n登录接口见 [#3]，资料接口见 [#7]。",
    filter_prompt_tokens: null,
    filter_completion_tokens: null,
    purpose: "auto",
    spec_json: JSON.stringify(sampleSpec),
    spec_error: null,
    enrichment_json: null,
    ...overrides,
  };
}

function render(r: AnalysisReport): string {
  return renderToStaticMarkup(
    <LocaleProvider locale="zh">
      <ReportView
        report={r}
        isAnalyzing={false}
        analysisError={null}
        streamingContent=""
        onReAnalyze={() => {}}
        onCancelAnalysis={() => {}}
        chatHistory={[]}
        isChatting={false}
        chatError={null}
        onSendFollowUp={() => {}}
        onCiteClick={() => {}}
        onEnsureSpec={async () => {}}
      />
    </LocaleProvider>,
  );
}

describe("ReportView structured panel", () => {
  it("renders scene, spec endpoints with auth badges, the auth chain and clickable citations", () => {
    const markup = render(report());
    expect(markup).toContain("场景");
    expect(markup).toContain(sampleSpec.summary);
    expect(markup).toContain("端点 · 2");
    expect(markup).toContain("/v1/users/{id}");
    expect(markup).toContain(">bearer<");
    expect(markup).toContain("鉴权链");
    expect(markup).toContain("Bearer Token");
    // 引用渲染为无 href 的 role=link，避免中键 / Ctrl+点击触发导航
    expect(markup).toContain('role="link" tabindex="0" class="_citation_');
    expect(markup).toContain('title="跳转到请求 #3"');
    expect(markup).toContain('title="跳转到请求 #7"');
    expect(markup).not.toContain('href="seq://');
    // 下拉默认收起，工具栏只显示触发按钮
    expect(markup).toContain("导出 ▾");
    expect(markup).not.toContain("导出 .md");
    expect(markup).not.toContain("结构化数据抽取失败");
  });

  it("falls back to raw endpoints and offers a retry when the spec is missing", () => {
    const markup = render(report({ spec_json: null, spec_error: "relay returned HTML" }));
    expect(markup).toContain("结构化数据抽取失败");
    expect(markup).toContain("relay returned HTML");
    expect(markup).toContain("重新抽取");
    expect(markup).not.toContain("鉴权链");
  });
});
