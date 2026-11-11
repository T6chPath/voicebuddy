/** Projects in answers: the files of a multi-file answer, as a .zip, and web projects as one page (for "Make app"). */

export interface ProjectFile { path: string; content: string; lang: string }

const PATH = /^[\w@.-]+(?:\/[\w@.-]+)*\.[\w-]+$|^(?:[\w@.-]+\/)*(?:Dockerfile|Makefile|Procfile|LICENSE|\.env(?:\.\w+)?|\.gitignore)$/;

function cleanPath(p: string): string | null {
  const t = p.trim().replace(/^[`*_"'(\[]+|[`*_"'):\]]+$/g, "").replace(/^\.\//, "").trim();
  if (!t || t.length > 160 || t.includes("..") || t.startsWith("/") || !PATH.test(t)) return null;
  return t;
}

/** The files of an answer: every fenced code block that names its file — in the fence (```js src/app.js, ```python title="main.py"),
 * on the line just before it (**`src/app.js`**, ### src/app.js, File: src/app.js), or in a first-line comment (// file: src/app.js). */
export function extractFiles(md: string): ProjectFile[] {
  const lines = md.split("\n");
  const files: ProjectFile[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(/^(\s*)(`{3,}|~{3,})\s*([^\s`]*)\s*(.*)$/);
    if (!open) continue;
    const fence = open[2];
    const lang = open[3].toLowerCase();
    const info = open[4];
    let end = i + 1;
    while (end < lines.length && !lines[end].trimStart().startsWith(fence)) end++;
    const body = lines.slice(i + 1, end);
    let path: string | null = null;
    const titled = info.match(/(?:title|file|filename|path)\s*=\s*["']?([^"'\s]+)/i);
    if (titled) path = cleanPath(titled[1]);
    if (!path && info) path = cleanPath(info.split(/\s+/)[0]);
    if (!path && lang.includes(".") && !lang.startsWith(".")) path = cleanPath(lang);          // ```src/app.js
    if (!path) {
      let k = i - 1;
      while (k >= 0 && !lines[k].trim()) k--;
      if (k >= 0) {
        const prev = lines[k].trim().replace(/^#+\s*|^[-*]\s+|^\d+\.\s+/, "").replace(/^(?:file(?:name)?|path)\s*:\s*/i, "");
        const m = prev.match(/^[`*_"']*([^`*_"'\s]+)[`*_"']*:?\s*(?:\(.*\))?$/);
        if (m) path = cleanPath(m[1]);
      }
    }
    if (!path && body.length) {
      const c = body[0].match(/^\s*(?:\/\/|#|<!--|\/\*|--)\s*(?:file(?:name)?|path)?\s*:?\s*([\w@./-]+\.[\w-]+)\s*(?:-->|\*\/)?\s*$/i);
      if (c) path = cleanPath(c[1]);
    }
    if (path && lang !== "plot" && lang !== "graph") {
      const existing = files.findIndex((f) => f.path === path);
      const file = { path, content: body.join("\n") + "\n", lang };
      if (existing >= 0) files[existing] = file; else files.push(file);       // a later version of the same file wins
    }
    i = end;
  }
  return files;
}

/** A name for the project folder: the shared top folder, else a slug of the answer's first heading, else "project". */
export function projectName(md: string, files: ProjectFile[]): string {
  const tops = new Set(files.map((f) => (f.path.includes("/") ? f.path.split("/")[0] : "")));
  if (tops.size === 1 && [...tops][0]) return [...tops][0];
  const h = md.match(/^#{1,3}\s+(.+)$/m)?.[1] || "";
  const slug = h.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return slug || "project";
}

/* ---------------- zip (stored, no compression: small and simple) ---------------- */
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(b: Uint8Array): number { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export function zip(files: { path: string; content: string }[], folder = ""): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const date = ((new Date().getFullYear() - 1980) << 9) | ((new Date().getMonth() + 1) << 5) | new Date().getDate();
  for (const f of files) {
    const name = enc.encode((folder && !f.path.startsWith(folder + "/") ? folder + "/" : "") + f.path);
    const data = enc.encode(f.content);
    const crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, 0, true); h.setUint16(12, date, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true);
    h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, 0, true); c.setUint16(14, date, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
    parts.push(new Uint8Array(h.buffer), name, data);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(e.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) { out.set(p, at); at += p.length; }
  return out;
}

/* ---------------- web projects → one page ---------------- */
/** index.html with its local stylesheets and scripts put inline, so the whole web project fits in one app page. */
export function webAppPage(files: ProjectFile[]): string | null {
  const index = files.find((f) => /(^|\/)index\.html?$/i.test(f.path)) || files.find((f) => /\.html?$/i.test(f.path));
  if (!index) return null;
  const dir = index.path.includes("/") ? index.path.slice(0, index.path.lastIndexOf("/") + 1) : "";
  const find = (ref: string) => {
    if (/^(https?:)?\/\//i.test(ref) || ref.startsWith("data:")) return null;
    const p = (dir + ref.replace(/^\.\//, "")).replace(/[^/]+\/\.\.\//g, "").replace(/[?#].*$/, "");
    return files.find((f) => f.path === p || f.path === ref.replace(/^\.?\//, "") || f.path.endsWith("/" + ref.replace(/^\.?\//, "")));
  };
  let html = index.content;
  html = html.replace(/<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi, (tag) => {
    const href = tag.match(/href=["']([^"']+)["']/i)?.[1];
    const f = href ? find(href) : null;
    return f ? `<style>\n${f.content}</style>` : tag;
  });
  html = html.replace(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (tag, a, src, b) => {
    const f = find(src);
    if (!f) return tag;
    const attrs = `${a}${b}`.replace(/\s+/g, " ").trim();
    return `<script${attrs ? " " + attrs : ""}>\n${f.content.replace(/<\/script/gi, "<\\/script")}</script>`;
  });
  return html;
}
