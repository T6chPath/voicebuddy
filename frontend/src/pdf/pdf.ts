// PDF files from replies.
//
// The reply is laid out as a clean A4 document (title, date, the rendered Markdown with typeset math, page numbers) and
// printed to PDF by the platform's own engine, so math, tables, code and Hindi look exactly as they do on screen:
//   Android app — window.ZenvqoPDF renders it in an off-screen WebView and writes a real .pdf to Downloads/zenvqo
//                 (Android 10+), with Open and Share; older Android shows the system "Save as PDF" screen.
//   browsers    — the same layout through the browser's print dialog ("Save as PDF").
import { renderMarkdown } from "../lib/markdown";

/** Did the user ask for a PDF? ("generate pdf of 30 quiz questions", "isko pdf me bana do", "export as PDF") */
export function wantsPdf(text: string): boolean {
  const t = text.toLowerCase();
  if (!/\bpdf\b/.test(t)) return false;
  const makeVerb = /\b(make|create|generate|banao|bana|banado|bnao|export|convert|prepare)\b/.test(t);
  if (/\b(read|open|summari[sz]e|extract|from (the|this|my) pdf|attached pdf|this pdf|in the pdf)\b/.test(t) && !makeVerb) return false;
  if (/^\s*(what|how|why|which|where|when|who|is|are|does|do|kya|kaise|kyon|kyun)\b/.test(t) && !makeVerb) return false;   // a question about PDFs
  return /\b(generate|make|create|export|download|save|give|send|write|prepare|produce|convert|banao|bana|banado|bnao|bana do|de do|dedo|chahiye|chaiye|as a pdf|as pdf|in pdf|into pdf|pdf me|pdf mein|pdf file|pdf format)\b/.test(t);
}

