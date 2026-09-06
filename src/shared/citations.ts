/**
 * 报告正文里的请求引用：模型被要求写成 `[#12]`，历史报告和索引行里也有裸 `#12`。
 * 序号限制 1~5 位，避免把 `#123456` 这类颜色值或哈希误当引用。
 */

const BRACKETED_CITATION = /\[#(\d{1,5})\]/g;
/** 裸 `#12`：前面必须是行首、空白、括号或中文标点，后面不能紧跟数字 / 字母 */
const BARE_CITATION = /(^|[\s(（、，,;；:：])#(\d{1,5})(?![\d\w])/g;
/**
 * 可改写成链接的 `[#12]`：后面紧跟 `(` 的不动 —— 那是一个文本恰好为 #12 的真实 markdown 链接，
 * 或者已经被 linkify 过的 `[#12](seq://12)`。
 */
const LINKIFIABLE_CITATION = /\[#(\d{1,5})\](?!\()/g;

export const CITATION_SCHEME = "seq://";

export function extractCitedSeqs(markdown: string): number[] {
  const seqs = new Set<number>();
  for (const match of markdown.matchAll(BRACKETED_CITATION)) seqs.add(Number(match[1]));
  for (const match of markdown.matchAll(BARE_CITATION)) seqs.add(Number(match[2]));
  return [...seqs].sort((left, right) => left - right);
}

export interface CitationValidation {
  cited: number[];
  unknown: number[];
}

export function validateCitations(markdown: string, knownSeqs: Iterable<number>): CitationValidation {
  const known = knownSeqs instanceof Set ? knownSeqs : new Set(knownSeqs);
  const cited = extractCitedSeqs(markdown);
  return { cited, unknown: cited.filter((seq) => !known.has(seq)) };
}

/**
 * 把 `[#12]` 改写成 `[#12](seq://12)`，供渲染层挂点击事件。只改渲染副本，不改落库正文。
 */
export function linkifyCitations(markdown: string): string {
  if (!markdown.includes("[#")) return markdown;
  return markdown.replace(LINKIFIABLE_CITATION, (_match, seq: string) => `[#${seq}](${CITATION_SCHEME}${seq})`);
}

/**
 * 从 `seq://12` 这类 href 里取序号；不是引用链接时返回 null。
 */
export function parseCitationHref(href: string | undefined | null): number | null {
  if (!href || !href.startsWith(CITATION_SCHEME)) return null;
  const seq = Number(href.slice(CITATION_SCHEME.length));
  return Number.isInteger(seq) && seq >= 0 ? seq : null;
}
