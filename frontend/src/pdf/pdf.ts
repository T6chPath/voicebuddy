// PDF files from replies.
//
// The reply is laid out as a clean A4 document (title, date, the rendered Markdown with typeset math, page numbers) and
// printed to PDF by the platform's own engine, so math, tables, code and Hindi look exactly as they do on screen:
//   Android app — window.ZenvqoPDF renders it in an off-screen WebView and writes a real .pdf to Downloads/zenvqo
//                 (Android 10+), with Open and Share; older Android shows the system "Save as PDF" screen.
//   browsers    — the same layout through the browser's print dialog ("Save as PDF").
import { renderMarkdown } from "../lib/markdown";
import { plotImage } from "../plot/mount";

/** graphs (```plot blocks) become pictures in the PDF */
function plotsToImages(html: string): string {
  if (!html.includes("plot-block")) return html;
  const t = document.createElement("template");
  t.innerHTML = html;
  for (const el of t.content.querySelectorAll<HTMLElement>(".plot-block[data-plot]")) {
    let src: string | null = null;
    try { src = plotImage(decodeURIComponent(el.dataset.plot || ""), 640); } catch { src = null; }
    if (!src) continue;
    const fig = document.createElement("figure");
    fig.className = "pdf-plot";
    const img = document.createElement("img");
    img.src = src;
    img.alt = "Graph";
    fig.append(img);
    el.replaceWith(fig);
  }
  return t.innerHTML;
}
import { bytesToBase64, downloadBytes, rasterPdf } from "./raster";

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
.pdf-doc .callout { margin: 10px 0; padding: 8px 12px 2px; border-radius: 8px; border: 1px solid #d3e2fb; background: #eef5ff !important; break-inside: avoid;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.pdf-doc .callout-label { font-weight: 700; margin: 0 0 2px; color: #0060e6; }
.pdf-doc .callout-label::before { display: none; }
.pdf-doc .callout-warn { background: #fdecea !important; border-color: #f3c6c1; } .pdf-doc .callout-warn .callout-label { color: #b42318; }
.pdf-doc .callout-summary { background: #e8f2ff !important; border-color: #bcd5fb; } .pdf-doc .callout-summary .callout-label { color: #0050c8; }
.pdf-doc .callout-note, .pdf-doc .callout-example { background: #f4f6f6 !important; border-color: #dde3e2; } .pdf-doc .callout-note .callout-label, .pdf-doc .callout-example .callout-label { color: #3d5652; }
.pdf-doc .katex-mathml { display: none !important; }   /* screen-reader copy: in a PDF it would only add invisible duplicate text */
.pdf-doc a { color: #1d4ed8; text-decoration: none; }
.pdf-doc img { max-width: 100%; break-inside: avoid; }
.pdf-doc .pdf-plot { margin: 10px 0; text-align: center; break-inside: avoid; }
.pdf-doc .pdf-plot img { width: 100%; max-width: 15cm; border: 1px solid #e5e7eb; border-radius: 6px; }
.pdf-foot { margin-top: 24px; color: #888; font-size: 8.5pt; border-top: 1px solid #eee; padding-top: 6px; }
.pdf-doc .callout-define { background: #fff !important; border: 1.5px solid #8db8f5; } .pdf-doc .callout-define .callout-label { color: #0060e6; }

/* ---- a book: a cover, each chapter on a new page, book type ---- */
.pdf-book { --serif: "Noto Serif", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif; --sans: Poppins, Roboto, system-ui, sans-serif; }
.pdf-book .md { font: 11.4pt/1.64 var(--serif); color: #1a2438; }
.pdf-book .md p { margin: 0 0 3.2mm; }
.pdf-book .md .math-inline .katex { white-space: normal; }
.pdf-book .pdf-cover { break-after: page; page-break-after: always; height: 246mm; display: flex; flex-direction: column; margin: 0; padding: 0; border: 0; }
.pdf-book .cover-art { flex: 0 0 64%; display: flex; flex-direction: column; justify-content: flex-end; padding: 16mm 13mm 14mm; border-radius: 5mm; color: #fff;
  background: radial-gradient(circle at 84% 18%, rgba(255, 255, 255, .22) 0 21mm, transparent 21.3mm),
    radial-gradient(circle at 104% 112%, rgba(255, 255, 255, .13) 0 62mm, transparent 62.3mm), linear-gradient(140deg, #1e8ffe 0%, #0060e6 58%, #0a46b8 100%);
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.pdf-book .cover-kicker { margin: 0 0 5mm; font: 500 10.5pt/1.3 var(--sans); opacity: .9; }
.pdf-book .pdf-cover h1 { margin: 0; font: 700 29pt/1.12 var(--sans); letter-spacing: -.01em; color: #fff; }
.pdf-book .cover-sub { margin: 10mm 3mm 0; font: italic 13pt/1.55 var(--serif); color: #3a4b66; }
.pdf-book .cover-meta { margin: auto 3mm 0; font: 9.5pt/1.4 var(--sans); color: #6b7a93; }
.pdf-book .md h2.contents-head { margin: 0 0 7mm; padding: 0; border: 0; font: 700 20pt/1.2 var(--sans); color: #0b1b33; }
.pdf-book .md h2.contents-head + ol { list-style: none; counter-reset: toc; margin: 0; padding: 0; }
.pdf-book .md h2.contents-head + ol > li { counter-increment: toc; position: relative; margin: 0 0 4.5mm; padding-left: 11mm; color: #3a4b66; }
.pdf-book .md h2.contents-head + ol > li::before { content: counter(toc); position: absolute; left: 0; top: .2mm; width: 7.4mm; height: 7.4mm; border-radius: 2mm;
  background: #e3eeff; color: #0060e6; font: 700 10pt/7.4mm var(--sans); text-align: center; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.pdf-book .md h2.contents-head + ol > li > p { margin: 0; }
.pdf-book .md h2.contents-head + ol > li > strong:first-child,
.pdf-book .md h2.contents-head + ol > li > p:first-child > strong:first-child { font: 600 11.5pt var(--sans); color: #0b1b33; }
.pdf-book .md h2.contents-head + ol ul { list-style: none; margin: 1.6mm 0 0; padding: 0; }
.pdf-book .md h2.contents-head + ol ul li { margin: .7mm 0; font-size: 10.6pt; color: #1a2438; }
.pdf-book .sec-num { display: inline-block; min-width: 9mm; color: #0060e6; font: 600 9.5pt var(--sans); }
.pdf-book .sec-sep { display: none; }
.pdf-book .md h2 { font: 700 15pt/1.3 var(--sans); color: #0b1b33; border-bottom: 0; border-top: 2px solid #0060e6; padding: 3mm 0 0; margin: 9mm 0 3mm; }
.pdf-book .md h2.chapter-head { break-before: page; page-break-before: always; position: relative; z-index: 0; display: block; margin: 0 0 7mm; padding: 6mm 22mm 0 0; border: 0; }
.pdf-book .md h2.chapter-head::before { content: ""; position: absolute; top: 0; left: 0; width: 17mm; height: 1.5mm; border-radius: 1mm;
  background: linear-gradient(90deg, #1e8ffe, #0060e6); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.pdf-book .md h2.chapter-head::after { content: attr(data-chapter); position: absolute; z-index: -1; top: 1mm; right: 0; font: 700 54pt/1 var(--sans); color: #e3eeff; }
.pdf-book .ch-label { display: block; margin-bottom: 1.6mm; font: 600 11pt/1.3 var(--sans); color: #0060e6; }
.pdf-book .ch-sep { display: none; }
.pdf-book .ch-title { display: block; font: 700 23pt/1.18 var(--sans); color: #0b1b33; }
.pdf-book .md h2.chapter-head + p { font-size: 12.3pt; color: #3a4b66; }
.pdf-book .md h2.chapter-head + p::first-letter { float: left; margin: 1mm 1.6mm 0 0; font: 700 31pt/.8 var(--serif); color: #0060e6; }
.pdf-book .md h3 { font: 600 12.5pt/1.3 var(--sans); color: #0060e6; margin: 7mm 0 2.5mm; }
.pdf-book .md h3.topic-head { display: flex; align-items: flex-start; gap: 3mm; margin: 9mm 0 3.5mm; font: 700 14.5pt/1.3 var(--sans); color: #0b1b33; }
.pdf-book .topic-num { flex: none; margin-top: .4mm; padding: 1.3mm 2.2mm; border-radius: 1.8mm; background: #e3eeff; color: #0060e6; font: 700 9.5pt/1 var(--sans);
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.pdf-book .md h4 { font: 700 11.6pt/1.3 var(--sans); color: #0b1b33; margin: 6mm 0 2mm; }
.pdf-book .md .review-head { margin: 9mm 0 3.5mm; padding: 3.2mm 4.5mm; border-radius: 2.5mm; background: #e8f2ff; color: #0050c8; font: 700 13pt/1.3 var(--sans);
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.pdf-book .callout { font-family: var(--serif); }
.pdf-book .callout-label { font-family: var(--sans); }
.pdf-book .callout-example { background: #f5f8ff !important; border: 0; border-left: 1mm solid #0060e6; border-radius: 0 2mm 2mm 0; }
.pdf-book .callout-example .callout-label { color: #0060e6; }
.pdf-book .pdf-foot { font-family: var(--sans); }
.pdf-book .md .practice-head, .pdf-book .md .answers-head { display: flex; align-items: center; gap: 2.4mm; margin: 8mm 0 3mm; padding-top: 4mm; border-top: 1px solid #dce5f5;
  font: 700 13pt/1.3 var(--sans); color: #0b1b33; }
.pdf-book .md .practice-head::before, .pdf-book .md .answers-head::before { content: ""; width: 5.4mm; height: 5.4mm; flex: none; background: #0060e6;
  -webkit-mask: var(--ico) center / contain no-repeat; mask: var(--ico) center / contain no-repeat; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.pdf-book .md .answers-head::before { background: #12704a; }
.pdf-book .md .practice-head { --ico: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z'/%3E%3C/svg%3E"); }
.pdf-book .md .answers-head { --ico: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8z'/%3E%3C/svg%3E"); }
.pdf-book .md .practice-head + ol,
.pdf-book .md .practice-head + ul,
.pdf-book .md .answers-head + ol,
.pdf-book .md .answers-head + ul,
.pdf-book .md .practice-head + p + ol,
.pdf-book .md .practice-head + p + ul,
.pdf-book .md .answers-head + p + ol,
.pdf-book .md .answers-head + p + ul { list-style: none; counter-reset: q; margin: 0 0 4mm; padding: 0; }
.pdf-book .md .practice-head + ol > li,
.pdf-book .md .practice-head + ul > li,
.pdf-book .md .answers-head + ol > li,
.pdf-book .md .answers-head + ul > li,
.pdf-book .md .practice-head + p + ol > li,
.pdf-book .md .practice-head + p + ul > li,
.pdf-book .md .answers-head + p + ol > li,
.pdf-book .md .answers-head + p + ul > li { counter-increment: q; position: relative;
  margin: 0 0 2.4mm; padding: 2.4mm 3.5mm 2.4mm 12mm; border: 1px solid #dce5f5; border-radius: 2.5mm; background: #f5f8ff; break-inside: avoid;
  -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.pdf-book .md .practice-head + ol > li::before,
.pdf-book .md .practice-head + ul > li::before,
.pdf-book .md .answers-head + ol > li::before,
.pdf-book .md .answers-head + ul > li::before,
.pdf-book .md .practice-head + p + ol > li::before,
.pdf-book .md .practice-head + p + ul > li::before,
.pdf-book .md .answers-head + p + ol > li::before,
.pdf-book .md .answers-head + p + ul > li::before { content: counter(q);
  position: absolute; left: 3mm; top: 2.3mm; width: 6.2mm; height: 6.2mm; border-radius: 1.8mm; background: #0060e6; color: #fff; font: 700 9.5pt/6.2mm var(--sans);
  text-align: center; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.pdf-book .md .answers-head + ol > li,
.pdf-book .md .answers-head + ul > li,
.pdf-book .md .answers-head + p + ol > li,
.pdf-book .md .answers-head + p + ul > li { background: #f1faf5; border-color: #cfe9db; }
.pdf-book .md .answers-head + ol > li::before,
.pdf-book .md .answers-head + ul > li::before,
.pdf-book .md .answers-head + p + ol > li::before,
.pdf-book .md .answers-head + p + ul > li::before { background: #12704a; }
.pdf-book .md .practice-head + ol > li > p,
.pdf-book .md .practice-head + ul > li > p,
.pdf-book .md .answers-head + ol > li > p,
.pdf-book .md .answers-head + ul > li > p { margin: 0 0 1.5mm; }
.pdf-book .md .practice-head + ol > li > :last-child,
.pdf-book .md .practice-head + ul > li > :last-child,
.pdf-book .md .answers-head + ol > li > :last-child,
.pdf-book .md .answers-head + ul > li > :last-child { margin-bottom: 0; }
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

/** A "Learn as a book" book: a cover page (title, the line about who it's for, the date), then the book. */
function bookHtml(title: string, markdown: string, date: string): string {
  let md = documentMarkdown(markdown);
  const sub = md.match(/^\s*(?:\*([^*\n]+)\*|_([^_\n]+)_)[ \t]*(?:\n|$)/);
  if (sub) md = md.slice(sub[0].length);
  const subtitle = sub ? (sub[1] || sub[2]).trim() : "";
  return `<article class="pdf-doc pdf-book"><header class="pdf-head pdf-cover"><div class="cover-art"><p class="cover-kicker">A book by zenvqo</p><h1>${esc(title)}</h1></div>` +
    (subtitle ? `<p class="cover-sub">${esc(subtitle)}</p>` : "") + `<p class="cover-meta">${esc(date)}</p></header>` +
    `<div class="md">${plotsToImages(renderMarkdown(md))}</div><footer class="pdf-foot">Made with zenvqo. AI-generated content can be wrong — check important information.</footer></article>`;
}

function bodyHtml(title: string, markdown: string, book = false): string {
  const date = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  if (book) return bookHtml(title, markdown, date);
  return `<article class="pdf-doc"><header class="pdf-head"><h1>${esc(title)}</h1><div class="pdf-meta">${esc(date)} · zenvqo</div></header>` +
    `<div class="md">${plotsToImages(renderMarkdown(documentMarkdown(markdown)))}</div><footer class="pdf-foot">Made with zenvqo. AI-generated content can be wrong — check important information.</footer></article>`;
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
  if (body.includes("pdf-book")) families.add("Poppins");
  const faces = fonts.filter((f) => families.has(f.slice(0, f.indexOf("\u0000")))).map((f) => f.slice(f.indexOf("\u0000") + 1)).join("\n");
  return faces + "\n" + css;
}

/** A complete, self-contained HTML document — only the styles (and math fonts) it uses — what the Android engine prints. */
export function printableDocument(title: string, markdown: string, book = false): string {
  const body = bodyHtml(title, markdown, book);
  // documents of the same shape (same element/class set) share the computed CSS
  const key = Array.from(new Set(body.match(/class="[^"]*"|<[a-z0-9]+/g) || [])).sort().join("|");
  const css = cssCache?.key === key ? cssCache.css : documentCss(body);
  cssCache = { key, css };
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${css}\n${PRINT_CSS}</style></head>` +
    `<body data-theme="light">${body}</body></html>`;
}

/* ---------------- Android bridge ---------------- */
interface NativePDF { save(id: string, html: string, fileName: string): void; saveBytes?(id: string, base64: string, fileName: string): void;
  open(id: string): void; share(id: string): void }
declare global { interface Window { ZenvqoPDF?: NativePDF; __zpdf?: (id: string, status: string, data: string) => void } }

export interface PdfResult { kind: "file" | "dialog" | "download"; id: string; name: string; where: string }
let seq = 0;
const waiting = new Map<string, { resolve: (r: PdfResult) => void; reject: (e: Error) => void; name: string }>();

function viaBridge(name: string, send: (id: string) => void): Promise<PdfResult> {
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
    try { send(id); } catch (e) { waiting.delete(id); reject(e as Error); }
  });
}

async function nativeSave(bridge: NativePDF, title: string, markdown: string, name: string, book = false): Promise<PdfResult> {
  const html = printableDocument(title, markdown, book);
  try {
    return await viaBridge(name, (id) => bridge.save(id, html, name));        // phone's print engine: selectable text
  } catch (e) {
    if (!bridge.saveBytes) throw e;
    console.warn("print engine failed, drawing the PDF in the page instead:", e);
    const bytes = await rasterPdf(await inlineFonts(html), title);              // works on any phone
    return viaBridge(name, (id) => bridge.saveBytes!(id, bytesToBase64(bytes), name));
  }
}

/** Fonts in a document drawn as an image must be inside it: turn linked font files into data: URLs (woff2 only). */
async function inlineFonts(html: string): Promise<string> {
  const faces = html.match(/@font-face\s*\{[^}]*\}/g) || [];
  let out = html;
  for (const face of faces) {
    const woff2 = face.match(/url\((["']?)([^)"']+\.woff2)\1\)/);
    if (!woff2 || woff2[2].startsWith("data:")) continue;
    try {
      const b = new Uint8Array(await (await fetch(woff2[2])).arrayBuffer());
      const src = `src: url("data:font/woff2;base64,${bytesToBase64(b)}") format("woff2")`;
      out = out.replace(face, face.replace(/src\s*:[^;}]*/, src));
    } catch { /* math falls back to a system font */ }
  }
  return out;
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

export function canSaveFile(): boolean { return true; }

/** Browsers: a real .pdf file, downloaded straight away. */
async function browserDownload(title: string, markdown: string, name: string, book = false): Promise<PdfResult> {
  const html = await inlineFonts(printableDocument(title, markdown, book));
  downloadBytes(await rasterPdf(html, title), name);
  return { kind: "download", id: "download", name, where: "your Downloads" };
}

/** `book`: a "Learn as a book" book — a cover page, each chapter on a new page, book type. */
export function makePdf(title: string, markdown: string, opts: { book?: boolean } = {}): Promise<PdfResult> {
  const name = pdfName(title);
  return window.ZenvqoPDF ? nativeSave(window.ZenvqoPDF, title, markdown, name, opts.book) : browserDownload(title, markdown, name, opts.book);
}

/** Browsers: the print window's "Save as PDF" (sharper, selectable text). */
export function printPdf(title: string, markdown: string): Promise<PdfResult> {
  return browserPrint(title, markdown, pdfName(title));
}

export function openPdf(id: string) { window.ZenvqoPDF?.open(id); }
export function sharePdf(id: string) { window.ZenvqoPDF?.share(id); }
