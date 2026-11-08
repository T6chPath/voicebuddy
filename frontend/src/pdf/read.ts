// Reading PDFs in the app (standalone/Android build), so the AI can answer questions about them.
//
// Uses Mozilla's pdf.js (Apache-2.0), legacy build, lowered for older Android WebViews. Both pdf.js files are bundled
// as text and only started when a PDF is attached (they're big, so the app doesn't parse them at startup).
//
// What gets sent to the AI:
//   • the text of every page, marked "--- Page N ---", with form-field answers;
//   • a picture of every page whose text can't be used — scanned pages, and pages in old non-Unicode fonts (e.g.
//     Kruti Dev Hindi, whose text layer is Latin gibberish) — so a model that can see images reads them.
// Also handled: password-protected PDFs (asks for the password), damaged files (pdf.js rebuilds them), Chinese/
// Japanese/Korean fonts (Adobe CMaps), JPEG 2000 and JBIG2 scans (decoders), CMYK images, XFA forms. The data files
// for those ship in the Android app (assets/pdfjs/, read through window.ZenvqoAssets).
import libSource from "pdfjs-text:lib";
import workerSource from "pdfjs-text:worker";
import { looksGarbled, pageText, type Item } from "./text";

export interface PdfContent { text: string; pages: number; truncated: boolean; scanned: boolean; images: string[] }

export const MAX_PDF_CHARS = 200_000;
const MAX_PICTURES = 20;                 // pages sent as pictures (scans), per PDF
const PICTURE_SIDE = 1400;               // px, long side: enough to read printed text

type PdfJs = typeof import("pdfjs-dist");
type Doc = Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>;
let lib: Promise<PdfJs> | null = null;

declare global { interface Window { ZenvqoAssets?: { read(path: string): string | null } } }

function blobUrl(src: string): string {
  return URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
}

// pdf.js's JPEG 2000 / JBIG2 decoders are WebAssembly using SIMD (Chrome 91+) and relaxed SIMD (Chrome 114+). Where
// that's missing, the plain-JS decoders are handed to the worker too, and pdf.js switches to them by itself.
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
const RELAXED_SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1, 13, 0, 65, 1, 253, 15, 65, 2,
  253, 15, 253, 128, 2, 11]);
function validates(bytes: BufferSource): boolean {
  try { return typeof WebAssembly === "object" && WebAssembly.validate(bytes); } catch { return false; }
}
const forceJs = !!(window as { __zvqNoWasm?: boolean }).__zvqNoWasm;              // tests: force the plain-JS path
const useWasm = !forceJs && validates(SIMD_PROBE);
const needJsDecoders = forceJs || !validates(SIMD_PROBE) || !validates(RELAXED_SIMD_PROBE);

async function fallbackDecoders(): Promise<string> {
  const out: Record<string, string> = {};
  for (const f of ["openjpeg_nowasm_fallback.iife.js", "jbig2_nowasm_fallback.iife.js"]) {
    try { out[f] = new TextDecoder().decode(await asset("pdfjs/wasm/" + f)); } catch { /* that kind of scan can't be decoded */ }
  }
  return `self.__zvqFallbackSrc = ${JSON.stringify(out)};\n`;
}

function pdfjs(): Promise<PdfJs> {
  if (!lib) {
    lib = (async () => {
      const m = (await import(/* @vite-ignore */ blobUrl(libSource))) as PdfJs;
      m.GlobalWorkerOptions.workerPort = new Worker(blobUrl((needJsDecoders ? await fallbackDecoders() : "") + workerSource));
      return m;
    })();
    lib.catch(() => { lib = null; });
  }
  return lib;
}

/* ---------- pdf.js data files: from the Android app's assets, or next to the page when served over http ---------- */
function b64bytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function asset(path: string): Promise<Uint8Array> {
  const b64 = window.ZenvqoAssets?.read(path);
  if (b64) return b64bytes(b64);
  if (location.protocol === "http:" || location.protocol === "https:") {
    const r = await fetch(new URL(path, location.href).href);
    if (r.ok) return new Uint8Array(await r.arrayBuffer());
  }
  throw new Error("not available: " + path);
}

