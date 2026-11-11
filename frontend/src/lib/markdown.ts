/** Markdown → sanitised HTML. marked (GFM) + highlight.js (common languages only, to keep the bundle small) +
 * DOMPurify. Model output is untrusted: raw HTML in it is sanitised, links open in a new tab without opener. */
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { Marked, type Tokens } from "marked";
import { escapeHtml } from "./escape";
import { extractMath, restoreMath } from "./math";
import { calloutKind } from "./callout";

const LANGS: Record<string, unknown> = { bash, cpp, css, go, java, javascript, json, kotlin, markdown, python, rust, sql, typescript, xml, yaml };
for (const [name, lang] of Object.entries(LANGS)) hljs.registerLanguage(name, lang as never);
// highlight.js's HTML/XML grammar asks for Unicode regexes but contains /<\!--/, which isn't valid in that mode
// (it threw on every ```html block); the same grammar without the Unicode flag works fine
hljs.registerLanguage("xml", (h) => ({ ...(xml as unknown as (h: unknown) => Record<string, unknown>)(h), unicodeRegex: false }) as never);
const ALIAS: Record<string, string> = { js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", py: "python",
  sh: "bash", shell: "bash", zsh: "bash", html: "xml", htm: "xml", yml: "yaml", md: "markdown", "c++": "cpp", c: "cpp", kt: "kotlin", rs: "rust" };

export { escapeHtml };

const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  renderer: {
    code({ text, lang }: Tokens.Code) {
      const raw = (lang || "").trim().split(/\s+/)[0].toLowerCase();
      // ```plot (or graph): drawn as an interactive graph by the Markdown component; the source shows until then
      if (raw === "plot" || raw === "graph") {
        return `<div class="plot-block" data-plot="${escapeHtml(encodeURIComponent(text))}"><pre class="plot-src">${escapeHtml(text)}</pre></div>`;
      }
      const name = ALIAS[raw] || raw;
      let html: string;
      let lit = "";
      if (name && hljs.getLanguage(name)) {
        try { lit = hljs.highlight(text, { language: name, ignoreIllegals: true }).value; } catch { lit = ""; }
      }
      if (lit) {
        html = lit;
      } else {
        html = escapeHtml(text);
      }
      const label = escapeHtml(raw || "text");
      // a web page the AI wrote: offer to turn it into an Android app
      const app = (name === "xml" && /^(html?|xhtml)$/.test(raw)) || raw === "html" ? `<button type="button" class="code-copy code-app" data-make-app aria-label="Make an Android app from this page">Make app</button>` : "";
      return `<div class="code-block"><div class="code-head"><span class="code-lang">${label}</span><span class="code-tools">${app}` +
        `<button type="button" class="code-copy" data-copy aria-label="Copy ${label} code">Copy</button></span></div>` +
        `<pre><code class="hljs language-${escapeHtml(name || "plaintext")}">${html}</code></pre></div>`;
    },
    blockquote({ tokens }: Tokens.Blockquote) {
      // "> **Tip:** …" / "> [!NOTE]" → a highlighted box; other quotes stay quotes
      let body = this.parser.parse(tokens);
      let kind = "";
      let label = "";
      const gh = body.match(/^<p>\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i);
      if (gh) {
        kind = calloutKind(gh[1]);
        label = gh[1][0].toUpperCase() + gh[1].slice(1).toLowerCase();
        body = body.replace(gh[0], "<p>").replace(/^<p>\s*<\/p>\s*/, "");
      } else {
        const m = body.match(/^<p><strong>([^<]{2,24}?)\s*(?::\s*<\/strong>|<\/strong>\s*:)\s*/);
        const k = m ? calloutKind(m[1]) : "";
        if (m && k) { kind = k; label = m[1].trim(); body = body.replace(m[0], "<p>").replace(/^<p>\s*<\/p>\s*/, ""); }
      }
      if (!kind) return `<blockquote>${body}</blockquote>`;
      return `<aside class="callout callout-${kind}" role="note"><p class="callout-label">${escapeHtml(label)}</p>${body}</aside>`;
    },
    table(token: Tokens.Table) {
      // wrap tables so they scroll horizontally on phones instead of breaking the layout
      const head = token.header.map((c) => `<th${c.align ? ` style="text-align:${c.align}"` : ""}>${this.parser.parseInline(c.tokens)}</th>`).join("");
      const rows = token.rows.map((r) => "<tr>" + r.map((c) => `<td${c.align ? ` style="text-align:${c.align}"` : ""}>${this.parser.parseInline(c.tokens)}</td>`).join("") + "</tr>").join("");
      return `<div class="table-wrap" tabindex="0" role="region" aria-label="Table"><table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table></div>`;
    },
  },
});

let hooked = false;
function hookPurify() {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      const href = node.getAttribute("href") || "";
      if (/^https?:|^mailto:/i.test(href)) {
        node.setAttribute("target", "_blank");
        node.setAttribute("rel", "noopener noreferrer nofollow");
      } else if (!href.startsWith("#")) {
        node.removeAttribute("href");
      }
    }
    if (node.tagName === "IMG") {
      const src = node.getAttribute("src") || "";
      if (!/^https:|^data:image\/(png|jpeg|gif|webp);/i.test(src)) node.removeAttribute("src");
      node.setAttribute("loading", "lazy");
      node.setAttribute("referrerpolicy", "no-referrer");
    }
  });
}

export function renderMarkdown(src: string): string {
  hookPurify();
  // the model's request for a picture ([[image: …]]) is for the app, not the reader — also while it's still arriving
  src = src.replace(/\[\[\s*image\s*:[^\]]*\]\]/gi, "").replace(/\[\[\s*i?m?a?g?e?\s*:?[^\]\n]*\]?$/i, (m) => (/^\[\[\s*(i|$)/i.test(m) ? "" : m));
  const { text, blocks } = extractMath(src);
  const html = marked.parse(text, { async: false }) as string;
  return restoreMath(DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ["target", "data-copy", "data-make-app", "data-plot", "aria-label", "tabindex", "role"],
    ADD_TAGS: ["aside"],
    FORBID_TAGS: ["style", "form", "input", "textarea", "select", "iframe", "object", "embed"],
    FORBID_ATTR: ["onerror", "onload", "onclick"],
  }), blocks);                                       // KaTeX output goes in after sanitising (it is generated, not model HTML)
}
