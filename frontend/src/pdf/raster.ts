// A real .pdf file made entirely in the page — no print dialog, no native engine.
//
// The same printable document (title, Markdown, typeset math, Hindi) is laid out in a hidden frame at A4 width, page
// breaks are chosen between blocks (never through a line), each page is drawn to a canvas through an SVG
// <foreignObject> and the pages are written as JPEG images into a small PDF. Used for direct downloads in browsers and
// as the fallback when a phone's print engine fails. (Text in these files is an image, so the Android engine stays the
// first choice there: its PDFs have selectable text.)

const A4_W = 794, A4_H = 1123;                 // CSS px at 96 dpi
const MX = 60, MT = 56, MB = 64;               // page margins
const CW = A4_W - 2 * MX;                      // content width
const PH = A4_H - MT - MB;                     // content height per page
const SCALE = 2;                               // 192 dpi pages

function frameFor(html: string): Promise<HTMLIFrameElement> {
  return new Promise((resolve, reject) => {
    const f = document.createElement("iframe");
    f.setAttribute("aria-hidden", "true");
    f.tabIndex = -1;
    f.style.cssText = `position:fixed;left:-10000px;top:0;width:${A4_W}px;height:${A4_H}px;border:0;visibility:hidden;`;
    f.onload = () => resolve(f);
    f.onerror = () => reject(new Error("Couldn't lay out the document."));
    f.srcdoc = html;
    document.body.appendChild(f);
  });
}

/** Where pages may end: below each block and list item, so no line is ever cut in half. */
function breakPoints(doc: Document): number[] {
  const pts = new Set<number>();
  doc.querySelectorAll(".pdf-head, .md > *, .md li, .md tr, .md pre, .pdf-foot, .md .math-display").forEach((el) => {
    const r = el.getBoundingClientRect();
    pts.add(Math.ceil(r.bottom + doc.defaultView!.scrollY));
    pts.add(Math.floor(r.top + doc.defaultView!.scrollY));
  });
  return [...pts].filter((p) => p > 0).sort((a, b) => a - b);
}

/** Where a page must end: after the cover of a book, before each of its chapters (CSS page breaks). */
function forcedBreaks(doc: Document): number[] {
  const win = doc.defaultView!;
  const out = new Set<number>();
  doc.querySelectorAll<HTMLElement>(".pdf-head, .md > *").forEach((el) => {
    const cs = win.getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (cs.breakBefore === "page" || cs.pageBreakBefore === "always") out.add(Math.floor(r.top + win.scrollY));
    if (cs.breakAfter === "page" || cs.pageBreakAfter === "always") out.add(Math.ceil(r.bottom + win.scrollY));
  });
  return [...out].filter((p) => p > 0).sort((a, b) => a - b);
}

export function paginate(height: number, points: number[], pageH = PH, forced: number[] = []): [number, number][] {
  const pages: [number, number][] = [];
  let start = 0;
  while (start < height - 1) {
    const limit = start + pageH;
    const must = forced.find((p) => p > start + 8 && p < Math.min(limit, height - 1));
    if (must !== undefined) { pages.push([start, must]); start = must; continue; }
    if (limit >= height) { pages.push([start, height]); break; }
    let end = 0;
    for (const p of points) if (p > start + pageH * 0.3 && p <= limit) end = p;   // last break that fits
    if (!end) end = limit;                                                        // one block taller than a page
    pages.push([start, end]);
    start = end;
  }
  return pages.length ? pages : [[0, Math.max(1, height)]];
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't draw the document."));
    img.src = src;
  });
}

function dataBytes(dataUrl: string): Uint8Array {
  const b = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}