/** How far the document has got: the highest numbered item so far ("1." / "Q12." / "**12.**"), else the word count. */
export function writtenSoFar(text: string): string {
  let n = 0;
  for (const m of text.matchAll(/^\s{0,3}(?:[*_#]+\s*)?(?:Q(?:uestion)?\s*)?(\d{1,3})[.):]/gim)) n = Math.max(n, +m[1]);
  if (n > 1) return `${n} items written`;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return words ? `${words} words written` : "starting";
}

export function pdfName(title: string): string {
  const slug = title.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "zenvqo";
  return `${slug}.pdf`;
}

/** Title for the document: the reply's first heading, else a cleaned-up version of the request. */
export function pdfTitle(reply: string, request: string): string {
  const h = reply.match(/^\s{0,3}#{1,2}\s+(.+?)\s*#*\s*$/m);
  if (h) return h[1].replace(/[*_`]/g, "").trim().slice(0, 120);
  const r = request.replace(/\b(please|pls|can you|could you|generate|make|create|give me|a|an|the|pdf( file)?|of|on|about|banao|bana do|in|as|me|mein|for)\b/gi, " ")
    .replace(/\s+/g, " ").trim();
  return r ? r[0].toUpperCase() + r.slice(1, 100) : "zenvqo document";
}

const PRINT_CSS = `
.pdf-doc { color-scheme: light; --text: #111 !important; --text-soft: #333 !important; --muted: #666 !important; --bg: #fff !important;
  --bg-soft: #f6f6f8 !important; --bg-elev: #fff !important; --panel: #f3f4f7 !important; --border: #ddd !important; --accent: #4f46e5 !important;
  --code-bg: #f6f6f8 !important; --code-text: #222 !important; color: #111; background: #fff; }
@page { size: A4; margin: 18mm 16mm 20mm; @bottom-center { content: counter(page) " / " counter(pages); font: 9pt system-ui, sans-serif; color: #777; } }
html, body { background: #fff !important; color: #111 !important; }
body { margin: 0; font: 11.5pt/1.55 system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Noto Sans Devanagari", sans-serif; }
.pdf-doc { max-width: none; }
.pdf-head { border-bottom: 2px solid #4f46e5; padding-bottom: 8px; margin-bottom: 18px; }
.pdf-head h1 { font-size: 20pt; margin: 0 0 4px; line-height: 1.25; color: #111; }
.pdf-meta { color: #666; font-size: 9pt; }
.pdf-doc .md h1, .pdf-doc .md h2, .pdf-doc .md h3 { break-after: avoid; page-break-after: avoid; color: #111; }
.pdf-doc .md h2 { font-size: 14pt; margin: 18px 0 6px; border-bottom: 1px solid #ddd; padding-bottom: 3px; }
.pdf-doc .md h3 { font-size: 12pt; margin: 14px 0 4px; }
.pdf-doc .md p, .pdf-doc .md li { orphans: 3; widows: 3; }
.pdf-doc .md li { margin: 3px 0; break-inside: avoid; }
.pdf-doc .md ol > li, .pdf-doc .md ul > li { break-inside: avoid; page-break-inside: avoid; }
.pdf-doc .md table { border-collapse: collapse; width: 100%; font-size: 10pt; break-inside: auto; }
.pdf-doc .md th, .pdf-doc .md td { border: 1px solid #ccc; padding: 4px 6px; }
.pdf-doc .md th { background: #f1f1f6 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.pdf-doc .md tr { break-inside: avoid; }
.pdf-doc .table-wrap { overflow: visible !important; }
.pdf-doc .code-block { border: 1px solid #ddd; border-radius: 6px; break-inside: avoid; }
.pdf-doc .code-head { display: none !important; }
.pdf-doc pre, .pdf-doc code { white-space: pre-wrap !important; word-break: break-word; font-size: 9.5pt; background: #f6f6f8 !important; color: #222 !important; }
.pdf-doc pre code .hljs-keyword, .pdf-doc pre code .hljs-built_in { color: #6b21a8 !important; }
.pdf-doc pre code .hljs-string { color: #166534 !important; }
.pdf-doc .math-display { background: #f7f7fb !important; border: 1px solid #e3e3ee; break-inside: avoid; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.pdf-doc .math-scroll { overflow: visible !important; }
.pdf-doc .math-copy { display: none !important; }
.pdf-doc .katex-mathml { display: none !important; }   /* screen-reader copy: in a PDF it would only add invisible duplicate text */
.pdf-doc a { color: #1d4ed8; text-decoration: none; }
.pdf-doc img { max-width: 100%; break-inside: avoid; }
.pdf-foot { margin-top: 24px; color: #888; font-size: 8.5pt; border-top: 1px solid #eee; padding-top: 6px; }
`;

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** The document part of a reply: from its first # / ## heading on (that heading becomes the title, so it's dropped);
 * chat before it ("Sure, here's your quiz!") doesn't belong in the file. */
export function documentMarkdown(reply: string): string {
  const m = reply.match(/^\s{0,3}#{1,2}\s+.+$/m);
  return m ? reply.slice(m.index! + m[0].length).replace(/^\s+/, "") : reply;
}

function bodyHtml(title: string, markdown: string): string {
  const date = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  return `<article class="pdf-doc"><header class="pdf-head"><h1>${esc(title)}</h1><div class="pdf-meta">${esc(date)} · zenvqo</div></header>` +
    `<div class="md">${renderMarkdown(documentMarkdown(markdown))}</div><footer class="pdf-foot">Made with zenvqo. AI-generated content can be wrong — check important information.</footer></article>`;
}

/* Only the CSS this document actually uses goes into the file the engine prints. Copying every app style (all screens,
 * every KaTeX font as base64) made a ~450 KB document that was slow to hand over and to lay out; a plain quiz now needs a
 * few KB, and math pulls in only the KaTeX fonts its symbols use. */
const PSEUDO = /::?(before|after|hover|focus|focus-visible|focus-within|active|visited|first-line|first-letter|marker|placeholder|selection|-webkit-[\w-]+|-moz-[\w-]+)(\([^)]*\))?/g;

function matches(doc: Document, selector: string): boolean {
  try { if (doc.querySelector(selector)) return true; } catch { /* pseudo-classes querySelector can't take */ }
  return selector.split(",").some((part) => {
    const s = part.replace(PSEUDO, "").trim();
    if (!s) return false;
    try { return !!doc.querySelector(s); } catch { return false; }
  });
}

function usedCss(doc: Document, rules: CSSRuleList, families: Set<string>, fonts: string[], base: string): string {
  let out = "";
  for (const r of Array.from(rules)) {
    if (r instanceof CSSStyleRule) {
      const sel = r.selectorText;
      if (/^(:root|html|body|\*)\b|^\[data-theme/.test(sel.trim()) || matches(doc, sel)) {
        out += r.cssText + "\n";
        const ff = r.style.getPropertyValue("font-family");
        if (ff) ff.split(",").forEach((f) => families.add(f.trim().replace(/^["']|["']$/g, "")));
      }
    } else if (r instanceof CSSMediaRule) {
      const inner = usedCss(doc, r.cssRules, families, fonts, base);
      if (inner) out += `@media ${r.conditionText} {\n${inner}}\n`;
    } else if (r instanceof CSSFontFaceRule) {
      const fam = r.style.getPropertyValue("font-family").trim().replace(/^["']|["']$/g, "");
      // font files of a linked stylesheet are relative to it; the printed document has another base URL
      fonts.push(fam + "\u0000" + r.cssText.replace(/url\((["']?)(?!data:)([^)"']+)\1\)/g, (_m, _q, u) => `url("${new URL(u, base).href}")`));
    }
  }
  return out;
}

let cssCache: { key: string; css: string } | null = null;

function documentCss(body: string): string {
  const doc = document.implementation.createHTMLDocument("pdf");
  doc.body.setAttribute("data-theme", "light");
  doc.body.innerHTML = body;
  const families = new Set<string>();
  const fonts: string[] = [];
  let css = "";
  for (const sheet of Array.from(document.styleSheets)) {
    try { css += usedCss(doc, sheet.cssRules, families, fonts, sheet.href || location.href); } catch { /* cross-origin sheet: skip */ }
  }
  const faces = fonts.filter((f) => families.has(f.slice(0, f.indexOf("\u0000")))).map((f) => f.slice(f.indexOf("\u0000") + 1)).join("\n");
  return faces + "\n" + css;
}

/** A complete, self-contained HTML document — only the styles (and math fonts) it uses — what the Android engine prints. */
export function printableDocument(title: string, markdown: string): string {
  const body = bodyHtml(title, markdown);
  // documents of the same shape (same element/class set) share the computed CSS
  const key = Array.from(new Set(body.match(/class="[^"]*"|<[a-z0-9]+/g) || [])).sort().join("|");
  const css = cssCache?.key === key ? cssCache.css : documentCss(body);
  cssCache = { key, css };
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css}\n${PRINT_CSS}</style></head>` +
    `<body data-theme="light">${body}</body></html>`;
}

/* ---------------- Android bridge ---------------- */
interface NativePDF { save(id: string, html: string, fileName: string): void; open(id: string): void; share(id: string): void }
declare global { interface Window { ZenvqoPDF?: NativePDF; __zpdf?: (id: string, status: string, data: string) => void } }

export interface PdfResult { kind: "file" | "dialog"; id: string; name: string; where: string }
let seq = 0;
const waiting = new Map<string, { resolve: (r: PdfResult) => void; reject: (e: Error) => void; name: string }>();

function nativeSave(bridge: NativePDF, title: string, markdown: string, name: string): Promise<PdfResult> {
  const id = "pdf" + ++seq + "_" + Date.now();
  window.__zpdf = (rid, status, data) => {
    const w = waiting.get(rid);
    if (!w) return;
    waiting.delete(rid);
    if (status === "saved") w.resolve({ kind: "file", id: rid, name: w.name, where: data || "Downloads/zenvqo" });
    else if (status === "dialog") w.resolve({ kind: "dialog", id: rid, name: w.name, where: "" });
    else w.reject(new Error(data || "The PDF couldn't be created."));
  };
  return new Promise<PdfResult>((resolve, reject) => {
    waiting.set(id, { resolve, reject, name });
    bridge.save(id, printableDocument(title, markdown), name);
  });
}

/* ---------------- browsers: print the same layout ---------------- */
function browserPrint(title: string, markdown: string, name: string): Promise<PdfResult> {
  document.getElementById("pdf-print-root")?.remove();
  document.getElementById("pdf-print-style")?.remove();
  const root = document.createElement("div");
  root.id = "pdf-print-root";
  root.innerHTML = bodyHtml(title, markdown);
  const style = document.createElement("style");
  style.id = "pdf-print-style";
  style.textContent = `@media screen { #pdf-print-root { display: none; } }
@media print { body > *:not(#pdf-print-root) { display: none !important; } #pdf-print-root { display: block; } ${PRINT_CSS} }`;
  document.body.appendChild(root);
  document.head.appendChild(style);
  const prev = document.title;
  document.title = name.replace(/\.pdf$/, "");                   // browsers use the title as the suggested file name
  const cleanup = () => { document.title = prev; };
  window.addEventListener("afterprint", cleanup, { once: true });
  window.print();
  setTimeout(cleanup, 60_000);
  return Promise.resolve({ kind: "dialog", id: "print", name, where: "" });
}

export function canSaveFile(): boolean { return !!window.ZenvqoPDF; }

export function makePdf(title: string, markdown: string): Promise<PdfResult> {
  const name = pdfName(title);
  return window.ZenvqoPDF ? nativeSave(window.ZenvqoPDF, title, markdown, name) : browserPrint(title, markdown, name);
}

export function openPdf(id: string) { window.ZenvqoPDF?.open(id); }
export function sharePdf(id: string) { window.ZenvqoPDF?.share(id); }
