/** Text (and pictures) out of documents, on the phone: Word, Excel, PowerPoint, OpenDocument, EPUB, RTF, HTML,
 * old binary Office files, archives and anything else. Plain string/regex parsing so it runs anywhere (and is tested in
 * Node). Every reader returns readable Markdown-ish text: headings, lists, tables as rows. */
import { isZip, Zip } from "./zip";

export interface DocResult { text: string; images: { name: string; bytes: Uint8Array; mime: string }[]; format: string }

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? m);
}
const tidy = (s: string) => s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const IMG_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };

async function media(z: Zip, re: RegExp, max = 6) {
  const out: DocResult["images"] = [];
  for (const e of z.find(re).sort((a, b) => b.size - a.size)) {                // the biggest pictures first
    const ext = e.name.split(".").pop()!.toLowerCase();
    if (!IMG_MIME[ext] || e.size < 2048) continue;                               // skip icons and bullets
    const bytes = await z.bytes(e);
    if (bytes) out.push({ name: e.name.split("/").pop()!, bytes, mime: IMG_MIME[ext] });
    if (out.length >= max) break;
  }
  return out;
}

/* ---------------- Word (.docx) ---------------- */
function docxBody(xml: string): string {
  const body = xml.replace(/<w:(?:del|instrText|delText)\b[\s\S]*?<\/w:(?:del|instrText|delText)>/g, "");
  const para = (p: string) => {
    const t = [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(tab|br|cr)\/?>/g)].map((m) => (m[2] ? (m[2] === "tab" ? "\t" : "\n") : decodeEntities(m[1]))).join("");
    const style = p.match(/<w:pStyle w:val="([^"]+)"/)?.[1] || "";
    const h = style.match(/^(?:Heading|heading|Titre|berschrift)\s*(\d)/)?.[1] || (/^Title$/i.test(style) ? "1" : "");
    if (!t.trim()) return "";
    if (h) return "#".repeat(Math.min(6, +h)) + " " + t.trim();
    if (/<w:numPr>/.test(p) || /List/i.test(style)) return "- " + t.trim();
    return t;
  };
  const out: string[] = [];
  // tables become rows of cells; everything else paragraph by paragraph, in order
  const re = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>/g;
  for (const m of body.matchAll(re)) {
    const seg = m[0];
    if (seg.startsWith("<w:tbl>")) {
      const rows = [...seg.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((r) =>
        [...r[0].matchAll(/<w:tc[ >][\s\S]*?<\/w:tc>/g)].map((c) => [...c[0].matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((p) => para(p[0])).join(" ").replace(/\|/g, "/").trim()));
      out.push(table(rows));
    } else out.push(para(seg));
  }
  return tidy(out.filter((x) => x !== "").join("\n\n"));
}

function table(rows: string[][]): string {
  const w = Math.max(0, ...rows.map((r) => r.length));
  if (!w) return "";
  const line = (r: string[]) => "| " + Array.from({ length: w }, (_, i) => (r[i] ?? "").replace(/\n/g, " ")).join(" | ") + " |";
  return [line(rows[0]), "|" + " --- |".repeat(w), ...rows.slice(1).map(line)].join("\n");
}

async function docx(z: Zip): Promise<DocResult> {
  const main = (await z.text("word/document.xml")) || "";
  const parts = [docxBody(main)];
  for (const e of z.find(/^word\/(footnotes|endnotes)\.xml$/)) { const t = docxBody((await z.text(e)) || ""); if (t) parts.push("Notes:\n" + t); }
  return { text: tidy(parts.join("\n\n")), images: await media(z, /^word\/media\//), format: "Word document" };
}

/* ---------------- Excel (.xlsx) ---------------- */
function colIndex(ref: string) { let n = 0; for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; }

async function xlsx(z: Zip): Promise<DocResult> {
  const shared = [...((await z.text("xl/sharedStrings.xml")) || "").matchAll(/<si>([\s\S]*?)<\/si>/g)]
    .map((m) => [...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => decodeEntities(t[1])).join(""));
  const wb = (await z.text("xl/workbook.xml")) || "";
  const rels = (await z.text("xl/_rels/workbook.xml.rels")) || "";
  const target = (rid: string) => rels.match(new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"|Target="([^"]+)"[^>]*Id="${rid}"`))?.slice(1).find(Boolean);
  const sheets = [...wb.matchAll(/<sheet\b[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"/g)].map((m) => ({ name: decodeEntities(m[1]), file: target(m[2]) }));
  const out: string[] = [];
  let total = 0;
  for (const [i, sh] of sheets.entries()) {
    const path = sh.file ? (sh.file.startsWith("/") ? sh.file.slice(1) : "xl/" + sh.file.replace(/^\.\.\//, "")) : `xl/worksheets/sheet${i + 1}.xml`;
    const xml = (await z.text(path)) || "";
    const rows: string[][] = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1], inner = c[2] || "";
        const ref = attrs.match(/r="([A-Z]+\d+)"/)?.[1];
        const t = attrs.match(/t="(\w+)"/)?.[1];
        const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let val = "";
        if (t === "s" && v != null) val = shared[+v] ?? "";
        else if (t === "inlineStr") val = [...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((x) => decodeEntities(x[1])).join("");
        else if (t === "b" && v != null) val = v === "1" ? "TRUE" : "FALSE";
        else if (v != null) val = decodeEntities(v);
        const f = inner.match(/<f>([\s\S]*?)<\/f>/)?.[1];
        if (f && !val) val = "=" + decodeEntities(f);
        const at = ref ? colIndex(ref) : cells.length;
        while (cells.length < at) cells.push("");
        cells[at] = val.replace(/\|/g, "/");
      }
      if (cells.some((x) => x !== "")) rows.push(cells);
      if (rows.length >= 3000 || (total += cells.join("").length) > 400_000) break;
    }
    out.push(`## Sheet: ${sh.name} (${rows.length} rows)\n\n${rows.length ? table(rows) : "(empty)"}`);
  }
  return { text: tidy(out.join("\n\n")), images: await media(z, /^xl\/media\//, 3), format: "Excel spreadsheet" };
}

/* ---------------- PowerPoint (.pptx) ---------------- */
async function pptx(z: Zip): Promise<DocResult> {
  const num = (n: string) => +(n.match(/(\d+)\.xml$/)?.[1] || 0);
  const slides = z.find(/^ppt\/slides\/slide\d+\.xml$/).sort((a, b) => num(a.name) - num(b.name));
  const out: string[] = [];
  for (const s of slides) {
    const xml = (await z.text(s)) || "";
    const paras = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((p) => [...p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => decodeEntities(t[1])).join("")).filter((t) => t.trim());
    const notes = await z.text(`ppt/notesSlides/notesSlide${num(s.name)}.xml`);
    const nt = notes ? [...notes.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => decodeEntities(t[1])).join(" ").trim() : "";
    out.push(`## Slide ${num(s.name)}${paras[0] ? ": " + paras[0] : ""}\n\n${paras.slice(1).map((p) => "- " + p).join("\n")}${nt && !/^\d+$/.test(nt) ? `\n\nSpeaker notes: ${nt}` : ""}`);
  }
  return { text: tidy(out.join("\n\n")), images: await media(z, /^ppt\/media\//), format: "PowerPoint presentation" };
}

/* ---------------- OpenDocument (.odt .ods .odp) ---------------- */
async function odf(z: Zip, kind: string): Promise<DocResult> {
  const xml = (await z.text("content.xml")) || "";
  const text = (s: string) => decodeEntities(s.replace(/<text:(tab)\/>/g, "\t").replace(/<text:line-break\/>/g, "\n").replace(/<text:s(?: text:c="(\d+)")?\/>/g, (_m, n) => " ".repeat(+n || 1)).replace(/<[^>]+>/g, ""));
  const out: string[] = [];
  for (const m of xml.matchAll(/<table:table\b[^>]*table:name="([^"]*)"[^>]*>[\s\S]*?<\/table:table>|<text:h\b[^>]*?(?:text:outline-level="(\d)")?[^>]*>[\s\S]*?<\/text:h>|<text:p\b[^>]*>[\s\S]*?<\/text:p>|<text:p\b[^>]*\/>/g)) {
    const seg = m[0];
    if (seg.startsWith("<table:table")) {
      const rows = [...seg.matchAll(/<table:table-row\b[^>]*>([\s\S]*?)<\/table:table-row>/g)].map((r) =>
        [...r[1].matchAll(/<table:table-cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/table:table-cell>)/g)].flatMap((c) => {
          const rep = Math.min(50, +(c[1].match(/number-columns-repeated="(\d+)"/)?.[1] || 1));
          return Array(rep).fill(text(c[2] || "").trim().replace(/\|/g, "/"));
        })).filter((r) => r.some(Boolean)).map((r) => { while (r.length && !r[r.length - 1]) r.pop(); return r; });
      if (rows.length) out.push((m[1] ? `## ${decodeEntities(m[1])}\n\n` : "") + table(rows));
    } else if (seg.startsWith("<text:h")) out.push("#".repeat(+(m[2] || 2)) + " " + text(seg).trim());
    else { const t = text(seg); if (t.trim()) out.push(t); }
  }
  return { text: tidy(out.join("\n\n")), images: await media(z, /^Pictures\//), format: kind };
}

/* ---------------- EPUB ---------------- */
async function epub(z: Zip): Promise<DocResult> {
  const container = (await z.text("META-INF/container.xml")) || "";
  const opfPath = container.match(/full-path="([^"]+)"/)?.[1] || z.find(/\.opf$/)[0]?.name || "";
  const opf = (await z.text(opfPath)) || "";
  const dir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const manifest = new Map([...opf.matchAll(/<item\b[^>]*>/g)].map((m) => [m[0].match(/id="([^"]+)"/)?.[1] || "", m[0].match(/href="([^"]+)"/)?.[1] || ""]));
  const order = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => manifest.get(m[1])).filter(Boolean) as string[];
  const title = decodeEntities(opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/)?.[1] || "");
  const out: string[] = title ? [`# ${title}`] : [];
  let total = 0;
  for (const href of order) {
    const h = (await z.text(dir + decodeURIComponent(href))) || "";
    const t = htmlToText(h);
    out.push(t);
    if ((total += t.length) > 400_000) break;
  }
  return { text: tidy(out.join("\n\n")), images: [], format: "e-book (EPUB)" };
}

/* ---------------- HTML, RTF, old Office, anything ---------------- */
export function htmlToText(html: string): string {
  let s = html.replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n, t) => `\n\n${"#".repeat(+n)} ${t.replace(/<[^>]+>/g, "").trim()}\n\n`);
  s = s.replace(/<li\b[^>]*>/gi, "\n- ").replace(/<(br|hr)\b[^>]*>/gi, "\n").replace(/<\/(p|div|section|article|tr|table|ul|ol|blockquote|pre|h\d)>/gi, "\n\n");
  s = s.replace(/<\/t[dh]>/gi, " | ").replace(/<img\b[^>]*alt="([^"]+)"[^>]*>/gi, "[image: $1]").replace(/<a\b[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "$2 ($1)");
  s = decodeEntities(s.replace(/<[^>]+>/g, ""));
  return tidy(s.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n"));
}

export function rtfToText(rtf: string): string {
  let s = rtf.replace(/\{\\\*[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, "")                     // destinations ({\*\...})
    .replace(/\{\\(fonttbl|colortbl|stylesheet|info|pict)[\s\S]*?\}\s*\}/g, "");
  s = s.replace(/\\'([0-9a-f]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u(-?\d+)\??/g, (_m, n) => String.fromCharCode((+n + 65536) % 65536))
    .replace(/\\(par|line)\b ?/g, "\n").replace(/\\tab\b ?/g, "\t").replace(/\\[a-z]+-?\d* ?/gi, "").replace(/\\([{}\\])/g, "$1").replace(/[{}]/g, "");
  return tidy(s);
}

/** Old binary Word/Excel/PowerPoint and other files: the runs of readable text inside (like the `strings` tool). */
export function textRuns(b: Uint8Array, min = 5): string {
  const runs: string[] = [];
  let cur = "";
  const flush = () => { if (cur.trim().length >= min) runs.push(cur.trim()); cur = ""; };
  // UTF-16LE (Word 97–2003 stores text this way)
  for (let i = 0; i + 1 < b.length; i += 2) {
    const c = b[i] | (b[i + 1] << 8);
    if ((c >= 32 && c < 0xd800 && c !== 0xfffd) || c === 9) cur += String.fromCharCode(c);
    else if (c === 13 || c === 10) { cur += "\n"; }
    else flush();
  }
  flush();
  const u16 = runs.join("\n");
  runs.length = 0;
  for (let i = 0; i < b.length; i++) {                                          // and plain 8-bit text
    const c = b[i];
    if ((c >= 32 && c < 127) || c === 9) cur += String.fromCharCode(c);
    else if (c === 10 || c === 13) cur += "\n";
    else flush();
  }
  flush();
  const ascii = runs.join("\n");
  const letters = (t: string) => (t.match(/[\p{L}]/gu) || []).length;
  return tidy(letters(u16) > letters(ascii) * 0.6 ? u16 : ascii);
}

/** Is this mostly readable text? (then it's read as text whatever its extension) */
export function looksLikeText(b: Uint8Array): boolean {
  const n = Math.min(b.length, 8192);
  if (!n) return true;
  let bad = 0;
  for (let i = 0; i < n; i++) { const c = b[i]; if (c === 0) return false; if (c < 9 || (c > 13 && c < 32)) bad++; }
  if (bad / n > 0.02) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(0, n - 4)); return true; } catch { return bad === 0; }
}

/* ---------------- dispatcher ---------------- */
const TEXT_TYPES = /\.(txt|md|markdown|csv|tsv|json|jsonl|ndjson|xml|yaml|yml|toml|ini|cfg|conf|env|log|sql|py|js|mjs|cjs|ts|tsx|jsx|java|kt|kts|c|h|cpp|hpp|cc|cs|go|rs|rb|php|swift|dart|scala|sh|bash|zsh|ps1|bat|r|m|lua|pl|vue|svelte|css|scss|less|tex|bib|srt|vtt|gradle|properties|gitignore|dockerfile|makefile)$/i;

/** Text and pictures from any document. null = not a document this reader knows (the caller decides). */
export async function readDocument(name: string, b: Uint8Array): Promise<DocResult | null> {
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
  if (isZip(b)) {
    const z = new Zip(b);
    if (z.has("word/document.xml")) return docx(z);
    if (z.has("xl/workbook.xml")) return xlsx(z);
    if (z.has("ppt/presentation.xml")) return pptx(z);
    if (z.has("content.xml") && z.has("mimetype")) {
      const mt = ((await z.text("mimetype")) || "").trim();
      return odf(z, /spreadsheet/.test(mt) ? "OpenDocument spreadsheet" : /presentation/.test(mt) ? "OpenDocument presentation" : "OpenDocument text");
    }
    if (z.has("META-INF/container.xml") && /epub/.test((await z.text("mimetype")) || "epub")) return epub(z);
    return archive(z, ext === "apk" ? "Android app (APK)" : ext === "jar" ? "Java archive" : "ZIP archive");
  }
  if (/^(html?|xhtml|mht)$/.test(ext)) return { text: htmlToText(new TextDecoder().decode(b)), images: [], format: "web page" };
  if (ext === "rtf" || (b[0] === 0x7b && new TextDecoder().decode(b.subarray(0, 6)) === "{\\rtf1")) return { text: rtfToText(new TextDecoder("latin1").decode(b)), images: [], format: "RTF document" };
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) {                // old Office (OLE2): .doc .xls .ppt .msg
    const kind = ext === "xls" ? "Excel 97–2003 spreadsheet" : ext === "ppt" ? "PowerPoint 97–2003 presentation" : ext === "msg" ? "Outlook message" : "Word 97–2003 document";
    return { text: textRuns(b), images: [], format: kind };
  }
  if (TEXT_TYPES.test(name) || looksLikeText(b)) return { text: new TextDecoder("utf-8").decode(b), images: [], format: "text" };
  return null;
}

/** What's inside an archive, plus the text of its text files and its pictures. */
async function archive(z: Zip, format: string): Promise<DocResult> {
  const lines = [`Files in this ${format} (${z.entries.length}):`, ...z.entries.slice(0, 300).map((e) => `- ${e.name} (${fmt(e.size)})`)];
  if (z.entries.length > 300) lines.push(`- … and ${z.entries.length - 300} more`);
  let budget = 200_000;
  for (const e of z.entries) {
    if (budget <= 0 || e.size > 400_000 || e.size === 0) continue;
    if (!TEXT_TYPES.test(e.name) && !/(^|\/)(readme|license|changelog)[^/]*$/i.test(e.name) && !/\.(html?|rtf)$/i.test(e.name)) continue;
    const bytes = await z.bytes(e);
    if (!bytes || !looksLikeText(bytes)) continue;
    const t = /\.html?$/i.test(e.name) ? htmlToText(new TextDecoder().decode(bytes)) : new TextDecoder().decode(bytes);
    lines.push(`\n--- ${e.name} ---\n${t.slice(0, budget)}`);
    budget -= t.length;
  }
  return { text: lines.join("\n"), images: await media(z, /\.(png|jpe?g|gif|webp)$/i, 4), format };
}

function fmt(n: number) { return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`; }