/** Minimal PDF: one full-page JPEG per page. */
export function jpegPdf(pages: { jpeg: Uint8Array; w: number; h: number }[], title: string): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let size = 0;
  const put = (x: string | Uint8Array) => { const c = typeof x === "string" ? enc.encode(x) : x; chunks.push(c); size += c.length; };
  const obj = (n: number, body: string, stream?: Uint8Array) => {
    offsets[n] = size;
    put(`${n} 0 obj\n${body}\n`);
    if (stream) { put("stream\n"); put(stream); put("\nendstream\n"); }
    put("endobj\n");
  };
  const pdfStr = (s: string) => {   // UTF-16BE hex string, so any title (Hindi too) survives
    let hex = "FEFF";
    for (const ch of s) {
      const cp = ch.codePointAt(0)!;
      const units = cp > 0xffff ? [0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff)] : [cp];
      for (const u of units) hex += u.toString(16).padStart(4, "0").toUpperCase();
    }
    return `<${hex}>`;
  };
  const W = 595.28, H = 841.89;     // A4 in points
  put("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const kids = pages.map((_, i) => `${4 + i * 3} 0 R`).join(" ");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Count ${pages.length} /Kids [${kids}] >>`);
  obj(3, `<< /Title ${pdfStr(title)} /Producer (zenvqo) /CreationDate (D:${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z) >>`);
  pages.forEach((p, i) => {
    const page = 4 + i * 3, content = page + 1, image = page + 2;
    obj(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im${i} ${image} 0 R >> >> /Contents ${content} 0 R >>`);
    const ops = enc.encode(`q ${W} 0 0 ${H} 0 0 cm /Im${i} Do Q`);
    obj(content, `<< /Length ${ops.length} >>`, ops);
    obj(image, `<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>`, p.jpeg);
  });
  const count = 4 + pages.length * 3;
  const xref = size;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) table += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  put(table + `trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** Lay out and draw `html` (a complete printable document) into PDF bytes. */
export async function rasterPdf(html: string, title: string): Promise<Uint8Array> {
  const frame = await frameFor(html);
  try {
    const doc = frame.contentDocument!;
    // screen layout of the print design: content width only, the page margins are added when drawing
    const fix = doc.createElement("style");
    fix.textContent = `html{margin:0!important;padding:0!important}
      body{margin:0!important;padding:0 ${MX}px!important;width:${CW}px;box-sizing:content-box!important}
      html,body{height:auto!important;min-height:0!important;
      max-height:none!important;overflow:visible!important;background:#fff!important}
      .pdf-doc{padding:0!important;margin:0!important}`;
    doc.head.appendChild(fix);
    try { await doc.fonts.ready; } catch { /* older engines */ }
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const article = doc.querySelector(".pdf-doc") || doc.body;
    const height = Math.ceil(Math.max(article.getBoundingClientRect().bottom, doc.body.scrollHeight)) + 4;
    const pages = paginate(height, breakPoints(doc), PH, forcedBreaks(doc));

    const xhtml = new XMLSerializer().serializeToString(doc.documentElement);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${A4_W * SCALE}" height="${height * SCALE}" viewBox="0 0 ${A4_W} ${height}">` +
      `<foreignObject x="0" y="0" width="${A4_W}" height="${height}">${xhtml}</foreignObject></svg>`;
    const img = await loadImage("data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg));

    const out: { jpeg: Uint8Array; w: number; h: number }[] = [];
    const canvas = document.createElement("canvas");
    canvas.width = A4_W * SCALE;
    canvas.height = A4_H * SCALE;
    const ctx = canvas.getContext("2d")!;
    pages.forEach(([a, b], i) => {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const sh = (b - a) * SCALE;
      ctx.drawImage(img, 0, a * SCALE, A4_W * SCALE, sh, 0, MT * SCALE, A4_W * SCALE, sh);
      ctx.fillStyle = "#777";
      ctx.font = `${12 * SCALE}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(`${i + 1} / ${pages.length}`, (A4_W / 2) * SCALE, (A4_H - MB / 2) * SCALE);
      out.push({ jpeg: dataBytes(canvas.toDataURL("image/jpeg", 0.88)), w: canvas.width, h: canvas.height });
    });
    return jpegPdf(out, title);
  } finally {
    frame.remove();
  }
}

export function bytesToBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Hand bytes to the browser as a download. */
export function downloadBytes(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