const DIRS: Record<string, string> = { cMapUrl: "pdfjs/cmaps/", standardFontDataUrl: "pdfjs/standard_fonts/", wasmUrl: "pdfjs/wasm/" };

/** Given to pdf.js as BinaryDataFactory: it asks for "cMapUrl"/"standardFontDataUrl"/"wasmUrl" + file name. */
class AppDataFactory {
  constructor(_urls: unknown) { /* base URLs are placeholders; files come from asset() */ }
  async fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
    const dir = DIRS[kind];
    if (!dir) throw new Error("unknown pdf.js data kind " + kind);
    return asset(dir + filename);
  }
}

let iccUrl: string | null | undefined;
/** CMYK colour profile: pdf.js reads it synchronously in the worker, so it's given as a data: URL ("…#/" + name). */
async function cmykProfile(): Promise<string | null> {
  if (iccUrl !== undefined) return iccUrl;
  try {
    const b = await asset("pdfjs/iccs/CGATS001Compat-v2-micro.icc");
    let s = "";
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    iccUrl = `data:application/octet-stream;base64,${btoa(s)}#/`;
  } catch {
    iccUrl = null;
  }
  return iccUrl;
}

/* ---------- password ---------- */
/** A small dialog asking for the PDF's password; resolves null when cancelled. */
export function askPassword(name: string, wrong: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const back = document.createElement("div");
    back.className = "pw-backdrop";
    back.innerHTML = `<form class="pw-dialog" role="dialog" aria-modal="true" aria-labelledby="pw-title">
      <h2 id="pw-title">This PDF is locked</h2>
      <p class="muted"></p>
      <label class="field"><span>Password</span><input type="password" autocomplete="off" required /></label>
      <p class="pw-error" role="alert"></p>
      <div class="pw-actions"><button type="button" class="btn">Cancel</button><button type="submit" class="btn primary">Open PDF</button></div>
    </form>`;
    back.querySelector("p.muted")!.textContent = `Enter the password for “${name}” so the AI can read it. It's used only on this phone and isn't saved.`;
    if (wrong) back.querySelector(".pw-error")!.textContent = "That password is wrong. Try again.";
    const input = back.querySelector("input")!;
    const done = (v: string | null) => { back.remove(); resolve(v); };
    back.querySelector("form")!.addEventListener("submit", (e) => { e.preventDefault(); done(input.value); });
    back.querySelector("button[type=button]")!.addEventListener("click", () => done(null));
    back.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Escape") done(null); });
    document.body.appendChild(back);
    input.focus();
  });
}

async function formFields(page: Awaited<ReturnType<Doc["getPage"]>>): Promise<string> {
  try {
    const anns = (await page.getAnnotations()) as { subtype?: string; fieldName?: string; fieldValue?: unknown; alternativeText?: string }[];
    const lines = anns.filter((a) => a.subtype === "Widget" && a.fieldValue !== undefined && a.fieldValue !== null && String(a.fieldValue).trim() &&
      String(a.fieldValue) !== "Off").map((a) => `${a.alternativeText || a.fieldName || "field"}: ${Array.isArray(a.fieldValue) ? a.fieldValue.join(", ") : String(a.fieldValue)}`);
    return lines.length ? `\n[Form fields filled in]\n${lines.join("\n")}` : "";
  } catch {
    return "";
  }
}

async function picture(page: Awaited<ReturnType<Doc["getPage"]>>): Promise<string> {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(3, PICTURE_SIDE / Math.max(base.width, base.height)) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport } as Parameters<typeof page.render>[0]).promise;
  const url = canvas.toDataURL("image/jpeg", 0.8);
  canvas.width = canvas.height = 0;                                 // free the memory right away on phones
  return url;
}

function pageList(n: number[]): string {
  return n.length > 12 ? `${n.slice(0, 12).join(", ")} and ${n.length - 12} more` : n.join(", ");
}

