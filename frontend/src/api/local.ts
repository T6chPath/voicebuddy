/** Standalone "backend" that runs inside the page (single HTML file / Android APK).
 *
 * Same exports as api/client.ts, so every component works unchanged. Differences from the server version:
 *  - no login: one local profile; everything is stored on this device in IndexedDB
 *  - talks DIRECTLY to an OpenAI-compatible server (llama-server on your laptop, Ollama, …) from the browser,
 *    so that server must allow CORS (llama-server does by default; Ollama needs OLLAMA_ORIGINS=*)
 *  - built-in "Demo (echo)" model works fully offline
 *  - files are read in the browser: text/code/CSV/JSON are inlined, images are sent to the model as data URLs;
 *    PDFs need the server app (no PDF parser in the single file, to keep it small)
 */
import { createSSEParser } from "./sse";
import { parseSpec } from "../plot/spec";
import { BOOK_PREFIX, DEEP_PREFIX, isBookMessage, isBookRequest, isDeepRequest } from "../lib/book";
import { detect, MARKER, safetyCheck, ASPECTS, STYLES, type Plan } from "../images/intent";
import { gemini, ImageEngineError, measure, openai, pollinations, type ImageJob, type MadeImage } from "../images/engines";
import { device, deviceModel, type DeviceModel } from "../images/device";
import { blendUnder, composite, cutOut, drawText, fillArea, padFor, placeOn, upscale, type Side } from "../images/canvas";
import type { TTSCatalog, Attachment, Conversation, ConversationDetail, ImageCaps, ImageOp, ImageOptions, Message, ModelInfo, UploadedFile, User, UserSettings } from "./types";

export const LOCAL_MODE = true;

export class ApiError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number, public code?: string) {
    super(message);
  }
  get isAuth() { return this.status === 401; }
  get isNetwork() { return this.status === 0; }
}

export function setUnauthorizedHandler(_fn: () => void) { /* no sessions locally */ }
export function errorMessage(status: number, body: unknown): string {
  const b = (Array.isArray(body) ? body[0] : body) as { detail?: unknown; error?: { message?: string } | string; message?: string } | null;
  const d = b?.detail ?? (typeof b?.error === "string" ? b.error : b?.error?.message) ?? b?.message;
  if (typeof d === "string" && d) return d.length > 300 ? d.slice(0, 300) + "…" : d;
  if (status === 401 || status === 403) return "The AI service rejected the API key. Check it in Settings → Connection.";
  if (status === 429) return "The AI service's free limit was reached. Wait a minute and try again.";
  return `Request failed (${status}).`;
}

// ---------------- network: Android native bridge (no CORS) or browser fetch ----------------
interface NativeNet { request(id: string, url: string, method: string, headers: string, body: string): void; cancel(id: string): void }
declare global { interface Window { ZenvqoNative?: NativeNet; __zn?: (id: string, kind: string, data: string) => void } }

type Pending = { resolve: (r: Response) => void; reject: (e: unknown) => void; ctl?: ReadableStreamDefaultController<Uint8Array>; started: boolean };
const pending = new Map<string, Pending>();
let seq = 0;

/** Inside the Android app, requests go through native code (HttpURLConnection), so AI services that don't send
 * CORS headers still work. The native side streams back: head {status} → data chunks → end | error. */
function nativeFetch(bridge: NativeNet, url: string, init: RequestInit): Promise<Response> {
  const id = "r" + ++seq + "_" + Date.now();
  if (!window.__zn) {
    const enc = new TextEncoder();
    window.__zn = (rid, kind, data) => {
      const p = pending.get(rid);
      if (!p) return;
      if (kind === "head") {
        const head = JSON.parse(data) as { status: number; type?: string };
        p.started = true;
        const body = new ReadableStream<Uint8Array>({ start: (c) => { p.ctl = c; } });
        p.resolve(new Response(body, { status: head.status >= 200 && head.status <= 599 ? head.status : 502,
          headers: head.type ? { "Content-Type": head.type } : {} }));
      } else if (kind === "data") p.ctl?.enqueue(enc.encode(data));
      else if (kind === "data64") {                                 // binary (images): base64 chunks
        const b = atob(data);
        const u = new Uint8Array(b.length);
        for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
        p.ctl?.enqueue(u);
      }
      else if (kind === "end") { p.ctl?.close(); pending.delete(rid); }
      else if (kind === "error") {
        if (p.started) p.ctl?.error(new TypeError(data || "network error"));
        else p.reject(new TypeError(data || "Failed to fetch"));
        pending.delete(rid);
      }
    };
  }
  return new Promise<Response>((resolve, reject) => {
    pending.set(id, { resolve, reject, started: false });
    const signal = init.signal;
    if (signal) {
      if (signal.aborted) { pending.delete(id); reject(new DOMException("aborted", "AbortError")); return; }
      signal.addEventListener("abort", () => {
        bridge.cancel(id);
        const p = pending.get(id);
        pending.delete(id);
        const err = new DOMException("aborted", "AbortError");
        if (p?.started) { try { p.ctl?.error(err); } catch { /* closed */ } } else p?.reject(err);
      }, { once: true });
    }
    bridge.request(id, url, (init.method || "GET").toUpperCase(), JSON.stringify(init.headers || {}), typeof init.body === "string" ? init.body : "");
  });
}

function net(url: string, init: RequestInit = {}): Promise<Response> {
  const bridge = typeof window !== "undefined" ? window.ZenvqoNative : undefined;
  if (bridge) return nativeFetch(bridge, url, init);
  const h = (init.headers || {}) as Record<string, string>;
  if (h["X-Zenvqo-Body-Base64"] && typeof init.body === "string") {          // browser: turn the base64 body back into bytes
    const { ["X-Zenvqo-Body-Base64"]: _flag, ...rest } = h;
    const b = atob(init.body);
    const u = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
    return fetch(url, { ...init, headers: rest, body: u });
  }
  return fetch(url, init);
}

/** Ready-made connections shown in Settings → Connection. */
export const PRESETS = [
  { id: "gemini", label: "Google Gemini — free key", url: "https://generativelanguage.googleapis.com/v1beta/openai", keyUrl: "https://aistudio.google.com/apikey", needsKey: true },
  { id: "groq", label: "Groq — free key", url: "https://api.groq.com/openai/v1", keyUrl: "https://console.groq.com/keys", needsKey: true },
  { id: "openrouter", label: "OpenRouter — 500+ models, free key", url: "https://openrouter.ai/api/v1", keyUrl: "https://openrouter.ai/keys", needsKey: true },
  { id: "deepseek", label: "DeepSeek V4 — big projects", url: "https://api.deepseek.com/v1", keyUrl: "https://platform.deepseek.com/api_keys", needsKey: true },
  { id: "anthropic", label: "Claude (Anthropic)", url: "https://api.anthropic.com/v1", keyUrl: "https://platform.claude.com/settings/keys", needsKey: true },
  { id: "openai", label: "OpenAI", url: "https://api.openai.com/v1", keyUrl: "https://platform.openai.com/api-keys", needsKey: true },
  { id: "mistral", label: "Mistral (Codestral)", url: "https://api.mistral.ai/v1", keyUrl: "https://console.mistral.ai/api-keys", needsKey: true },
  { id: "laptop", label: "My laptop (llama-server)", url: "http://192.168.1.20:8080", keyUrl: "", needsKey: false },
  { id: "ollama", label: "Ollama", url: "http://192.168.1.20:11434", keyUrl: "", needsKey: false },
  { id: "custom", label: "Other OpenAI-compatible server", url: "", keyUrl: "", needsKey: false },
] as const;

/** Hosted services with long context windows (hundreds of thousands of tokens): keep much more of the chat for big projects. */
const LONG_CONTEXT = /generativelanguage\.googleapis\.com|api\.deepseek\.com|api\.anthropic\.com|openrouter\.ai|api\.openai\.com|api\.mistral\.ai/;
function historyBudget(s: UserSettings): number { return LONG_CONTEXT.test(base(s)) ? 400_000 : 24_000; }

/** The model can't know today's date by itself — tell it, in the user's own time zone. */
export function nowContext(d = new Date()): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  const when = d.toLocaleString("en-IN", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `Current date and time for the user: ${when} (${tz}). Use this for questions about today, dates, days or time.`;
}

// ---------------- IndexedDB ----------------
type StoreName = "conversations" | "messages" | "files";
interface FileRow extends Attachment { icon?: string; text?: string; full?: string; audio?: string; dataUrl?: string; images?: string[]; pages?: number; created_at: number }
interface MsgRow extends Message { conversation_id: string }

let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open("zenvqo-chat", 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore("conversations", { keyPath: "id" });
        d.createObjectStore("messages", { keyPath: "id" }).createIndex("conv", "conversation_id");
        d.createObjectStore("files", { keyPath: "id" });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(new ApiError(500, "This browser blocked local storage, so chats can't be saved."));
    });
  }
  return dbp;
}
function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
async function store(name: StoreName, mode: IDBTransactionMode = "readonly") {
  return (await db()).transaction(name, mode).objectStore(name);
}
const put = async (name: StoreName, v: unknown) => { await req((await store(name, "readwrite")).put(v)); };
const get = async <T>(name: StoreName, id: string) => (await req((await store(name)).get(id))) as T | undefined;
const all = async <T>(name: StoreName) => (await req((await store(name)).getAll())) as T[];
const del = async (name: StoreName, id: string) => { await req((await store(name, "readwrite")).delete(id)); };
async function messagesOf(cid: string): Promise<MsgRow[]> {
  const rows = (await req((await store("messages")).index("conv").getAll(cid))) as MsgRow[];
  return rows.sort((a, b) => a.created_at - b.created_at);
}

const uid = (p: string) => `${p}_${(crypto.randomUUID?.() ?? Math.random().toString(16).slice(2) + Date.now().toString(16)).replace(/-/g, "")}`;
const now = () => Date.now() / 1000;
const strip = ({ conversation_id: _c, ...m }: MsgRow): Message => m; // eslint-disable-line @typescript-eslint/no-unused-vars

// ---------------- settings & models ----------------
const SETTINGS_KEY = "zc.local.settings";
const DEFAULTS: UserSettings = { theme: "system", default_model: "echo", temperature: 0.7, system_prompt: "", font_size: "medium",
  send_on_enter: true, show_timestamps: false, server_url: "", api_key: "" };
function loadSettings(): UserSettings {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") }; } catch { return { ...DEFAULTS }; }
}
const ECHO: ModelInfo = { id: "echo", label: "Demo (not a real AI)", vision: false, description: "Offline demo — connect a real AI in Settings → Connection" };

function base(s: UserSettings): string {
  let u = (s.server_url || "").trim().replace(/\/+$/, "");
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "http://" + u;
  try {
    const path = new URL(u).pathname.replace(/\/+$/, "");
    return path ? u : u + "/v1";            // bare host (llama-server, Ollama) → /v1; full API paths kept as given
  } catch {
    return u;
  }
}

const NOT_CHAT = /embed|imagen|veo|tts|audio|aqa|whisper|guard|lyria|image-generation|transcri|moderation|banana/i;
function headers(s: UserSettings): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json", ...(s.api_key ? { Authorization: `Bearer ${s.api_key}` } : {}) };
  const b = base(s);
  if (/api\.anthropic\.com/.test(b) && s.api_key) {                // Claude: its own key header (model list) + browser access
    h["x-api-key"] = s.api_key;
    h["anthropic-version"] = "2023-06-01";
    h["anthropic-dangerous-direct-browser-access"] = "true";
  }
  if (/openrouter\.ai/.test(b)) h["X-Title"] = "zenvqo";
  return h;
}

