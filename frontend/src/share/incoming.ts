/** Things shared to zenvqo from other apps (WhatsApp, Gallery, Files…) — the Android side copies them in
 * (window.ZenvqoShare); here they become File objects for the message box, like ChatGPT's share sheet. */

interface NativeShare { pending(): string; read(id: string, offset: number, length: number): string; done(): void }
declare global { interface Window { ZenvqoShare?: NativeShare; __zshare?: () => void } }

export interface Shared { files: File[]; text: string }
let queued: Shared | null = null;
let listener: ((s: Shared) => void) | null = null;
let reading = false;

const CHUNK = 1024 * 1024;

function readFile(b: NativeShare, f: { id: string; name: string; mime: string; size: number }): File {
  const parts: Uint8Array[] = [];
  for (let off = 0; off < f.size; off += CHUNK) {
    const s = atob(b.read(f.id, off, Math.min(CHUNK, f.size - off)) || "");
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    parts.push(u);
    if (!s.length) break;
  }
  return new File(parts as BlobPart[], f.name, { type: f.mime || "application/octet-stream" });
}

async function check() {
  const b = window.ZenvqoShare;
  if (!b || reading) return;
  let p: { busy?: boolean; text?: string; files?: { id: string; name: string; mime: string; size: number }[] };
  try { p = JSON.parse(b.pending()); } catch { return; }
  if (p.busy || (!p.files?.length && !p.text)) return;
  reading = true;
  try {
    const files = (p.files || []).map((f) => readFile(b, f));
    b.done();
    queued = { files, text: p.text || "" };
    if (listener) listener(queued);
  } finally { reading = false; }
}

/** Start listening (once, at startup): `on` hears about each new share. */
export function listenForShares(on: (s: Shared) => void) {
  listener = on;
  if (typeof window === "undefined" || !window.ZenvqoShare) return;
  window.__zshare = () => { void check(); };
  void check();
  if (queued) on(queued);
}

/** The share waiting to go into a message box (taken once). */
export function takeShared(): Shared | null { const q = queued; queued = null; return q; }
