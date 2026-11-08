// Reading PDFs in the app (standalone/Android build), so the AI can answer questions about them.
//
// Uses Mozilla's pdf.js (Apache-2.0), legacy build so it also runs on older Android WebViews. Both pdf.js files are
// bundled as text and only started when a PDF is attached (they're ~1.8 MB, so the app doesn't parse them at startup).
// Text PDFs → the text of every page, marked "--- Page N ---" so answers can point to pages.
// Scanned PDFs (pages are pictures, no text layer) → the first pages as images, for models that can read images.
import libSource from "pdfjs-text:lib";
import workerSource from "pdfjs-text:worker";

export interface PdfContent { text: string; pages: number; truncated: boolean; scanned: boolean; images: string[] }

export const MAX_PDF_CHARS = 120_000;
const MAX_IMAGE_PAGES = 8;

type PdfJs = typeof import("pdfjs-dist");
let lib: Promise<PdfJs> | null = null;

function blobUrl(src: string): string {
  return URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
}

function pdfjs(): Promise<PdfJs> {
  if (!lib) {
    lib = (async () => {
      const m = (await import(/* @vite-ignore */ blobUrl(libSource))) as PdfJs;
      m.GlobalWorkerOptions.workerPort = new Worker(blobUrl(workerSource));
      return m;
    })();
    lib.catch(() => { lib = null; });
  }
  return lib;
}

/** Words of a page in reading order, with line breaks where the PDF has them. */
function pageText(items: { str?: string; hasEOL?: boolean }[]): string {
  let out = "";
  for (const it of items) {
    if (typeof it.str !== "string") continue;
    out += it.str;
    out += it.hasEOL ? "\n" : it.str && !/\s$/.test(it.str) ? " " : "";
  }
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

export async function readPdf(bytes: Uint8Array, onProgress?: (f: number) => void): Promise<PdfContent> {
  const m = await pdfjs();
  const task = m.getDocument({ data: bytes, isEvalSupported: false, useSystemFonts: true, stopAtErrors: false });
  let doc;
  try {
    doc = await task.promise;
  } catch (e) {
    void task.destroy();
    const name = (e as Error)?.name || "";
    if (name === "PasswordException") throw new Error("This PDF is password-protected. Remove the password and try again.");
    throw new Error("This PDF couldn't be read. It may be damaged.");
  }
  try {
    const n = doc.numPages;
    let text = "";
    let truncated = false;
    let letters = 0;
    for (let i = 1; i <= n; i++) {
      const page = await doc.getPage(i);
      const t = pageText((await page.getTextContent()).items as { str?: string; hasEOL?: boolean }[]);
      letters += t.replace(/\s/g, "").length;
      const block = `--- Page ${i} ---\n${t || "(no text on this page)"}\n\n`;
      if (text.length + block.length > MAX_PDF_CHARS) { text += block.slice(0, MAX_PDF_CHARS - text.length); truncated = true; break; }
      text += block;
      page.cleanup();
      onProgress?.((i / n) * 0.9);
    }
    // little or no text → it's scanned: send pictures of the first pages instead
    const scanned = letters < 25 * Math.min(n, 3);
    const images: string[] = [];
    if (scanned) {
      for (let i = 1; i <= Math.min(n, MAX_IMAGE_PAGES); i++) {
        const page = await doc.getPage(i);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(2.5, 1600 / Math.max(base.width, base.height)) });
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, canvas, viewport } as Parameters<typeof page.render>[0]).promise;
        images.push(canvas.toDataURL("image/jpeg", 0.85));
        page.cleanup();
        onProgress?.(0.9 + (i / Math.min(n, MAX_IMAGE_PAGES)) * 0.1);
      }
      if (n > MAX_IMAGE_PAGES) truncated = true;
    }
    onProgress?.(1);
    return { text: text.trim(), pages: n, truncated, scanned, images };
  } finally {
    void task.destroy();
  }
}
