import { describe, expect, it } from "vitest";
import {
  extractCitedSeqs,
  linkifyCitations,
  parseCitationHref,
  validateCitations,
} from "../../src/shared/citations";

describe("extractCitedSeqs", () => {
  it("collects bracketed and bare citations, sorted and deduped", () => {
    const md = "登录接口 [#12] 返回 token，随后 #3 和 [#12][#15] 使用它。（见 #7）";
    expect(extractCitedSeqs(md)).toEqual([3, 7, 12, 15]);
  });

  it("ignores markdown headings, hex colors and identifiers", () => {
    const md = "# 标题\n## 二级\n颜色 #ffffff 和 #123456，变量 foo#1bar，issue#42x";
    expect(extractCitedSeqs(md)).toEqual([]);
  });

  it("handles line starts and CJK punctuation", () => {
    expect(extractCitedSeqs("#1 开头\n然后，#2，还有：#3；最后(#4)")).toEqual([1, 2, 3, 4]);
  });
});

describe("validateCitations", () => {
  it("separates known and unknown seqs", () => {
    const result = validateCitations("[#1] [#2] [#99]", [1, 2, 3]);
    expect(result.cited).toEqual([1, 2, 99]);
    expect(result.unknown).toEqual([99]);
  });
});

describe("linkifyCitations", () => {
  it("turns [#12] into a seq:// link and leaves other text alone", () => {
    expect(linkifyCitations("见 [#12] 与 [#7]。")).toBe("见 [#12](seq://12) 与 [#7](seq://7)。");
    expect(linkifyCitations("没有引用")).toBe("没有引用");
  });

  it("does not double-link already linked citations", () => {
    const once = linkifyCitations("[#5] 和 [#6]");
    expect(linkifyCitations(once)).toBe(once);
  });

  it("leaves bare #12 untouched (only bracketed form is clickable)", () => {
    expect(linkifyCitations("请求 #12 很重要 [#12]")).toBe("请求 #12 很重要 [#12](seq://12)");
  });

  it("does not rewrite a real markdown link whose text happens to be #12", () => {
    const md = "文档见 [#12](https://example.com/docs) 与引用 [#12]";
    expect(linkifyCitations(md)).toBe("文档见 [#12](https://example.com/docs) 与引用 [#12](seq://12)");
  });
});

describe("parseCitationHref", () => {
  it("extracts the seq from seq:// hrefs only", () => {
    expect(parseCitationHref("seq://12")).toBe(12);
    expect(parseCitationHref("seq://abc")).toBeNull();
    expect(parseCitationHref("https://example.com")).toBeNull();
    expect(parseCitationHref(undefined)).toBeNull();
  });
});
