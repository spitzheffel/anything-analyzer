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

/** 围栏代码块的起止行：``` 或 ~~~，按 CommonMark 允许最多 3 个前导空格 */
const CODE_FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;

function linkifyPlainText(text: string): string {
  return text.replace(LINKIFIABLE_CITATION, (_match, seq: string) => `[#${seq}](${CITATION_SCHEME}${seq})`);
}

/**
 * 行内代码（`...`）里的内容原样保留，其余部分照常改写。
 */
function linkifyOutsideInlineCode(line: string): string {
  if (!line.includes("`")) return linkifyPlainText(line);
  let result = "";
  let cursor = 0;
  while (cursor < line.length) {
    const open = line.indexOf("`", cursor);
    if (open < 0) {
      result += linkifyPlainText(line.slice(cursor));
      break;
    }
    result += linkifyPlainText(line.slice(cursor, open));
    let runEnd = open;
    while (runEnd < line.length && line[runEnd] === "`") runEnd += 1;
    const run = line.slice(open, runEnd);
    const close = line.indexOf(run, runEnd);
    if (close < 0) {
      // 反引号没有配对，剩下的整段当代码处理，宁可少改也不要改坏
      result += line.slice(open);
      break;
    }
    result += line.slice(open, close + run.length);
    cursor = close + run.length;
  }
  return result;
}

/**
 * 把 `[#12]` 改写成 `[#12](seq://12)`，供渲染层挂点击事件。只改渲染副本，不改落库正文。
 *
 * 代码块要跳过：围栏里 markdown 链接不解析，改写后用户看到的就是复现代码里
 * 多出来的 `(seq://12)`，而那段代码本来是要复制走用的。
 */
export function linkifyCitations(markdown: string): string {
  if (!markdown.includes("[#")) return markdown;
  let fence: string | null = null;
  return markdown
    .split("\n")
    .map((line) => {
      const match = CODE_FENCE.exec(line);
      if (fence !== null) {
        const closes =
          match !== null
          && match[1][0] === fence[0]
          && match[1].length >= fence.length
          && line.slice(match[0].length).trim() === "";
        if (closes) fence = null;
        return line;
      }
      if (match !== null) {
        fence = match[1];
        return line;
      }
      return linkifyOutsideInlineCode(line);
    })
    .join("\n");
}

/**
 * 从 `seq://12` 这类 href 里取序号；不是引用链接时返回 null。
 */
export function parseCitationHref(href: string | undefined | null): number | null {
  if (!href || !href.startsWith(CITATION_SCHEME)) return null;
  const seq = Number(href.slice(CITATION_SCHEME.length));
  return Number.isInteger(seq) && seq >= 0 ? seq : null;
}