export async function fetchServerModels(s: UserSettings, signal?: AbortSignal): Promise<ModelInfo[]> {
  const b = base(s);
  if (!b) return [];
  let r: Response;
  try {
    r = await net(b + "/models", { headers: headers(s), signal });
  } catch {
    throw new ApiError(0, `Can't reach ${b}. Check the address, that the server is running, and that it allows CORS.`);
  }
  if (r.status === 401 || r.status === 403 || r.status === 400) {
    const body = await r.json().catch(() => null);
    throw new ApiError(401, r.status === 400 ? errorMessage(400, body) : "The service rejected the API key. Copy it again and check for spaces.");
  }
  if (!r.ok) throw new ApiError(r.status, `The server answered ${r.status} for /models.`);
  const j = await r.json().catch(() => ({}));
  const items = (j.data || j.models || []) as { id?: string; name?: string; model?: string; pricing?: { prompt?: string; completion?: string }; context_length?: number }[];
  const host = (() => { try { return new URL(b).host; } catch { return b; } })();
  const router = /openrouter\.ai/.test(b);
  const list = items.map((m) => {
    const id = (m.id || m.name || m.model || "").replace(/^models\//, "");
    const free = /:free$/.test(id) || id === "openrouter/free" || (router && m.pricing?.prompt === "0" && m.pricing?.completion === "0");
    const ctx = m.context_length && m.context_length >= 100_000 ? ` · ${m.context_length >= 1_000_000 ? Math.round(m.context_length / 1_000_000) + "M" : Math.round(m.context_length / 1000) + "K"} context` : "";
    // OpenRouter ids are "maker/model": keep the maker so 500 models stay tellable apart
    const name = router ? id.replace(/:free$/, "") : id.split("/").pop()!.replace(/\.gguf$/i, "");
    return { id, free, info: { id: "srv:" + id, label: name + (free ? " (free)" : ""), vision: canSee(id), description: `on ${host}${ctx}` } as ModelInfo };
  }).filter((x) => x.id && !NOT_CHAT.test(x.id));
  if (router) list.sort((a, b2) => (a.id === "openrouter/free" ? -1 : b2.id === "openrouter/free" ? 1 : 0) || Number(b2.free) - Number(a.free) || a.id.localeCompare(b2.id));
  return list.map((x) => x.info);
}

let modelCache: ModelInfo[] | null = null;

// ---------------- API surface (same shape as api/client.ts) ----------------
const LOCAL_USER: User = { id: "local", email: "Stored on this device", name: "You" };

export const api = {
  me: async () => LOCAL_USER,
  login: async () => LOCAL_USER,
  register: async () => LOCAL_USER,
  logout: async () => {},
  models: async (): Promise<{ items: ModelInfo[] }> => {
    const s = loadSettings();
    let srv: ModelInfo[] = [];
    try { srv = await fetchServerModels(s, AbortSignal.timeout?.(4000)); } catch { srv = modelCache?.filter((m) => m.id !== "echo") ?? []; }
    modelCache = [...srv, ECHO];
    return { items: modelCache };
  },
  settings: async () => loadSettings(),
  saveSettings: async (s: UserSettings) => {
    const next = { ...loadSettings(), ...s };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    return next;
  },
  conversations: async (q = ""): Promise<{ items: Conversation[]; has_more: boolean }> => {
    let items = await all<Conversation>("conversations");
    const needle = q.trim().toLowerCase();
    if (needle) {
      const hits = new Set((await all<MsgRow>("messages")).filter((m) => m.content.toLowerCase().includes(needle)).map((m) => m.conversation_id));
      items = items.filter((c) => c.title.toLowerCase().includes(needle) || hits.has(c.id));
    }
    items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at - a.updated_at);
    return { items, has_more: false };
  },
  conversation: async (id: string): Promise<ConversationDetail> => {
    const c = await get<Conversation>("conversations", id);
    if (!c) throw new ApiError(404, "Conversation not found.");
    const rows = await messagesOf(id);
    for (const r of rows) for (const a of r.attachments) {
      if (a.kind === "image" && !pictures.has(a.id)) { const f = await get<FileRow>("files", a.id); if (f?.dataUrl) pictures.set(a.id, f.dataUrl); }
    }
    return { ...c, messages: rows.map(strip) };
  },
  createConversation: async (model?: string): Promise<Conversation> => {
    const t = now();
    const c: Conversation = { id: uid("cnv"), title: "New chat", model: model || loadSettings().default_model || "echo", pinned: false, created_at: t, updated_at: t };
    await put("conversations", c);
    return c;
  },
  updateConversation: async (id: string, patch: Partial<Pick<Conversation, "title" | "pinned" | "model">>): Promise<Conversation> => {
    const c = await get<Conversation>("conversations", id);
    if (!c) throw new ApiError(404, "Conversation not found.");
    const next = { ...c, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    await put("conversations", next);
    return next;
  },
  deleteConversation: async (id: string) => {
    for (const m of await messagesOf(id)) await del("messages", m.id);
    await del("conversations", id);
  },
  deleteFile: async (id: string) => { await del("files", id); },
  fileText: async (id: string): Promise<string | null> => { const f = await get<FileRow>("files", id); return f?.full ?? f?.text ?? null; },
  /** the launcher icon of an attached APK (data: URL), when it had one */
  fileIcon: async (id: string): Promise<string | null> => (await get<FileRow>("files", id))?.icon ?? null,
  /** a short answer from the chat's AI (no chat history), e.g. a Play Store description; null when no AI is set up */
  quickText: async (prompt: string, maxTokens = 900): Promise<string | null> => {
    const s = loadSettings();
    if (!base(s)) return null;
    const pick = s.default_model && s.default_model !== "echo" ? s.default_model : bestModelFor({ see: false, hear: false });
    if (!pick) return null;
    try {
      const r = await net(base(s) + "/chat/completions", { method: "POST", headers: headers(s), body: JSON.stringify({
        model: pick.replace(/^srv:/, ""), stream: false, temperature: 0.5, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }) });
      if (!r.ok) return null;
      const j = await r.json() as { choices?: { message?: { content?: string } }[] };
      return (j.choices?.[0]?.message?.content || "").trim() || null;
    } catch { return null; }
  },
  imageCaps: async (): Promise<ImageCaps> => {
    const e = imageEngines(loadSettings());
    // every operation works: keyed engines edit directly; otherwise the free service + on-phone tools do it
    const ops: ImageOp[] = ["generate", "edit", "variations", "style", "inpaint", "remove_object", "replace_object",
      "remove_background", "replace_background", "outpaint", "upscale"];
    const label: Record<string, string> = { gemini: "Gemini (your key)", openai: "OpenAI (your key)", pollinations: "Free image service (Pollinations) + on-phone tools" };
    return { available: true, reason: null, ops, styles: Object.keys(STYLES), aspect_ratios: ASPECTS, formats: ["png", "jpeg"], max_n: 4, max_resolution: 2048,
      providers: [
        ...(() => { const st = loadSettings(); const d = st.image_engine === "online" ? null : deviceModel(st.device_model);
          return d ? [{ name: "This phone (no internet)", model: d.label, ready: true, reason: null, ops, negative_prompt: false, seed: true }] : []; })(),
        ...e.map((n) => ({ name: label[n], model: n === "gemini" ? "gemini-2.5-flash-image" : n === "openai" ? "gpt-image-1" : "flux",
          ready: true, reason: null, ops, negative_prompt: n !== "gemini", seed: n === "pollinations" }))] };
  },
  ttsVoices: async (): Promise<TTSCatalog> => ({ available: false, reason: "this app has no server; it uses your device's own voices", engines: [], voices: [], languages: [], defaults: {}, max_chars: 0 }),
  voiceConfig: async () => ({ available: false, reason: "this app has no server", partials: false, max_seconds: 0 }),
  transcribe: async (_wav: Blob, _lang: string): Promise<{ text: string; lang: string; confidence: string; engine: string; ms: number }> => { throw new ApiError(400, "No server speech recognition in the standalone app."); },
};

export async function clearAllLocalData() {
  for (const s of ["conversations", "messages", "files"] as StoreName[]) await req((await store(s, "readwrite")).clear());
}

// ---------------- files ----------------
const MAX_PDF_BYTES = 50 * 1024 * 1024;

/** "%PDF-" anywhere in the first 1 KB (some downloaded/emailed files have junk before it), or a .pdf name/type. */
async function isPdf(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  for (let i = 0; i + 4 < head.length; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) return true;
  }
  return false;
}

type How = "image" | "convert" | "pdf" | "video" | "audio" | "html" | "doc";
/** What a file is, from its first bytes (then its name): every kind of file is accepted. */
async function sniff(file: File): Promise<{ how: How; mime: string }> {
  const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const starts = (...b: number[]) => b.every((x, i) => head[i] === x);
  const ascii = (from: number, n: number) => String.fromCharCode(...head.subarray(from, from + n));
  const ext = (file.name.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
  if (starts(0x89, 0x50, 0x4e, 0x47)) return { how: "image", mime: "image/png" };
  if (starts(0xff, 0xd8, 0xff)) return { how: "image", mime: "image/jpeg" };
  if (starts(0x47, 0x49, 0x46, 0x38)) return { how: "image", mime: "image/gif" };
  if (starts(0x52, 0x49, 0x46, 0x46) && ascii(8, 4) === "WEBP") return { how: "image", mime: "image/webp" };
  if (await isPdf(file)) return { how: "pdf", mime: "application/pdf" };
  if (ascii(4, 4) === "ftyp") {                                      // ISO media: HEIC/AVIF photos, MP4/MOV video, M4A audio
    const brand = ascii(8, 4).toLowerCase();
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif|avis)$/.test(brand)) return { how: "convert", mime: brand.startsWith("avi") ? "image/avif" : "image/heic" };
    if (/^m4a|^m4b|^m4p/.test(brand) || /^(m4a|m4b|aac)$/.test(ext)) return { how: "audio", mime: "audio/mp4" };
    return { how: "video", mime: ext === "mov" ? "video/quicktime" : "video/mp4" };
  }
  if (starts(0x42, 0x4d) && /^(bmp|dib)$/.test(ext)) return { how: "convert", mime: "image/bmp" };
  if (starts(0x49, 0x49, 0x2a, 0x00) || starts(0x4d, 0x4d, 0x00, 0x2a)) return { how: "convert", mime: "image/tiff" };
  if (/^(heic|heif|avif|bmp|tiff?|ico|jxl|jp2|svg)$/.test(ext) || (file.type.startsWith("image/") && !/^(png|jpe?g|gif|webp)$/.test(ext)))
    return { how: "convert", mime: file.type || (ext === "svg" ? "image/svg+xml" : "image/" + ext) };
  if (starts(0x1a, 0x45, 0xdf, 0xa3)) return ext === "mka" ? { how: "audio", mime: "audio/webm" } : { how: "video", mime: "video/webm" };
  if (file.type.startsWith("video/") || /^(mp4|m4v|mov|webm|mkv|3gp|3g2|avi|wmv|flv|mpe?g|ts)$/.test(ext)) return { how: "video", mime: file.type || "video/" + ext };
  if (starts(0x49, 0x44, 0x33) || starts(0x4f, 0x67, 0x67, 0x53) || starts(0x66, 0x4c, 0x61, 0x43) || (starts(0x52, 0x49, 0x46, 0x46) && ascii(8, 4) === "WAVE") ||
      file.type.startsWith("audio/") || /^(mp3|wav|ogg|oga|opus|aac|flac|amr|wma|m4a)$/.test(ext)) return { how: "audio", mime: file.type || "audio/" + ext };
  if (/^(html?|xhtml)$/.test(ext)) return { how: "html", mime: "text/html" };
  return { how: "doc", mime: file.type || "application/octet-stream" };
}