export async function readPdf(bytes: Uint8Array, name = "this PDF", onProgress?: (f: number) => void): Promise<PdfContent> {
  const m = await pdfjs();
  const task = m.getDocument({
    data: bytes, useSystemFonts: true, stopAtErrors: false, enableXfa: true, isOffscreenCanvasSupported: false, useWasm,
    useWorkerFetch: false, BinaryDataFactory: AppDataFactory,
    cMapUrl: "app:cmaps/", cMapPacked: true, standardFontDataUrl: "app:fonts/", wasmUrl: "app:wasm/",
    ...((await cmykProfile()) ? { iccUrl: iccUrl! } : {}),
  } as Parameters<PdfJs["getDocument"]>[0]);
  let cancelled = false;
  task.onPassword = (update: (pw: string) => void, reason: number) => {
    void askPassword(name, reason === m.PasswordResponses.INCORRECT_PASSWORD).then((pw) => {
      if (pw === null) { cancelled = true; void task.destroy(); } else update(pw);
    });
  };
  let doc: Doc;
  try {
    doc = await task.promise;
  } catch (e) {
    void task.destroy();
    if (cancelled) throw new Error("This PDF is locked with a password. Attach it again and enter the password to read it.");
    if ((e as Error)?.name === "PasswordException") throw new Error("This PDF is locked with a password.");
    throw new Error("This PDF couldn't be read. It may be damaged or not really a PDF.");
  }
  try {
    const n = doc.numPages;
    const blocks: string[] = [];
    const needPicture: number[] = [];
    let garbledPages = 0;
    let total = 0;
    let truncated = false;
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      let t = "";
      try { t = pageText((await page.getTextContent()).items as Item[]); } catch { t = ""; }
      const garbled = looksGarbled(t);
      if (garbled) garbledPages++;
      if (garbled || t.replace(/\s/g, "").length < 20) needPicture.push(i);
      const body = garbled ? "(The text on this page couldn't be decoded — it uses an old non-Unicode font. A picture of the page is attached.)"
        : t || "(no text on this page — it is a picture or scan)";
      const block = `--- Page ${i} ---\n${body}${await formFields(page)}\n\n`;
      page.cleanup();
      onProgress?.((i / n) * 0.8);
      if (truncated) continue;
      if (total + block.length > MAX_PDF_CHARS) { blocks.push(block.slice(0, Math.max(0, MAX_PDF_CHARS - total))); truncated = true; continue; }
      blocks.push(block);
      total += block.length;
    }
    const images: string[] = [];
    const pictured: number[] = [];
    for (const i of needPicture.slice(0, MAX_PICTURES)) {
      try {
        const page = await doc.getPage(i);
        images.push(await picture(page));
        pictured.push(i);
        page.cleanup();
      } catch { /* a page that can't be drawn is skipped */ }
      onProgress?.(0.8 + (pictured.length / Math.min(needPicture.length, MAX_PICTURES)) * 0.2);
    }
    const scanned = needPicture.length === n;
    let head = `(PDF, ${n} page${n === 1 ? "" : "s"}.`;
    if (scanned) head += (garbledPages ? " Its text can't be decoded (old non-Unicode font), so pictures of the pages" : " It is scanned: pictures of the pages") +
      (pictured.length < n ? ` — the first ${pictured.length} — are attached.` : " are attached.");
    else if (pictured.length) head += ` Page${pictured.length > 1 ? "s" : ""} ${pageList(pictured)} ${pictured.length > 1 ? "are" : "is"} attached as picture${pictured.length > 1 ? "s" : ""} (scanned or unreadable text).`;
    if (needPicture.length > pictured.length) { head += ` Pictures of pages ${pageList(needPicture.slice(pictured.length))} were not included (limit ${MAX_PICTURES}).`; truncated = true; }
    if (truncated && total >= MAX_PDF_CHARS) head += " The text is cut off after about 200,000 characters.";
    head += ")\n\n";
    onProgress?.(1);
    return { text: (head + blocks.join("")).trim(), pages: n, truncated, scanned, images };
  } finally {
    void task.destroy();
  }
}
