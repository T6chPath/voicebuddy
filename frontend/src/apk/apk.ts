/** "Make app": web pages → installable Android apps, built on the phone by the Android app (window.ZenvqoApk). */

interface NativeApk {
  status(): string;
  build(id: string, html: string, name: string, iconBase64: string): void;
  install(id: string): void;
  open(id: string): void;
  share(id: string): void;
  installed(id: string): boolean;
}
declare global { interface Window { ZenvqoApk?: NativeApk; __zapk?: (id: string, ev: string, data: string) => void } }

export interface BuiltApp { id: string; pkg: string; name: string; size: number; saved: string }

type Handler = (ev: string, data: string) => void;
const handlers = new Map<string, Handler>();
let seq = 0;

function hook() {
  if (window.__zapk) return;
  window.__zapk = (id, ev, data) => handlers.get(id)?.(ev, data);
}

/** Can this device build apps? (only inside the zenvqo Android app) */
export function apkAvailable(): { ok: boolean; reason: string } {
  const b = typeof window !== "undefined" ? window.ZenvqoApk : undefined;
  if (!b) return { ok: false, reason: "Making apps works in the zenvqo Android app — open this chat there." };
  try {
    const s = JSON.parse(b.status()) as { ready: boolean; reason?: string };
    return { ok: s.ready, reason: s.reason || "" };
  } catch { return { ok: false, reason: "The app maker isn't available in this build." }; }
}

export function buildApk(html: string, name: string, iconBase64 = ""): Promise<BuiltApp> {
  const b = window.ZenvqoApk;
  if (!b) return Promise.reject(new Error(apkAvailable().reason));
  hook();
  const id = "a" + ++seq + "_" + Date.now();
  return new Promise((resolve, reject) => {
    handlers.set(id, (ev, data) => {
      if (ev === "built") { const d = JSON.parse(data) as Omit<BuiltApp, "id">; resolve({ id, ...d }); }
      else if (ev === "error") { handlers.delete(id); reject(new Error(data)); }
    });
    b.build(id, html, name, iconBase64);
  });
}

/** Opens the system install screen; resolves when Android reports the result. */
export function installApk(id: string): Promise<void> {
  const b = window.ZenvqoApk!;
  return new Promise((resolve, reject) => {
    const prev = handlers.get(id);
    handlers.set(id, (ev, data) => {
      if (ev === "installed") resolve();
      else if (ev === "install-failed") reject(new Error(data));
      else prev?.(ev, data);
    });
    b.install(id);
  });
}

export const openApp = (id: string) => window.ZenvqoApk?.open(id);
export const shareApk = (id: string) => window.ZenvqoApk?.share(id);

/** A name for the app: the page's <title>, else its first heading, else "My app". */
export function appName(html: string): string {
  const pick = (re: RegExp) => html.match(re)?.[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
  const t = pick(/<title[^>]*>([\s\S]*?)<\/title>/i) || pick(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || "";
  return (t || "My app").slice(0, 30);
}

/** Does this text look like a web page (rather than a snippet of HTML)? */
export function looksLikePage(text: string): boolean {
  return /<(!doctype html|html|body|head)\b/i.test(text) || (/<[a-z][\s\S]*>/i.test(text) && /<(div|main|section|h1|button|canvas|script|style)\b/i.test(text));
}

/** A small HTML snippet becomes a complete, phone-friendly page. */
export function asPage(html: string, name: string): string {
  if (/<html\b|<!doctype html/i.test(html)) {
    return /name=["']viewport["']/i.test(html) ? html
      : html.replace(/<head([^>]*)>/i, `<head$1><meta name="viewport" content="width=device-width, initial-scale=1">`);
  }
  const esc = name.replace(/[<>&]/g, "");
  return `<!doctype html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc}</title></head>\n<body>\n${html}\n</body></html>`;
}

/** "convert this html to an apk", "iska app bana do", "make it an android app" */
export const APK_REQUEST = /\b(apk|android app|app (bana|banao|bana do|banado)|(make|turn|convert|build|create|package)\b[^.?!]{0,40}\b(into|to|as)\s+(an?\s+)?(android\s+)?app)\b/i;