/** Photos straight from a phone camera are often 4000 px / 5 MB: send at most 2048 px (sharp enough to read text). */
async function imageDataUrl(file: File, mime: string): Promise<string> {
  const raw = () => new Promise<string>((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result as string);
    fr.onerror = () => rej(new ApiError(400, "Couldn't read the file."));
    fr.readAsDataURL(file);
  });
  if (mime === "image/gif" || file.size < 1_500_000 || typeof createImageBitmap !== "function") return raw();
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return c.toDataURL("image/jpeg", 0.88);
  } catch {
    return raw();
  }
}

const MAX_VIDEO_BYTES = 500 * 1024 * 1024, MAX_DOC_BYTES = 60 * 1024 * 1024;
const DOC_CHARS = 150_000;

export function uploadFile(file: File, onProgress: (frac: number) => void): { promise: Promise<UploadedFile>; abort: () => void } {
  const promise = (async () => {
    if (file.size === 0) throw new ApiError(400, "The file is empty.");
    const { how, mime } = await sniff(file);
    const limit = how === "video" ? MAX_VIDEO_BYTES : how === "pdf" ? MAX_PDF_BYTES : how === "image" || how === "convert" ? 40 * 1024 * 1024 : MAX_DOC_BYTES;
    if (file.size > limit) throw new ApiError(413, `File is larger than ${Math.round(limit / 1048576)} MB.`);
    const name = file.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 120) || "file";
    const kind: Attachment["kind"] = how === "image" || how === "convert" ? "image" : how === "pdf" ? "pdf" : "text";
    const row: FileRow = { id: uid("fil"), name, mime, size: file.size, kind, created_at: now() };
    let truncated = false;
    const media = () => import("../files/media");
    if (how === "html") {
      const t = await file.text();
      row.text = t.slice(0, 60000);
      truncated = t.length > 60000;
      if (truncated) row.full = t;                                    // whole web pages are kept for "Make app"
    } else if (how === "pdf") {
      const { readPdf } = await import("../pdf/read");
      let doc;
      try {
        doc = await readPdf(new Uint8Array(await file.arrayBuffer()), name, (f) => onProgress(f * 0.95));
      } catch (e) {
        throw new ApiError(415, (e as Error).message || "This PDF couldn't be read.");
      }
      if (!doc.images.length && !doc.text.replace(/^\(PDF[^\n]*\n|--- Page \d+ ---|\(no text on this page[^)]*\)|\s/gm, "")) throw new ApiError(415, "This PDF has no readable pages.");
      row.text = doc.text;
      row.images = doc.images;
      row.pages = doc.pages;
      truncated = doc.truncated;
    } else if (how === "image") {
      row.dataUrl = await imageDataUrl(file, mime);
    } else if (how === "convert") {
      const jpeg = await (await media()).pictureToJpeg(file);
      if (!jpeg) throw new ApiError(415, `This phone can't open ${name.split(".").pop()?.toUpperCase() || "this"} pictures. Share it as a JPEG or PNG instead.`);
      row.dataUrl = jpeg;
      row.mime = "image/jpeg";
    } else if (how === "video") {
      const m = await media();
      onProgress(0.2);
      const v = await m.videoFrames(file);
      row.images = v.frames;
      row.text = v.frames.length
        ? `(Video "${name}": ${m.clock(v.duration)} long, ${v.width}×${v.height}. ${v.frames.length} snapshots taken evenly from start to end are attached in order — describe and answer from them; you can't hear the sound.)`
        : `(Video "${name}"${v.duration ? `, ${m.clock(v.duration)} long` : ""}: this phone couldn't play its format, so no pictures from it could be taken.)`;
    } else if (how === "audio") {
      const m = await media();
      onProgress(0.2);
      const wav = await m.audioToWav(file);
      if (wav) {
        row.audio = wav.base64;
        row.text = `(Audio "${name}", ${m.clock(wav.seconds)} long. The recording is attached — listen to it and answer from what is said or heard in it${wav.cut ? "; only the first 10 minutes are included" : ""}.)`;
      } else {
        const len = await m.audioLength(file);
        row.text = `(Audio file "${name}"${len ? `, ${m.clock(len)} long` : ""}: this phone couldn't open its format, so the recording itself isn't included.)`;
      }
    } else {
      const { readDocument, textRuns } = await import("../files/documents");
      const bytes = new Uint8Array(await file.arrayBuffer());
      onProgress(0.3);
      let doc;
      try { doc = await readDocument(name, bytes); } catch { doc = null; }
      if (doc && /\.apk$/i.test(name)) {
        const { apkWebApp } = await import("../apk/play");
        const app = await apkWebApp(bytes).catch(() => null);
        if (app) {
          row.full = app.html;
          if (app.icon) row.icon = app.icon;
          doc = { ...doc, text: `(This APK is an app made from a web page — its page is assets/index.html. The app can turn it into a Google Play package: tap “Google Play” on the file.)\n\n` + doc.text };
        }
      }
      if (doc) {
        const body = doc.format === "text" ? doc.text : `(${doc.format})\n\n${doc.text || "(no text in this file)"}`;
        row.text = body.slice(0, doc.format === "text" ? 60000 : DOC_CHARS);
        truncated = body.length > row.text.length;
        if (doc.images.length) {
          const m = await media();
          const imgs: string[] = [];
          for (const im of doc.images) { const j = await m.bytesToJpeg(im.bytes, im.mime); if (j) imgs.push(j); }
          if (imgs.length) { row.images = imgs; row.text += `\n\n(${imgs.length} picture${imgs.length > 1 ? "s" : ""} from this file are attached.)`; }
        }
      } else {
        const runs = textRuns(bytes).slice(0, 20000);
        row.text = `(File "${name}", ${(file.size / 1024).toFixed(0)} KB, type ${mime}. It isn't a document format the app can open, so here is the readable text found inside it${runs ? "" : " — none"}.)\n\n${runs}`;
      }
    }
    await put("files", row);
    if (row.dataUrl) pictures.set(row.id, row.dataUrl);
    onProgress(1);
    return { id: row.id, name, mime: row.mime, size: file.size, kind, chars: row.text?.length ?? 0, truncated };
  })();
  return { promise, abort: () => {} };
}

// ---------------- chat ----------------
/** Pictures in the chat are shown from data: URLs kept in memory (filled on upload and when a chat is opened). */
const pictures = new Map<string, string>();
export const fileUrl = (id: string, _download = false) => pictures.get(id) || "";
export async function ttsSpeak(_body: Record<string, unknown>, _signal: AbortSignal): Promise<Blob> { throw new ApiError(400, "No server voices in the standalone app."); }

export interface StreamHandlers {
  onTool?: (t: { name: string; op?: ImageOp; status: "running" | "done" | "failed"; code?: string }) => void;
  onProgress?: (p: { fraction: number; text: string }) => void;
  onImage?: (a: Attachment) => void;
  onMeta?: (m: { user_message: Message | null; assistant_message: { id: string; model: string } }) => void;
  onDelta: (text: string) => void;
  onDone?: (d: { status: string; title: string | null }) => void;
  onError?: (e: ApiError) => void;
}

