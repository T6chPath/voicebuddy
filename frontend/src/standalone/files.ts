/** Local file reading for the standalone app: text/code inlined into the prompt, images as data URLs (vision models). */
import type { UploadedFile } from "../api/types";
import type { LocalAttachment } from "./store";

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|py|js|ts|tsx|jsx|html|css|sql|ya?ml|toml|xml|log|java|kt|c|cpp|h|go|rs|sh)$/i;
const MAX_BYTES = 10 * 1024 * 1024, MAX_CHARS = 60000, MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const ACCEPT_LOCAL = ".txt,.md,.csv,.tsv,.json,.py,.js,.ts,.tsx,.jsx,.html,.css,.sql,.yaml,.yml,.toml,.xml,.log,.java,.kt,.c,.cpp,.h,.go,.rs,.sh,image/png,image/jpeg,image/webp,image/gif";

/** Content of files picked in the composer, kept in memory until the message is sent. */
export const pending = new Map<string, LocalAttachment>();

export function readLocal(file: File, onProgress: (f: number) => void) {
  const rd = new FileReader();
  const promise = (async (): Promise<UploadedFile> => {
    if (file.size > MAX_BYTES) throw new Error("Larger than 10 MB");
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const isPdf = head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46;
    if (isPdf) throw new Error("PDFs need the server version — paste the text instead");
    const image = /^image\/(png|jpeg|webp|gif)$/.test(file.type) && (head[0] === 0x89 || head[0] === 0xff || head[0] === 0x47 || head[8] === 0x57);
    const id = "loc_" + Math.random().toString(36).slice(2);
    const result = await new Promise<string>((resolve, reject) => {
      rd.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      rd.onload = () => resolve(String(rd.result));
      rd.onerror = () => reject(new Error("Couldn't read the file"));
      rd.onabort = () => reject(new DOMException("aborted", "AbortError"));
      if (image) rd.readAsDataURL(file); else rd.readAsText(file);
    });
    if (image) {
      if (file.size > MAX_IMAGE_BYTES) throw new Error("Images must be under 4 MB here");
      pending.set(id, { id, name: file.name, mime: file.type, size: file.size, kind: "image", dataUrl: result });
      return { id, name: file.name, mime: file.type, size: file.size, kind: "image", chars: 0, truncated: false };
    }
    if (!TEXT_EXT.test(file.name) && file.type && !file.type.startsWith("text/") && file.type !== "application/json")
      throw new Error("Unsupported file type. Use text, code, CSV/JSON or images");
    if (result.includes("\u0000")) throw new Error("This looks like a binary file, not text");
    const text = result.slice(0, MAX_CHARS);
    pending.set(id, { id, name: file.name, mime: file.type || "text/plain", size: file.size, kind: "text", text });
    return { id, name: file.name, mime: file.type || "text/plain", size: file.size, kind: "text", chars: text.length, truncated: result.length > MAX_CHARS };
  })();
  return { promise, abort: () => rd.abort() };
}
