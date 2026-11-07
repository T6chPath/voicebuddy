/** Math in replies: LaTeX between $…$, $$…$$, \(…\), \[…\] or in ```math blocks, rendered with KaTeX.
 *
 * Math is cut out of the Markdown *before* marked sees it (so `_`, `*` and `\\` inside formulas aren't eaten as
 * Markdown), replaced by placeholders, and the KaTeX HTML is put back after sanitising. KaTeX runs with trust:false, so
 * formulas can't produce links, styles or HTML of their own. Each formula is rendered as HTML for the eye and MathML
 * for screen readers. Code spans and code blocks are left alone, and "$5 and $10" stays money, not math.
 */
import katex from "katex";
import { escapeHtml } from "./escape";

const TOKEN = (i: number) => `ZQMATH${i}ZQ`;
const TOKEN_RX = /ZQMATH(\d+)ZQ/g;

export interface MathBlock { tex: string; display: boolean }

function render(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, { displayMode: display, throwOnError: true, output: "htmlAndMathml", strict: "ignore", trust: false,
      maxSize: 20, maxExpand: 1000 });
  } catch {
    // not valid LaTeX (or cut off mid-stream): show the source quietly instead of a red error
    return `<code class="math-source" title="Couldn't typeset this formula">${escapeHtml(display ? `$$${tex}$$` : `$${tex}$`)}</code>`;
  }
}

/** Split into code and non-code pieces so formulas are only looked for outside code. */
function pieces(src: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = [];
  const rx = /(^|\n)( {0,3})(```|~~~)[^\n]*\n[\s\S]*?(\n {0,3}\3[^\S\n]*(?=\n|$)|$)|(`+)(?!`)[\s\S]*?[^`]\5(?!`)/g;
  let last = 0;
  for (const m of src.matchAll(rx)) {
    const start = m.index! + (m[1] ? m[1].length : 0);
    if (start > last) out.push({ code: false, text: src.slice(last, start) });
    out.push({ code: true, text: src.slice(start, m.index! + m[0].length) });
    last = m.index! + m[0].length;
  }
  if (last < src.length) out.push({ code: false, text: src.slice(last) });
  return out;
}

const MATH_FENCE = /^( {0,3})(```|~~~)\s*(math|latex|tex|katex)\s*\n([\s\S]*?)\n? {0,3}\2[^\S\n]*$/i;

export function extractMath(src: string): { text: string; blocks: MathBlock[] } {
  const blocks: MathBlock[] = [];
  const keep = (tex: string, display: boolean) => {
    blocks.push({ tex: tex.trim(), display });
    const t = TOKEN(blocks.length - 1);
    return display ? `\n\n${t}\n\n` : t;
  };
  let out = "";
  for (const p of pieces(src)) {
    if (p.code) {
      const f = p.text.match(MATH_FENCE);
      out += f ? keep(f[4], true) : p.text;
      continue;
    }
    let t = p.text;
    t = t.replace(/\\\$/g, "ZQDOLLARZQ");                                         // \$ is a literal dollar
    // display math never spans a blank line: a stray, unclosed $$ can't swallow the paragraphs after it
    t = t.replace(/\$\$((?:(?!\n\s*\n)[^$]|\$(?!\$))+?)\$\$/g, (_, tex) => keep(tex, true));
    t = t.replace(/\\\[((?:(?!\n\s*\n)[\s\S])+?)\\\]/g, (_, tex) => keep(tex, true));
    t = t.replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => keep(tex, false));
    // $…$ inline: no space just inside the dollars, no digit right after the closing one, one line only
    t = t.replace(/(^|[^\\$\w])\$(?=\S)([^$\n]+?)(?<=\S)\$(?!\d)/g, (_, pre, tex) => pre + keep(tex, false));
    out += t.replace(/ZQDOLLARZQ/g, "\\$");
  }
  return { text: out, blocks };
}

export function restoreMath(html: string, blocks: MathBlock[]): string {
  if (!blocks.length) return html;
  return html
    .replace(/<p>\s*ZQMATH(\d+)ZQ\s*<\/p>/g, (_, i) => displayHtml(blocks[Number(i)]))
    .replace(TOKEN_RX, (_, i) => {
      const b = blocks[Number(i)];
      return b.display ? displayHtml(b) : `<span class="math-inline">${render(b.tex, false)}</span>`;
    });
}

function displayHtml(b: MathBlock): string {
  return `<div class="math-display"><div class="math-scroll" tabindex="0" role="group" aria-label="Equation">${render(b.tex, true)}</div>` +
    `<button type="button" class="math-copy" data-copy-tex="${escapeHtml(b.tex)}" aria-label="Copy LaTeX">Copy LaTeX</button></div>`;
}

export { texToSpeech } from "./texspeech";