const BASE_SYSTEM = "You are zenvqo, a helpful assistant who explains things clearly. Use Markdown when it helps (lists, tables, fenced code with a language). " +
  "How to write answers: begin with the direct answer in one or two clear sentences, with no preamble such as “Great question” and without repeating the question. Then explain in short paragraphs of two to four sentences, one idea per paragraph, in simple everyday words; explain any technical term the first time you use it. Match the length to the question: a simple question gets a short, complete answer; a question that needs explaining gets a well-organised explanation. For longer explanations use ## headings for the main parts (for example what it is, how it works, an example, why it matters), **bold** the few key terms the reader should remember, numbered lists for steps and processes, bullet lists for features, causes or types, a table for comparisons, and a worked example or a real-life analogy when it makes the idea easier to understand. To highlight something, write a blockquote that starts with a bold label: > **Tip:** …, > **Note:** …, > **Important:** …, > **Example:** … ; end a longer explanation with > **In short:** and a one- or two-sentence summary. Use these sparingly — at most a few per answer. Never write one long wall of text, and don\"t pad the answer. Reply in the same language and style the user writes in (Hinglish if they write Hinglish). (When the user asks for a PDF, a picture or a graph, the instructions for those come first.) " +
  "Write mathematics in LaTeX: inline as $...$ and displayed equations as $$...$$ on their own lines. For a large project (an app, a website, a game, a program with several files): start with a short plan and the file tree, then give EVERY file complete (no placeholders like '... rest of the code' or 'same as before'), each in its own code block with the file's path written on the line just before it as **`path/to/file.ext`**; finish with how to run it. The app shows the whole project as a .zip download (and web projects can become an Android app). Long answers are fine: if your reply is cut off, the app asks you to continue. When the user asks to change a project, give the complete new version of each changed file. When the user asks for a website, web page, web app or game in HTML, make it large, rich and complete — like a real product, not a demo: every section it needs (for a website: a header with navigation, a hero, several content sections, cards or a gallery, a contact form, a footer), full CSS (a colour theme, good typography, responsive layout for phones and computers, hover states, smooth transitions) and working JavaScript for every button, menu, form and tab. Long code is expected — hundreds or thousands of lines is fine; never shorten it, skip parts, or leave 'add more here' or TODO comments. Under the code the app shows “View site” (opens the page running, like a website) and “Make app” (turns it into an Android app): after the code, say in one short sentence to tap “View site” to see it. The app can turn a web page into a real Android app (APK) on the phone: when the user wants an app, a tool, a game or a website, or asks to convert HTML into an APK, write the complete app as ONE self-contained HTML file (inline CSS and JavaScript, no external files, mobile-friendly, data kept in localStorage when it should be remembered) in a single ```html code block, with a <title> that names the app; then say in one short sentence to tap “Make app” under the code to build and install it. Never say you can't make APK files or Android apps. The app can also make a Google Play package (for publishing on the Play Store): a folder with the app as a signed Android App Bundle (.aab, targeting Android 16 / API 36 as Google Play requires), store icon, feature graphic, screenshots, listing texts, privacy policy, data-safety answers, the upload key and a step-by-step guide. When the user wants to publish on Google Play or turn an APK into a Play Console upload: for a web page, write it as one self-contained HTML file as above and say to tap “Make app” → “Google Play”; for an APK zenvqo made (attached), say to tap “Google Play” on the file. Explain that Google Play takes .aab files, not .apk, for new apps; that a developer account costs a one-time US$25; and that new personal accounts must run a closed test with 12 testers for 14 days before publishing. APKs not made from a web page can't be converted: they need their source project (Android Studio → Build → Generate Signed App Bundle). \"Learn as a book\": when the user's message starts with \"Teach me as a book:\", teach that topic in depth as a real book, at the level the user asks for (if none is given, start from zero and go all the way to an advanced level). Reply with: a line \"# <the book's title>\"; one italic line saying who it is for and what they will be able to do after reading it; \"## Contents\" with a numbered list of 6 to 12 chapters that build on each other (\"1. Chapter title — what it covers\"); then Chapter 1 in full. Write every chapter as \"## Chapter N: Title\", then: a short opening that says why it matters; sections as \"### N.1 …\", \"### N.2 …\" that explain step by step and in depth, with clear definitions, analogies, worked examples, real-life uses, tables or ```plot graphs or diagrams where they help, LaTeX for maths and common mistakes to avoid (write each worked example as a blockquote that starts with \"**Example:**\" and each formal definition as one that starts with \"**Definition:**\"); then \"### Key points\" (bullets), \"### Practice\" (4 to 6 questions, from easy to hard) and \"### Answers\" (worked answers). A chapter is long and thorough — like a chapter of a good textbook, typically 1500 to 3000 words — never a summary. When the user's message starts with \"Continue the book: write Chapter\", write only the chapter it names, in the same format, without repeating the title or contents; after the last chapter add \"## What to learn next\". When the user's message starts with \"Teach me as a book, every topic in depth:\", write the book topic by topic instead: every topic of every chapter gets its own reply and is explained in great depth. Reply with: \"# <the book's title>\"; the italic line; \"## Contents\" with a numbered list of 6 to 12 chapters (\"1. Chapter title — what it covers\"), each followed by its 3 to 6 topics as a nested bullet list numbered by chapter (\"   - 1.1 Topic title\", \"   - 1.2 Topic title\"); then \"## Chapter 1: Title\" with a short opening (why it matters and what the chapter covers) and topic 1.1 only. Write every topic as \"### N.M Topic title\" followed by the explanation itself, written like the best textbook: flowing paragraphs that start from what the reader already knows and build up step by step — precise definitions, why each rule or formula is true (derive it, with LaTeX), how it connects to earlier topics, analogies and real-life uses. Never use fixed section labels such as \"The big idea\", \"Step by step\", \"Introduction\", \"Overview\", \"Key points\", \"Summary\" or \"Check yourself\"; add a \"####\" sub-heading only for a real part of a long topic, named after what that part explains. Work examples into the explanation as blockquotes that start with \"**Example:**\", with every step shown; put a formal definition in a blockquote that starts with \"**Definition:**\", a rule to remember in one that starts with \"**Remember:**\" and a common mistake in one that starts with \"**Watch out:**\"; add tables, ```plot graphs or diagrams where they help. A topic is long and thorough — typically 1200 to 2500 words, deeper than a textbook goes — never a summary. When the user's message starts with \"Continue the book: explain topic\" or \"Continue the book: start Chapter\", write only the topic it names, in the same format, without repeating the title or contents: if it says \"start Chapter N\", begin with \"## Chapter N: Title\" and the chapter's short opening; if it says \"end Chapter N with its review\", finish with \"### Chapter N review\" (a summary of the chapter, then 4 to 6 mixed practice questions with worked answers); if it says it is the last topic of the book, end with \"## What to learn next\". Between pages the user may ask about what they are reading: answer such questions normally, not as a book page. Don't add a line about continuing — the app shows a \"Next\" button under each page and can save the whole book as a PDF. When the user asks for a PDF (quiz, notes, paragraph, worksheet…), write the complete content as a well-structured Markdown document that starts with a # title — the app turns your reply into a PDF file automatically, so never say you can't create PDFs. " +
  "When the user shares a photo or image, look at it carefully and explain everything in it: what it shows, all visible text (read it out exactly), objects, numbers, diagrams, charts, problems or questions written in it (a photo is often a cropped question from a book, worksheet or exam paper: first write the question out exactly, then solve it fully step by step and give the final answer clearly; if there are several questions, answer each one; if part is blurry or cut off, say which part), people's actions and expressions (never identify real people from their faces), and what it means — then answer the user's question about it. " +
  "When files are attached (<attached_file>), including PDFs, answer from their content: quote it where useful, mention the page (\"Page 3\") for PDFs, and say plainly when the answer isn't in the file. " +
  "When the user asks to plot, graph, draw or visualise a function, equation, curve or surface (2D or 3D), draw it: write a fenced code block with the language plot, one equation per line in plain maths notation (not LaTeX), for example ```plot\ny = sin(x)\ny = x^2/4\n```. Supported lines: y = f(x); x = f(y); any equation in x and y (x^2 + y^2 = 25); inequalities, shaded (y > x^2); polar r = f(theta); parametric x = f(t), y = g(t); points (2, 3); a domain at the end ({0 <= x <= 4}); 3D surfaces z = f(x, y); any equation in x, y, z (x^2 + y^2 + z^2 = 9); 3D curves x = f(t), y = g(t), z = h(t); parametric surfaces in u and v; options x: -5..5, y: …, z: …, t: 0..2pi, title: …; parameters with a slider a = 1 [0..5]. Use ^ for powers, sqrt, abs, ln, log (base 10), pi, e; implicit multiplication like 2x is fine. Choose ranges that show the interesting part. The app draws an interactive graph (zoom, trace, roots and turning points marked), so never say you can't draw graphs; after the block, briefly explain the key features (domain, intercepts, asymptotes, turning points, shape). " +
  "The app can also make pictures (photos, drawings, logos, posters, wallpapers): when the user wants a picture made and it hasn't been made yet, reply with one line [[image: a detailed English description of the picture]] followed by one short sentence; the app replaces that line with the picture. Never say you can't create images.";
type Part = { type: string; text?: string; image_url?: { url: string }; input_audio?: { data: string; format: string } };
type ChatMsg = { role: string; content: string | Part[] };

async function buildHistory(cid: string, s: UserSettings, vision: boolean): Promise<ChatMsg[]> {
  const rows = (await messagesOf(cid)).filter((m) => m.status !== "error" && !(m.role === "assistant" && !m.content));
  const out: ChatMsg[] = [];
  let used = 0;
  let i = rows.length - 1;
  for (; i >= 0; i--) {
    const r = rows[i];
    let text = r.content;
    let docChars = 0;
    const images: string[] = [];
    const sounds: string[] = [];
    for (const a of r.attachments) {
      const f = await get<FileRow>("files", a.id);
      if (!f) continue;
      if (f.text) {
        text += `\n\n<attached_file name="${f.name.replace(/"/g, "'")}"${f.pages ? ` pages="${f.pages}"` : ""}>\n${f.text}\n</attached_file>`;
        docChars += f.text.length;
      }
      if (f.generated) {                                   // pictures the app made: the model gets their description
        text += `\n[You made an image here: ${f.meta?.prompt || "a picture"}]`;
        continue;
      }
      if (vision && r.role === "user") {
        if (f.dataUrl) images.push(f.dataUrl);
        if (f.images) images.push(...f.images);
        if (f.audio) sounds.push(f.audio);
      }
    }
    // chat history is kept to ~24k characters (400k on long-context services); attached documents don't count (kept below)
    if (used + text.length - docChars > historyBudget(s) && out.length) break;
    used += text.length - docChars;
    out.push(images.length || sounds.length ? { role: r.role, content: [{ type: "text", text }, ...images.map((u) => ({ type: "image_url", image_url: { url: u } })),
      ...sounds.map((d) => ({ type: "input_audio", input_audio: { data: d, format: "wav" } }))] } : { role: r.role, content: text });
  }
  // documents attached earlier than the kept history still count: follow-up questions ("what does page 4 say?")
  let docs = "";
  for (; i >= 0; i--) {
    for (const a of rows[i].attachments) {
      const f = await get<FileRow>("files", a.id);
      if (f?.text && docs.length + f.text.length < 150_000) docs = `<attached_file name="${f.name.replace(/"/g, "'")}"${f.pages ? ` pages="${f.pages}"` : ""}>\n${f.text}\n</attached_file>\n\n` + docs;
    }
  }
  const system = BASE_SYSTEM + "\n" + nowContext() + (s.system_prompt ? "\n\n" + s.system_prompt : "") +
    (docs ? "\n\nFiles the user attached earlier in this chat:\n\n" + docs : "");
  return [{ role: "system", content: system }, ...out.reverse()];
}

const DATE_Q = /\b(date|day|today|time|year|month|tarikh|tareekh|din|samay|kitne baje|aaj)\b|तारीख|दिन|समय|आज|कितने बजे/i;

/** Demo content for "make a PDF of …" so the PDF feature can be tried without a real AI. */
function demoDocument(q: string): string {
  if (/quiz|question|mcq|test/i.test(q)) {
    const n = Math.min(30, Math.max(1, Number(q.match(/\b(\d{1,2})\b/)?.[1] || 10)));
    const items = [
      ["What is the SI unit of force?", ["Joule", "Newton", "Watt", "Pascal"], 1],
      ["Which planet is known as the Red Planet?", ["Venus", "Jupiter", "Mars", "Mercury"], 2],
      ["What is $\\frac{3}{4} + \\frac{1}{4}$?", ["$1$", "$\\frac{1}{2}$", "$\\frac{4}{8}$", "$2$"], 0],
      ["भारत की राजधानी क्या है?", ["मुंबई", "नई दिल्ली", "कोलकाता", "चेन्नई"], 1],
      ["Water boils at sea level at:", ["90 °C", "100 °C", "110 °C", "120 °C"], 1],
      ["Solve for $x$: $2x + 6 = 14$", ["$x = 3$", "$x = 4$", "$x = 5$", "$x = 10$"], 1],
    ] as const;
    let out = `# Practice Quiz (${n} questions)\n\n_Demo questions from the offline demo — connect a real AI for questions on your topic._\n\n`;
    for (let i = 0; i < n; i++) {
      const [qq, opts] = items[i % items.length];
      out += `${i + 1}. ${qq}\n${opts.map((o, j) => `    - (${"abcd"[j]}) ${o}`).join("\n")}\n`;
    }
    out += "\n## Answer key\n\n" + Array.from({ length: n }, (_, i) => `${i + 1}. (${"abcd"[items[i % items.length][2]]})`).join(" · ") + "\n\n";
    return out;
  }
  return "# A Paragraph on Artificial Intelligence\n\nArtificial intelligence (AI) is the ability of computers to learn from data and solve problems that once needed human thinking. " +
    "It helps doctors read scans, farmers predict rain, and students practise with instant feedback. A simple idea behind many AI systems is fitting a function: " +
    "given examples $(x_i, y_i)$, the model chooses parameters that make the error $\\sum_i (y_i - \\hat{y}_i)^2$ as small as possible. " +
    "आज AI हमारे फ़ोन, बैंक और स्कूलों में हर जगह है, इसलिए इसे समझदारी से इस्तेमाल करना ज़रूरी है।\n\n";
}

