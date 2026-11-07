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

const LANGS: Record<string, unknown> = { bash, cpp, css, go, java, javascript, json, kotlin, markdown, python, rust, sql, typescript, xml, yaml };
for (const [name, lang] of Object.entries(LANGS)) hljs.registerLanguage(name, lang as never);
const ALIAS: Record<string, string> = { js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript", py: "python",
  sh: "bash", shell: "bash", zsh: "bash", html: "xml", htm: "xml", yml: "yaml", md: "markdown", "c++": "cpp", c: "cpp", kt: "kotlin", rs: "rust" };

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  renderer: {
    code({ text, lang }: Tokens.Code) {
      const raw = (lang || "").trim().split(/\s+/)[0].toLowerCase();
      const name = ALIAS[raw] || raw;
      let html: string;
      if (name && hljs.getLanguage(name)) {
        html = hljs.highlight(text, { language: name, ignoreIllegals: true }).value;
      } else {
        html = escapeHtml(text);
      }
      const label = escapeHtml(raw || "text");
      return `<div class="code-block"><div class="code-head"><span class="code-lang">${label}</span>` +
        `<button type="button" class="code-copy" data-copy aria-label="Copy ${label} code">Copy</button></div>` +
        `<pre><code class="hljs language-${escapeHtml(name || "plaintext")}">${html}</code></pre></div>`;
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
  const html = marked.parse(src, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ["target", "data-copy", "aria-label", "tabindex", "role"],
    FORBID_TAGS: ["style", "form", "input", "textarea", "select", "iframe", "object", "embed"],
    FORBID_ATTR: ["onerror", "onload", "onclick"],
  });
}