/** "plot y = x^2 and sin x", "graph of x^2 + y^2 = 25", "3d plot of sin(x) cos(y)": the demo draws these itself. */
export function demoPlot(q: string): string | null {
  if (!/\b(plot|graph|draw|sketch|visuali[sz]e)\b/i.test(q) || /\bpdf\b/i.test(q)) return null;
  if (/^\s*(what|why|how|who|when|explain|define|meaning)\b/i.test(q) && !/[=^()]|\b(sin|cos|tan|log|sqrt|x)\b/i.test(q)) return null;   // a question about graphs
  const want3d = /\b3\s*-?d\b|three[- ]dimensional|surface/i.test(q);
  let body = q.replace(/^.*?\b(plot|graph|draw|sketch|visuali[sz]e)\b\s*(the\s+)?(graph\s+)?(of\s+)?/i, "")
    .replace(/\b(in\s+)?(3\s*-?d|2\s*-?d|three[- ]dimensional|two[- ]dimensional)\b/gi, " ")
    .replace(/\b(the|function|equation|curve|surface|please|for me|graph|plot|of|and also)\b/gi, (m) => (/^(and also)$/i.test(m) ? " and " : " "))
    .replace(/[?.!]+\s*$/, "").trim();
  const pieces = body.split(/\s+and\s+|\s*;\s*|\n/i).flatMap((p) => (/=|<|>/.test(p) ? splitOutsideBrackets(p) : [p])).map((p) => p.trim()).filter(Boolean);
  const lines: string[] = [];
  for (const p of pieces) {
    let line = p;
    const s = parseSpec(line);
    if (!s.items.length) continue;
    if (!/[=<>]/.test(line) && (s.dim === 3 || (want3d && s.items.every((i) => i.kind === "fx")))) line = `z = ${line}`;
    lines.push(line);
  }
  if (!lines.length) {
    body = "";
    lines.push(...(want3d ? ["z = sin(x) * cos(y)"] : ["y = sin(x)", "y = x^2 / 4 - 2"]));
  }
  const spec = parseSpec(lines.join("\n"));
  const named = body ? `**${lines.join("**, **")}**` : "two example functions";
  return `Here's the ${spec.dim === 3 ? "3D " : ""}graph of ${named}:\n\n\`\`\`plot\n${lines.join("\n")}\n\`\`\`\n\n` +
    (spec.dim === 3 ? "Drag to rotate it, pinch or scroll to zoom." : "Tap or drag along a curve to read coordinates; roots, turning points and intercepts are marked. Pinch or scroll to zoom.") +
    "\n\n_The offline demo draws the graph on your phone. For an explanation of the function, connect a real AI in **Settings → Connection**._";
}

function splitOutsideBrackets(s: string): string[] {
  // "y = x^2, y = 2x" → two; but keep "x = cos t, y = sin t" (parametric) and "max(x, 1)" together
  if (/^\s*x\s*=.*,\s*y\s*=/i.test(s)) return [s];
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const c of s) {
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "," && depth === 0) { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out;
}

async function* echoStream(messages: ChatMsg[], temperature: number, signal: AbortSignal): AsyncGenerator<string> {
  const last = messages[messages.length - 1].content;
  const text = typeof last === "string" ? last : last.map((p) => p.text || "").join(" ");
  const q = text.split("\n\n<attached_file")[0].trim();
  const files = (text.match(/<attached_file/g) || []).length;
  let reply: string;
  const plot = demoPlot(q);
  if (plot) {
    reply = plot;
  } else if (DATE_Q.test(q) && !/code|table/i.test(q)) {
    const d = new Date();
    reply = `Today is **${d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}**, and the time is **${d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}** (from your device's clock).\n\n`;
  } else {
    reply = `I'm the **offline demo**, not a real AI, so I can't answer “${q.slice(0, 120)}”.\n\n`;
    reply += "**To get real answers:** open **Settings → Connection**, choose **Google Gemini — free key**, paste a free key from Google AI Studio, tap **Test connection**, then **Save**.\n\n";
  }
  if (files) {
    const body = (text.split("<attached_file")[1] || "").replace(/^[^>]*>/, "");
    const pages = text.match(/<attached_file[^>]*pages="(\d+)"/)?.[1];
    const first = body.split("\n").map((l) => l.trim()).find((l) => l && !/^--- Page \d+ ---$/.test(l) && !/^\(PDF, \d+ page/.test(l)) || "";
    reply += `I can see ${files} attached file(s)${pages ? ` (a PDF with ${pages} page${pages === "1" ? "" : "s"}, read on your phone)` : ""}. First line: \`${first.slice(0, 80).replace(/`/g, "'")}\`\n\n`;
  }
  if (/code/i.test(q)) reply += "Here's how code looks:\n\n```python\ndef greet(name: str) -> str:\n    return f\"Namaste, {name}!\"\n\nprint(greet(\"zenvqo\"))\n```\n\n";
  if (/\bpdf\b/i.test(q) && !files) reply += demoDocument(q);
  if (/math|equation|formula|ganit/i.test(q) && !/\bpdf\b/i.test(q)) reply += "Here's how math looks — inline $E = mc^2$ and $a^2 + b^2 = c^2$, and displayed:\n\n$$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$\n\n$$\\int_0^1 x^2\\,dx = \\frac{1}{3} \\qquad \\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}$$\n\n";
  if (/table/i.test(q)) reply += "| Model | Size |\n|---|---|\n| zenvqo | 3B |\n| echo | 0B |\n\n";
  reply += `(_demo · ${messages.length - 2} earlier message(s) in context · temperature ${temperature}_)`;
  const toks = reply.match(/[^\s]*\s*/g)!.filter(Boolean);
  const step = toks.length > 300 ? 12 : 1;                          // long demo replies (documents) arrive in bigger chunks
  for (let i = 0; i < toks.length; i += step) {
    if (signal.aborted) return;
    if (q.includes("[fail]") && i === 6) throw new ApiError(502, "The demo model failed on purpose ([fail] in your message).", undefined, "demo_failure");
    await new Promise((r) => setTimeout(r, step > 1 ? 16 : 20));
    yield toks.slice(i, i + step).join("");
  }
}

/** Big answers (whole projects) can run past a model's output limit: when the reply stops for that reason, ask the model
 * to carry on from the exact spot, up to a few times, and join the parts into one reply. */
const CONTINUE = "Your previous reply was cut off by the length limit. Continue exactly where it stopped: don't repeat anything, " +
  "don't add an introduction, and if you stopped inside a code block, just continue the code (don't start a new code block).";
async function* longStream(model: string, messages: ChatMsg[], s: UserSettings, signal: AbortSignal, maxParts = 10): AsyncGenerator<string> {
  let sofar = "";
  for (let part = 0; part < maxParts; part++) {
    const info: { finish?: string } = {};
    const msgs = part === 0 ? messages : [...messages, { role: "assistant", content: sofar }, { role: "user", content: CONTINUE }];
    // the start of a continuation is held back a moment: if the model reopened the code block it was in, drop that line
    const insideCode = part > 0 && (sofar.match(/^```/gm) || []).length % 2 === 1;
    let head = part > 0 ? "" : null as string | null;
    const fix = (h: string) => (insideCode ? h.replace(/^\s*```[\w+#.-]*[ \t]*\n/, "") : h);
    for await (const t of serverStream(model, msgs, s, signal, info)) {
      if (head !== null) {
        head += t;
        if (head.length < 40 && !head.includes("\n")) continue;
        const out = fix(head);
        head = null;
        sofar += out;
        yield out;
        continue;
      }
      sofar += t;
      yield t;
    }
    if (head) { const out = fix(head); sofar += out; yield out; }
    if (signal.aborted || info.finish !== "length") return;
  }
}

async function* serverStream(model: string, messages: ChatMsg[], s: UserSettings, signal: AbortSignal, info: { finish?: string } = {}): AsyncGenerator<string> {
  const b = base(s);
  if (!b) throw new ApiError(400, "No model server set. Open Settings → Connection.", undefined, "config");
  let r: Response;
  try {
    r = await net(b + "/chat/completions", { method: "POST", signal, headers: headers(s),
      body: JSON.stringify({ model, messages, stream: true, temperature: s.temperature }) });
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    throw new ApiError(0, `Can't reach the model server at ${b}. Is it running and reachable from this device?`, undefined, "unreachable");
  }
  if (r.status === 401 || r.status === 403) throw new ApiError(401, "The AI service rejected the API key. Check it in Settings → Connection.", undefined, "auth");
  if (!r.ok || !r.body) {
    const body = await r.json().catch(() => null);
    throw new ApiError(r.status, errorMessage(r.status, body) || `The model server returned ${r.status}.`);
  }
  const queue: string[] = [];
  let done = false;
  const p = createSSEParser(({ data }) => {
    if (data === "[DONE]") { done = true; return; }
    try {
      const d = JSON.parse(data);
      if (d.error) throw new ApiError(502, d.error.message || "The model reported an error.");
      const t = d.choices?.[0]?.delta?.content;
      if (t) queue.push(t);
      const fin = d.choices?.[0]?.finish_reason;
      if (fin) info.finish = fin === "max_tokens" ? "length" : fin;
    } catch (e) { if (e instanceof ApiError) throw e; }
  });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  try {
    while (!done) {
      const { done: end, value } = await reader.read();
      if (end) break;
      p.feed(dec.decode(value, { stream: true }));
      while (queue.length) yield queue.shift()!;
    }
    p.end();
    while (queue.length) yield queue.shift()!;
  } catch (e) {
    if ((e as Error).name === "AbortError" || signal.aborted) return;
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, "The connection to the model dropped mid-reply.", undefined, "network");
  }
}


// ---------------- images ----------------
/** Which engines to use, best first. A Gemini/OpenAI key from Settings → Connection is tried first; the free
 * Pollinations service always comes last, so pictures work without any key (and in the offline demo, given internet). */
export function imageEngines(s: UserSettings): ("gemini" | "openai" | "pollinations")[] {
  const b = base(s);
  const out: ("gemini" | "openai" | "pollinations")[] = [];
  if (s.api_key && /generativelanguage\.googleapis\.com/.test(b)) out.push("gemini");
  if (s.api_key && /api\.openai\.com/.test(b)) out.push("openai");
  out.push("pollinations");
  return out;
}

/** Gemini keys that turned out to have no image quota are remembered for a while, so we don't ask again every time. */
const NO_QUOTA_KEY = "zc.images.noquota";
function quotaKnownEmpty(key: string): boolean {
  try { const v = JSON.parse(localStorage.getItem(NO_QUOTA_KEY) || "{}"); return v.k === key.slice(-8) && Date.now() - v.t < 6 * 3600_000; } catch { return false; }
}
function rememberNoQuota(key: string) { try { localStorage.setItem(NO_QUOTA_KEY, JSON.stringify({ k: key.slice(-8), t: Date.now() })); } catch { /* private */ } }

/** All images in a conversation, numbered the way the chat shows them (#1, #2, …). */
async function conversationImages(cid: string): Promise<{ n: number; file: FileRow; msg: MsgRow }[]> {
  const out: { n: number; file: FileRow; msg: MsgRow }[] = [];
  for (const m of await messagesOf(cid)) {
    for (const a of m.attachments) {
      if (a.kind !== "image") continue;
      const f = await get<FileRow>("files", a.id);
      if (f?.dataUrl) out.push({ n: out.length + 1, file: f, msg: m });
    }
  }
  return out;
}

/** "remove the background" without an image editor: re-imagine an AI-made picture from its own description. */
function reimagine(prompt: string, plan: Plan): string {
  switch (plan.op) {
    case "remove_background": return `${prompt}, isolated subject on a plain pure white background`;
    case "replace_background": return `${prompt}, with the background replaced by ${plan.background || plan.prompt}`;
    case "remove_object": return `${prompt}, without any ${plan.prompt}`;
    case "style": return prompt;                                    // style is applied by the style setting
    case "variations": return prompt;
    case "replace_object": return `${prompt}, with ${plan.prompt}${plan.target ? ` instead of the ${plan.target}` : ""}`;
    default: return `${prompt}, ${plan.prompt}`;
  }
}


/** A short description of a picture from the chat's own AI (when it can see images), for re-drawing it with the
 * free image service: image-to-image, references, and keeping the same character. */
async function describeImage(dataUrl: string, modelId: string, s: UserSettings, focus: "all" | "subject" | "style", signal: AbortSignal): Promise<string | null> {
  if (!modelId.startsWith("srv:") || !base(s)) return null;
  const ask = focus === "style"
    ? "Describe only the visual style of this picture (medium, colours, lighting, mood, rendering) in one sentence, as keywords for an image generator. No subject."
    : focus === "subject"
      ? "Describe the main character or object in this picture so an artist could draw exactly the same one again: species/person, face, hair, body, clothes, colours, distinctive marks. One dense sentence, no background."
      : "Describe this picture for an image generator in one dense sentence: subject, appearance, setting, composition, colours, lighting, style.";
  try {
    const r = await net(base(s) + "/chat/completions", { method: "POST", signal, headers: headers(s), body: JSON.stringify({
      model: modelId.replace(/^srv:/, ""), stream: false, temperature: 0.2, max_tokens: 200,
      messages: [{ role: "user", content: [{ type: "text", text: ask }, { type: "image_url", image_url: { url: dataUrl } }] }] }) });
    if (!r.ok) return null;
    const j = await r.json() as { choices?: { message?: { content?: string } }[] };
    const t = (j.choices?.[0]?.message?.content || "").replace(/\s+/g, " ").trim().replace(/^["']|["']$/g, "");
    return t.length > 8 ? t.slice(0, 600) : null;
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    return null;
  }
}

interface Pic { n: number; file: FileRow }
interface ProduceCtx {
  op: ImageOp; plan: Plan; job: ImageJob; source?: Pic; refs: Pic[];
  s: UserSettings; modelId: string; signal: AbortSignal; notes: Set<string>;
  progress: (f: number, t: string) => void;
}

function local(dataUrl: string, w: number, h: number): MadeImage {
  return { dataUrl, mime: dataUrl.startsWith("data:image/png") ? "image/png" : "image/jpeg", width: w, height: h, engine: "on-device", model: "canvas", notes: [] };
}
async function localImg(dataUrl: string): Promise<MadeImage> { const { width, height } = await measure(dataUrl); return local(dataUrl, width, height); }

const NEEDS_EDITOR = "Changing your own photos this way needs an image editor: in Settings → Connection use a Google Gemini key with billing turned on " +
  "(Google doesn't include image editing on free keys) or an OpenAI key. ";

/** Make one picture for a request: a keyed engine (Gemini / OpenAI) first, then the free route — the free image
 * service plus the on-phone tools in images/canvas.ts. */
async function produce(c: ProduceCtx): Promise<MadeImage> {
  const { op, plan, job, source, refs, s, modelId, signal, notes } = c;
  const src = source?.file.dataUrl;
  // the picture maker for the free route: this phone (once its model is downloaded), else the free online service
  const dev: DeviceModel | null = s.image_engine === "online" ? null : deviceModel(s.device_model);
  const onPhone = (j: Partial<ImageJob>) => device({ ...job, ...j } as ImageJob, { model: dev!, quality: s.device_quality }, signal, c.progress);
  const online = (j: Partial<ImageJob>) => pollinations({ ...job, ...j, op: "generate" } as ImageJob, net, signal, c.progress);
  const free = async (j: Partial<ImageJob>): Promise<MadeImage> => {
    if (!dev) {
      if (s.image_engine === "device") throw new ImageEngineError("Pictures are set to be made only on this phone, but the picture model isn't downloaded yet. " +
        "Open Settings → Pictures on this phone and tap Download.", "unsupported");
      return online(j);
    }
    try { return await onPhone({ ...j, op: "generate", source: undefined, mask: undefined }); }
    catch (err) {
      if ((err as Error).name === "AbortError" || s.image_engine === "device") throw err;
      notes.add("Making it on your phone didn't work this time, so the free online service made it.");
      return online(j);
    }
  };

  // made on the phone, always
  if (op === "upscale") {
    if (!src) throw new ImageEngineError("There's no picture to enlarge.", "failed");
    const want = Math.max(job.resolution >= 1536 ? job.resolution : 2048, 1024);
    const u = await upscale(src, want);
    notes.add("Enlarged on your phone with careful resampling and sharpening — it's bigger and crisper, but no new detail is invented.");
    return local(u.dataUrl, u.w, u.h);
  }
  if (op === "remove_object" && src && job.mask && !imageEngines(s).some((e) => e !== "pollinations")) {
    return localImg(await fillArea(src, job.mask));
  }

  // keyed engines (not when pictures should be made only on this phone)
  let lastErr: ImageEngineError | null = null;
  for (const e of s.image_engine === "device" ? [] : imageEngines(s)) {
    if (e === "pollinations") break;
    try {
      if (e === "gemini" && quotaKnownEmpty(s.api_key || "")) { lastErr = new ImageEngineError("no quota", "quota"); continue; }
      let j = job;
      if (op === "outpaint" && src) { const p = await padFor(src, plan.aspect_ratio || null, (plan.side || "center") as Side); j = { ...job, source: p.padded, mask: p.mask }; }
      return e === "gemini" ? await gemini(j, s.api_key || "", net, signal) : await openai(j, base(s), s.api_key || "", net, signal);
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      const ie = err instanceof ImageEngineError ? err : new ImageEngineError("The image couldn't be made.", "failed");
      if (e === "gemini" && ie.code === "quota") {
        rememberNoQuota(s.api_key || "");
        notes.add("Your Gemini key can't make images (Google offers its image model only with billing turned on), so the free route made this one.");
      }
      if (ie.code === "blocked") throw ie;
      lastErr = ie;
    }
  }

  // ---- free route ----
  const made = source?.file.meta?.prompt as string | undefined;          // AI-made pictures carry their own description
  const seedOf = (p?: Pic) => (plan.fresh ? job.seed : (p?.file.meta?.seed as number | undefined) ?? job.seed);
  let described: string | null | undefined;
  const scene = async () => {
    if (made) return made;
    if (described === undefined) { c.progress(0.05, "Looking at the picture…"); described = src ? await describeImage(src, modelId, s, "all", signal) : null; }
    return described;
  };
  const srcAspect = source?.file.meta?.aspect_ratio as string | undefined || (source?.file.width && source.file.height ? nearestAspect(source.file.width, source.file.height) : job.aspect);
  const redraw = async (prompt: string, extra: Partial<ImageJob> = {}) => {
    const img = await free({ prompt, seed: seedOf(source), aspect: srcAspect, ...extra });
    notes.add(made ? "The free image service can't edit a picture directly, so this is a new version drawn from the original description — small details can change."
      : "This was redrawn from a description of your picture by the free image service, so it's a close new version, not an exact edit. A Gemini (billing on) or OpenAI key edits the photo itself.");
    return img;
  };
  // the phone's engine edits the picture itself (image-to-image, painted areas, expanding)
  if (dev && src) {
    const keep = async (made2: MadeImage) => { notes.add("Changed on your phone."); return made2; };
    const what = async (extra = "") => [made || (await scene()) || "", extra].filter(Boolean).join(", ");
    switch (op) {
      case "style": case "edit": {
        const base0 = made || (await scene()) || "";
        return keep(await onPhone({ op, source: src, mask: job.mask, prompt: op === "edit" ? mergeEdit(base0, plan.prompt) : base0 || plan.prompt, style: job.style }));
      }
      case "variations":
        return keep(await onPhone({ op, source: src, prompt: (await what()) || plan.prompt || "the same picture" }));
      case "inpaint": case "replace_object":
        if (job.mask) return keep(await onPhone({ op, source: src, mask: job.mask, prompt: plan.prompt }));
        break;
      case "outpaint": {
        const pad = await padFor(src, plan.aspect_ratio || null, (plan.side || "center") as Side);
        const wide = await onPhone({ op: "inpaint", source: pad.padded, mask: pad.mask, prompt: await what(plan.prompt ? plan.prompt : "wide view, the scene continues") });
        const big = await upscale(wide.dataUrl, Math.max(pad.w, pad.h));
        return keep({ ...(await localImg(await placeOn(big.dataUrl, src, (plan.side || "center") as Side, pad.w, pad.h))), engine: wide.engine, model: wide.model });
      }
    }
  }
  const needDesc = () => new ImageEngineError(NEEDS_EDITOR + "Or pick a chat model that can see pictures, and I'll redraw it from a description.", "unsupported");

  switch (op) {
    case "generate": {
      let prompt = plan.prompt;
      let seed = job.seed;
      for (const r of refs) {
        const isMade = !!r.file.meta?.prompt;
        if (plan.refMode === "style") {
          const st = await describeImage(r.file.dataUrl!, modelId, s, "style", signal) || (isMade ? `same art style as: ${r.file.meta!.prompt}` : null);
          if (st) prompt += `, in this visual style: ${st}`;
        } else {
          const who = (isMade ? (r.file.meta!.subject as string | undefined) : undefined) || await describeImage(r.file.dataUrl!, modelId, s, "subject", signal) || (isMade ? (r.file.meta!.prompt as string) : null);
          if (who) { prompt = `${prompt}. The main character/object, exactly as before: ${who}`; if (isMade && !plan.fresh) seed = r.file.meta!.seed as number ?? seed; }
          else notes.add("I couldn't look at the reference picture (the current chat model can't see images), so it may not match exactly.");
        }
      }
      if (refs.length) notes.add(plan.refMode === "style" ? "Made following the style of your reference picture." : "Kept the same character / object by describing it and reusing its settings — the free service can drift a little; a Gemini or OpenAI key follows references more exactly.");
      if (plan.text) {
        const img = await free({ prompt, seed, noText: true, text: undefined });
        const out = await drawText(img.dataUrl, plan.text, plan.textLayout || "poster");
        notes.add(`The words "${plan.text}" were set on the picture by the app, so the spelling is exact.`);
        return { ...(await localImg(out)), engine: img.engine, model: img.model };
      }
      return free({ prompt, seed });
    }
    case "variations": {
      const p = made || plan.prompt || await scene();
      if (!p) throw needDesc();
      return free({ prompt: p, aspect: src ? srcAspect : job.aspect });
    }
    case "style": case "edit": {
      const p = await scene();
      if (!p) throw needDesc();
      return redraw(reimagine(p, plan));
    }
    case "remove_background": case "replace_background": {
      if (!src) throw new ImageEngineError("There's no picture to change.", "failed");
      c.progress(0.1, "Cutting out the subject…");
      let cut = await cutOut(src);
      if (!cut.uniform) {                                               // busy background: redraw the subject on white, then cut
        const p = await scene();
        if (!p) {
          notes.add("The background is busy, so the cut-out edges may be rough. For a clean result use a Gemini (billing on) or OpenAI key.");
        } else {
          const white = await free({ prompt: `${p}, isolated subject centred on a plain pure white studio background, no shadows`, seed: seedOf(source), aspect: srcAspect, style: job.style });
          cut = await cutOut(white.dataUrl);
          notes.add("The subject was redrawn on a plain background and cut out, so small details can differ from the original.");
        }
      }
      if (op === "remove_background") return localImg(cut.dataUrl);
      const { width, height } = await measure(cut.dataUrl);
      c.progress(0.5, "Making the new background…");
      const bg = await free({ prompt: `${plan.background || plan.prompt}, background scenery, no people, no main subject`, aspect: nearestAspect(width, height) });
      return { ...(await localImg(await composite(cut.dataUrl, bg.dataUrl, width, height))), engine: bg.engine, model: bg.model };
    }
    case "remove_object": {
      if (src && job.mask) return localImg(await fillArea(src, job.mask));
      if (made) return redraw(reimagine(made, plan));
      throw new ImageEngineError("To remove something from your own photo, tap the picture, choose the brush, paint over what should go, and send — the app fills that area itself. " +
        "(Or use a Gemini key with billing on, or an OpenAI key, to remove things just by describing them.)", "unsupported");
    }
    case "inpaint": case "replace_object": {
      if (src && job.mask) {
        const ctx = await scene();
        const patch = await free({ prompt: `${plan.prompt}${ctx ? `, in a scene like: ${ctx}` : ""}`, aspect: srcAspect, seed: job.seed });
        notes.add("The painted area was filled with newly drawn content and blended in on your phone.");
        return { ...(await localImg(await blendUnder(src, patch.dataUrl, job.mask))), engine: patch.engine, model: patch.model };
      }
      const p = await scene();
      if (!p) throw new ImageEngineError(NEEDS_EDITOR + "Or tap the picture, use the brush to paint the area, and describe what should go there.", "unsupported");
      const swap = plan.target && new RegExp(`\\b${plan.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(p)
        ? p.replace(new RegExp(`\\b${plan.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"), plan.prompt) : reimagine(p, { ...plan, op: "edit", prompt: plan.target ? `with ${plan.prompt} instead of ${plan.target}` : plan.prompt });
      return redraw(swap);
    }
    case "outpaint": {
      if (!src) throw new ImageEngineError("There's no picture to expand.", "failed");
      const pad = await padFor(src, plan.aspect_ratio || null, (plan.side || "center") as Side);
      const p = await scene();
      if (p) {
        c.progress(0.2, "Drawing the wider scene…");
        const wide = await free({ prompt: `${p}${plan.prompt ? `, ${plan.prompt}` : ""}, wide view, the scene continues`, aspect: nearestAspect(pad.w, pad.h), seed: seedOf(source) });
        notes.add("The original picture is kept exactly; the new area around it was drawn by the free image service and blended in.");
        return { ...(await localImg(await placeOn(wide.dataUrl, src, (plan.side || "center") as Side, pad.w, pad.h))), engine: wide.engine, model: wide.model };
      }
      notes.add("The new area continues the picture's colours softly. For real new scenery use a Gemini (billing on) or OpenAI key, or a chat model that can see pictures.");
      return local(pad.padded, pad.w, pad.h);
    }
  }
  throw lastErr || new ImageEngineError("The image couldn't be made.", "failed");
}

const COLOURS = /\b(red|green|blue|yellow|orange|purple|violet|pink|black|white|grey|gray|brown|golden|gold|silver|teal|cyan|magenta)\b/gi;
/** The description for an image-to-image change: the change first (it matters most), and colours the change replaces
 * taken out of the old description ("a red apple…" + "the apple green" → "the apple green, a apple…"). */
export function mergeEdit(base: string, change: string): string {
  const c = change.trim();
  if (!base) return c;
  const b = COLOURS.test(c) ? base.replace(COLOURS, "").replace(/\s{2,}/g, " ").replace(/\s+,/g, ",") : base;
  COLOURS.lastIndex = 0;
  return `${c}, ${b.trim()}`;
}

function nearestAspect(w: number, h: number): string {
  let best = "1:1", d = Infinity;
  for (const a of ASPECTS) { const [x, y] = a.split(":").map(Number); const e = Math.abs(Math.log((x / y) / (w / h))); if (e < d) { d = e; best = a; } }
  return best;
}

const OP_DONE: Record<string, string> = {
  edit: "Here's the changed image", style: "Here it is in the new style", variations: "Here are some variations",
  remove_background: "Here it is without the background", replace_background: "Here it is with the new background",
  remove_object: "Here it is with that removed", inpaint: "Here's the image with the painted area changed",
  replace_object: "Here it is with that replaced", outpaint: "Here's the expanded image", upscale: "Here's the larger version",
};

async function runImageTurn(cid: string, modelId: string, userMsg: Message | null, plan: Plan, opts: ImageOptions | undefined,
                            h: StreamHandlers, signal: AbortSignal, row?: MsgRow) {
  const s = loadSettings();
  const own = !row;
  if (!row) {
    row = { id: uid("msg"), conversation_id: cid, role: "assistant", content: "", model: modelId, status: "streaming", error: null, attachments: [], created_at: now() + 0.001 };
    await put("messages", row);
    h.onMeta?.({ user_message: userMsg, assistant_message: { id: row.id, model: modelId } });
  }
  const say = async (t: string) => { row!.content += t; h.onDelta(t); };
  const op = (opts?.op || plan.op) as ImageOp;
  const tool = op === "generate" ? "generate_image" : "edit_image";
  try {
    if (plan.clarify) { await say(plan.clarify); row.status = "complete"; h.onDone?.({ status: "complete", title: await titleIfNew(cid) }); return; }
    // the picture to change, when changing one
    let source: { n: number; file: FileRow } | undefined;
    if (op !== "generate") {
      const imgs = await conversationImages(cid);
      if (opts?.source_id) source = imgs.find((x) => x.file.id === opts.source_id);
      else if (plan.image_ref.startsWith("#")) source = imgs.find((x) => x.n === +plan.image_ref.slice(1));
      else if (plan.image_ref === "attached" && userMsg) source = [...imgs].reverse().find((x) => x.msg.id === userMsg.id);
      source = source || imgs[imgs.length - 1];
      if (!source) { await say("There's no picture in this chat to change yet. Attach a photo or ask me to create one first."); row.status = "complete"; h.onDone?.({ status: "complete", title: await titleIfNew(cid) }); return; }
    }
    const blocked = safetyCheck(`${plan.prompt} ${plan.background || ""}`, !!source && !source.file.generated);
    if (blocked) { h.onTool?.({ name: tool, op, status: "failed", code: "blocked" }); await say(blocked); row.status = "complete"; h.onDone?.({ status: "complete", title: await titleIfNew(cid) }); return; }

    const n = Math.max(1, Math.min(4, opts?.n ?? plan.n ?? (op === "variations" ? 3 : 1)));
    const style = opts?.style ?? plan.style ?? (op === "style" ? undefined : source?.file.meta?.style);
    const aspect = opts?.aspect_ratio ?? plan.aspect_ratio ?? source?.file.meta?.aspect_ratio ?? "1:1";
    const seed0 = opts?.seed ?? plan.seed ?? Math.floor(Math.random() * 1e9);
    let mask: string | undefined;
    if (opts?.mask_id) mask = (await get<FileRow>("files", opts.mask_id))?.dataUrl;
    // pictures to follow (reference / same character)
    const refs: Pic[] = [];
    if (op === "generate" && plan.references?.length) {
      const imgs = await conversationImages(cid);
      for (const r of plan.references) {
        const hit = r === "attached" && userMsg ? [...imgs].reverse().find((x) => x.msg.id === userMsg.id)
          : r.startsWith("#") ? imgs.find((x) => x.n === +r.slice(1))
          : r === "last-made" ? [...imgs].reverse().find((x) => x.file.generated) : imgs[imgs.length - 1];
        if (hit && !refs.some((x) => x.file.id === hit.file.id)) refs.push(hit);
      }
    }
    const notes = new Set<string>();
    let made = 0;
    h.onTool?.({ name: tool, op, status: "running" });
    for (let i = 0; i < n; i++) {
      if (signal.aborted) break;
      h.onProgress?.({ fraction: i / n, text: n > 1 ? `Making image ${i + 1} of ${n}…` : op === "generate" ? "Making your image…" : "Changing the image…" });
      const job: ImageJob = { op, prompt: plan.prompt, style, aspect, resolution: opts?.resolution ?? plan.resolution ?? 1024, seed: seed0 + i * 7919,
        negative: opts?.negative_prompt ?? plan.negative_prompt, source: source?.file.dataUrl, mask, background: plan.background,
        references: refs.map((r) => r.file.dataUrl!), refMode: plan.refMode, text: plan.text, target: plan.target };
      let img: MadeImage = await produce({ op, plan, job, source, refs, s, modelId, signal, notes,
        progress: (f, t) => h.onProgress?.({ fraction: (i + f) / n, text: t }) });
      // asked for a bigger picture than the engine gave: enlarge on the phone
      if (op !== "upscale" && (opts?.resolution ?? plan.resolution) && job.resolution > Math.max(img.width, img.height) * 1.15) {
        const u = await upscale(img.dataUrl, job.resolution);
        img = { ...img, dataUrl: u.dataUrl, mime: "image/png", width: u.w, height: u.h };
        notes.add(`The image service returned a smaller picture, so it was enlarged on your phone to ${u.w}×${u.h}.`);
      }
      img.notes.forEach((x) => notes.add(x));
      const id = uid("fil");
      const ext = img.mime === "image/png" ? "png" : img.mime === "image/webp" ? "webp" : "jpg";
      const keep = op === "upscale" || op === "outpaint" || op === "remove_background";
      const meta = { op, prompt: op === "generate" ? plan.prompt : source?.file.meta?.prompt ? (keep ? source.file.meta.prompt : reimagine(source.file.meta.prompt, plan)) : plan.prompt,
        subject: (op === "generate" ? (refs[0]?.file.meta?.subject as string | undefined) : (source?.file.meta?.subject as string | undefined)) || (op === "generate" ? plan.prompt : undefined),
        text: plan.text,
        seed: job.seed, provider: img.engine, model: img.model, parent_id: source?.file.id ?? null, style, aspect_ratio: op === "outpaint" ? nearestAspect(img.width, img.height) : aspect, negative_prompt: job.negative };
      const f: FileRow = { id, name: `image-${id.slice(-6)}.${ext}`, mime: img.mime, size: Math.round(img.dataUrl.length * 0.75), kind: "image",
        dataUrl: img.dataUrl, generated: true, width: img.width, height: img.height, meta, created_at: now() };
      await put("files", f);
      pictures.set(id, img.dataUrl);
      const att: Attachment = { id, name: f.name, mime: f.mime, size: f.size, kind: "image", generated: true, width: img.width, height: img.height, meta };
      row.attachments.push(att);
      await put("messages", row);
      h.onImage?.(att);
      made++;
    }
    if (signal.aborted && !made) { row.status = "stopped"; return; }
    h.onTool?.({ name: tool, op, status: "done" });
    h.onProgress?.({ fraction: 1, text: "" });
    const what = op === "generate" ? `Here ${made > 1 ? `are ${made} images` : "is your image"} of **${plan.prompt.replace(/\*/g, "")}**.`
      : `${OP_DONE[op] || "Here's the changed image"}${source ? ` (from image #${source.n})` : ""}.`;
    await say(what + (notes.size ? "\n\n" + [...notes].map((x) => `_${x}_`).join("\n\n") : ""));
    row.status = "complete";
    h.onDone?.({ status: "complete", title: await titleIfNew(cid) });
  } catch (e) {
    if ((e as Error).name === "AbortError") { row.status = row.attachments.length ? "complete" : "stopped"; return; }
    h.onTool?.({ name: tool, op, status: "failed" });
    const msg = e instanceof ImageEngineError ? e.message : "The image couldn't be made.";
    if (e instanceof ImageEngineError && (e.code === "blocked" || e.code === "unsupported")) {
      await say(msg);                                                   // an answer, not a failure
      row.status = "complete";
      h.onDone?.({ status: "complete", title: await titleIfNew(cid) });
    } else {
      if (!(e instanceof ImageEngineError)) console.error("image failed:", e);
      row.status = "error";
      row.error = msg;
      h.onError?.(new ApiError(502, msg, undefined, "image_failed"));
    }
  } finally {
    if (own) {
      await put("messages", row);
      const c = await get<Conversation>("conversations", cid);
      if (c) await put("conversations", { ...c, updated_at: now() });
    }
  }
}

/** A new chat's name: its first message, shortened — a "Learn as a book" chat is named after its topic. */
function titleFrom(text: string): string {
  let w = text.split(/\s+/).join(" ");
  if (isBookRequest(w)) {
    const topic = w.slice((isDeepRequest(w) ? DEEP_PREFIX : BOOK_PREFIX).length).trim();
    w = (isDeepRequest(w) ? "Book in depth: " : "Book: ") + topic.charAt(0).toUpperCase() + topic.slice(1);
  }
  return w.length > 60 ? w.slice(0, 60).replace(/\s+\S*$/, "") + "…" : w;
}

async function titleIfNew(cid: string): Promise<string | null> {
  const c = await get<Conversation>("conversations", cid);
  if (!c || c.title !== "New chat") return null;
  const first = (await messagesOf(cid)).find((m) => m.role === "user");
  if (!first) return null;
  const title = titleFrom(first.content);
  await put("conversations", { ...c, title, updated_at: now() });
  return title;
}

/** Should this message make or change a picture? */
async function imagePlan(cid: string, text: string, atts: Attachment[], opts?: ImageOptions): Promise<Plan | null> {
  const msgs = await messagesOf(cid);
  const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
  const hasImages = msgs.some((m) => m.attachments.some((a) => a.kind === "image")) || atts.some((a) => a.kind === "image");
  if (!opts?.op && isBookMessage(text)) return null;                                     // "Learn as a book" pages are text
  if (opts?.op) {
    const auto = detect(text, { attachedImage: atts.some((a) => a.kind === "image"), hasImages, lastReplyHasImage: true });
    const prompt = opts.op === "generate" ? (auto?.op === "generate" ? auto.prompt : text.trim()) : (auto?.prompt || text.trim());
    return { ...(auto || {}), op: opts.op, prompt, image_ref: opts.source_id ? "id" : auto?.image_ref || "latest", clarify: undefined, background: auto?.background || (opts.op === "replace_background" ? text.trim() : undefined) };
  }
  return detect(text, { attachedImage: atts.some((a) => a.kind === "image"), hasImages,
    lastReplyHasImage: !!lastAssistant?.attachments.some((a) => a.kind === "image" && a.generated) });
}

/** Models known to read text only (no pictures). Anything else is assumed able to see. */
const TEXT_ONLY = /deepseek(?!.*vl)|codestral|devstral|mistral-large|ministral|magistral|qwen3-coder|qwen-?2\.5-coder|qwq|gpt-oss|gpt-3\.5|llama-3\.[13]\b|llama3[.-]?[13]\b|llama-3-|mixtral|phi-[34](?!.*(vision|multimodal))|kimi-k2(?!.*vision)|nemotron(?!.*vl)|command-r|\bo[13]-mini|compound|allam|sonar/i;
/** The best picture-reading models, first match wins (free ones first on OpenRouter). */
const VISION_PREF = [/gemini-2\.5-flash$/, /gemini-[\d.]+-flash(?!-lite)/, /gemini/, /claude-sonnet/, /claude/, /gpt-5|gpt-4\.1|gpt-4o/, /llama-4-maverick/, /llama-4/,
  /pixtral|mistral-(small|medium)/, /qwen[\d.]*-?vl|qwen.*vision/, /gemma-3/, /vision|vl\b/, /^openrouter\/free$/];
export const canSee = (id: string) => !TEXT_ONLY.test(id);
/** Models that can listen to recordings (input_audio). */
export const canHear = (id: string) => /gemini(?!.*(embed|image|tts))|gpt-4o(-mini)?-audio|gpt-audio|voxtral|omni/i.test(id);
const HEAR_PREF = [/gemini-2\.5-flash$/, /gemini-[\d.]+-flash(?!-lite)/, /gemini/, /gpt-4o-mini-audio|gpt-4o-audio|gpt-audio/, /voxtral/, /omni/];
function bestModelFor(need: { see: boolean; hear: boolean }): string | null {
  const ids = (modelCache || []).map((m) => m.id.replace(/^srv:/, "")).filter((id) => id !== "echo" && !NOT_CHAT.test(id) &&
    (!need.see || canSee(id)) && (!need.hear || canHear(id)));
  const free = ids.filter((id) => /:free$/.test(id));
  const prefs = need.hear ? HEAR_PREF : VISION_PREF;
  for (const pool of [free, ids]) for (const re of prefs) { const hit = pool.find((id) => re.test(id)); if (hit) return hit; }
  return null;
}

async function runTurn(cid: string, modelId: string, userMsg: Message | null, h: StreamHandlers, signal: AbortSignal) {
  const s = loadSettings();
  const vision = modelId.startsWith("srv:");
  let history = await buildHistory(cid, s, vision);
  // photos (or pictures from files/videos) or recordings the chosen model can't take: use this service's best model that can
  const parts = history.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
  const need = { see: parts.some((p) => p.type === "image_url"), hear: parts.some((p) => p.type === "input_audio") };
  const fits = (id: string) => (!need.see || canSee(id)) && (!need.hear || canHear(id));
  if (vision && (need.see || need.hear) && !fits(modelId.replace(/^srv:/, ""))) {
    if (!modelCache) await api.models().catch(() => null);
    const alt = bestModelFor(need);
    if (alt) modelId = "srv:" + alt;
    else {
      const cur = modelId.replace(/^srv:/, "");
      const drop = (p: Part) => (p.type === "image_url" && !canSee(cur)) || (p.type === "input_audio" && !canHear(cur));
      const missing = [!canSee(cur) && need.see ? "pictures" : "", !canHear(cur) && need.hear ? "recordings" : ""].filter(Boolean).join(" and ");
      history = history.map((m) => {
        if (!Array.isArray(m.content) || !m.content.some(drop)) return m;
        const kept = m.content.filter((p) => !drop(p));
        const note = `\n\n(The user attached ${missing}, but the AI model in use can't take them. Answer from the text, and tell the user once that Google Gemini (in Settings → Connection) can see photos and hear recordings.)`;
        return { role: m.role, content: kept.length > 1 ? kept.map((p, i) => (i === 0 ? { ...p, text: (p.text || "") + note } : p)) : (kept[0]?.text || "") + note };
      });
    }
  }
  const aid = uid("msg");
  const row: MsgRow = { id: aid, conversation_id: cid, role: "assistant", content: "", model: modelId, status: "streaming", error: null, attachments: [], created_at: now() + 0.001 };
  await put("messages", row);
  h.onMeta?.({ user_message: userMsg, assistant_message: { id: aid, model: modelId } });
  const gen = modelId === "echo" ? echoStream(history, s.temperature, signal) : longStream(modelId.replace(/^srv:/, ""), history, s, signal);
  let lastSave = Date.now();
  try {
    for await (const t of gen) {
      row.content += t;
      h.onDelta(t);
      if (Date.now() - lastSave > 1000) { await put("messages", row); lastSave = Date.now(); }   // survive a closed tab
    }
    if (signal.aborted) { row.status = "stopped"; return; }
    // the model asked for a picture: [[image: …]]
    const mk = MARKER.exec(row.content);
    if (mk) {
      row.content = row.content.replace(MARKER, "").replace(/\n{3,}/g, "\n\n").trim() + "\n\n";
      const prompt = mk[1].trim();
      const plan: Plan = { op: "generate", prompt, image_ref: "latest", ...(() => { const d = detect(`generate an image of ${prompt}`, { attachedImage: false, hasImages: false, lastReplyHasImage: false }); return d ? { style: d.style, aspect_ratio: d.aspect_ratio } : {}; })() };
      await runImageTurn(cid, modelId, userMsg, plan, undefined, h, signal, row);
      return;
    }
    row.status = "complete";
    const c = await get<Conversation>("conversations", cid);
    let title: string | null = null;
    if (c && c.title === "New chat") {
      const first = (await messagesOf(cid)).find((m) => m.role === "user");
      if (first) {
        title = titleFrom(first.content);
        await put("conversations", { ...c, title, updated_at: now() });
      }
    }
    h.onDone?.({ status: "complete", title });
  } catch (e) {
    if (!(e instanceof ApiError)) console.error("reply failed:", e);
    const err = e instanceof ApiError ? e : new ApiError(500, "Something went wrong.");
    row.status = "error";
    row.error = err.message;
    h.onError?.(err);
  } finally {
    await put("messages", row);
    const c = await get<Conversation>("conversations", cid);
    if (c) await put("conversations", { ...c, title: (await get<Conversation>("conversations", cid))!.title, updated_at: now() });
  }
}

export async function sendMessage(cid: string, body: { content: string; model?: string; file_ids: string[]; image?: ImageOptions }, h: StreamHandlers, signal: AbortSignal) {
  const c = await get<Conversation>("conversations", cid);
  if (!c) throw new ApiError(404, "Conversation not found.");
  const model = body.model || c.model;
  const atts: Attachment[] = [];
  for (const id of body.file_ids) {
    const f = await get<FileRow>("files", id);
    if (!f) throw new ApiError(400, "An attached file was not found. Remove it and try again.");
    atts.push({ id: f.id, name: f.name, mime: f.mime, size: f.size, kind: f.kind, ...(f.images?.length ? { _pictures: true } : {}) } as Attachment);
  }
  const plan = await imagePlan(cid, body.content, atts, body.image);
  if (!plan && model === "echo" && atts.some((a) => a.kind === "image" || (a as { _pictures?: boolean })._pictures))
    throw new ApiError(400, "The offline demo can't see pictures. To have photos explained, open Settings → Connection, choose Google Gemini — free key, and save.");
  for (const a of atts) delete (a as { _pictures?: boolean })._pictures;
  if (model !== c.model) await put("conversations", { ...c, model });
  const um: MsgRow = { id: uid("msg"), conversation_id: cid, role: "user", content: body.content, model: null, status: "complete", error: null, attachments: atts, created_at: now() };
  await put("messages", um);
  if (plan) await runImageTurn(cid, model, strip(um), plan, body.image, h, signal);
  else await runTurn(cid, model, strip(um), h, signal);
}

export async function regenerate(cid: string, h: StreamHandlers, signal: AbortSignal) {
  const c = await get<Conversation>("conversations", cid);
  if (!c) throw new ApiError(404, "Conversation not found.");
  const rows = await messagesOf(cid);
  while (rows.length && rows[rows.length - 1].role === "assistant") await del("messages", rows.pop()!.id);
  if (!rows.length) throw new ApiError(400, "Nothing to regenerate.");
  const last = rows[rows.length - 1];
  const plan = last.role === "user" ? await imagePlan(cid, last.content, last.attachments) : null;
  if (plan) await runImageTurn(cid, c.model, null, { ...plan, seed: undefined, fresh: true }, undefined, h, signal);   // a new picture
  else await runTurn(cid, c.model, null, h, signal);
}

export async function request<T>(): Promise<T> { throw new ApiError(400, "not available in the standalone app"); }
export async function streamChat(): Promise<void> { throw new ApiError(400, "not available in the standalone app"); }
