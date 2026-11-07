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
        const head = JSON.parse(data) as { status: number };
        p.started = true;
        const body = new ReadableStream<Uint8Array>({ start: (c) => { p.ctl = c; } });
        p.resolve(new Response(body, { status: head.status >= 200 && head.status <= 599 ? head.status : 502 }));
      } else if (kind === "data") p.ctl?.enqueue(enc.encode(data));
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
  return bridge ? nativeFetch(bridge, url, init) : fetch(url, init);
}

/** Ready-made connections shown in Settings → Connection. */
export const PRESETS = [
  { id: "gemini", label: "Google Gemini — free key", url: "https://generativelanguage.googleapis.com/v1beta/openai", keyUrl: "https://aistudio.google.com/apikey", needsKey: true },
  { id: "groq", label: "Groq — free key", url: "https://api.groq.com/openai/v1", keyUrl: "https://console.groq.com/keys", needsKey: true },
  { id: "laptop", label: "My laptop (llama-server)", url: "http://192.168.1.20:8080", keyUrl: "", needsKey: false },
  { id: "ollama", label: "Ollama", url: "http://192.168.1.20:11434", keyUrl: "", needsKey: false },
  { id: "custom", label: "Other OpenAI-compatible server", url: "", keyUrl: "", needsKey: false },
] as const;

/** The model can't know today's date by itself — tell it, in the user's own time zone. */
export function nowContext(d = new Date()): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "local time";
  const when = d.toLocaleString("en-IN", { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `Current date and time for the user: ${when} (${tz}). Use this for questions about today, dates, days or time.`;
}

// ---------------- IndexedDB ----------------
type StoreName = "conversations" | "messages" | "files";
interface FileRow extends Attachment { text?: string; dataUrl?: string; created_at: number }
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
  return { "Content-Type": "application/json", ...(s.api_key ? { Authorization: `Bearer ${s.api_key}` } : {}) };
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
  const items = (j.data || j.models || []) as { id?: string; name?: string; model?: string }[];
  const ids = items.map((m) => (m.id || m.name || m.model || "").replace(/^models\//, "")).filter((id) => id && !NOT_CHAT.test(id));
  const host = (() => { try { return new URL(b).host; } catch { return b; } })();
  return ids.map((id) => ({ id: "srv:" + id, label: id.split("/").pop()!.replace(/\.gguf$/i, ""), vision: true, description: `on ${host}` }));
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
    return { ...c, messages: (await messagesOf(id)).map(strip) };
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
  imageCaps: async (): Promise<ImageCaps> => ({ available: false, ops: [], styles: [], aspect_ratios: [], formats: [], max_n: 1, max_resolution: 512, providers: [],
    reason: "Image generation runs on the zenvqo server app (it needs an image model and keeps API keys off your device). Open the server app in your browser to make images." }),
  ttsVoices: async (): Promise<TTSCatalog> => ({ available: false, reason: "this app has no server; it uses your device's own voices", engines: [], voices: [], languages: [], defaults: {}, max_chars: 0 }),
  voiceConfig: async () => ({ available: false, reason: "this app has no server", partials: false, max_seconds: 0 }),
  transcribe: async (_wav: Blob, _lang: string): Promise<{ text: string; lang: string; confidence: string; engine: string; ms: number }> => { throw new ApiError(400, "No server speech recognition in the standalone app."); },
};

export async function clearAllLocalData() {
  for (const s of ["conversations", "messages", "files"] as StoreName[]) await req((await store(s, "readwrite")).clear());
}

// ---------------- files ----------------
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|py|js|ts|tsx|jsx|html|css|sql|ya?ml|toml|xml|log|java|kt|c|cpp|h|go|rs|sh)$/i;
const MAX_BYTES = 10 * 1024 * 1024;

async function sniff(file: File): Promise<{ kind: Attachment["kind"]; mime: string }> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const starts = (...b: number[]) => b.every((x, i) => head[i] === x);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return { kind: "image", mime: "image/png" };
  if (starts(0xff, 0xd8, 0xff)) return { kind: "image", mime: "image/jpeg" };
  if (starts(0x47, 0x49, 0x46, 0x38)) return { kind: "image", mime: "image/gif" };
  if (starts(0x52, 0x49, 0x46, 0x46) && head[8] === 0x57 && head[9] === 0x45) return { kind: "image", mime: "image/webp" };
  if (starts(0x25, 0x50, 0x44, 0x46)) throw new ApiError(415, "PDFs need the zenvqo server app. Paste the text instead.");
  if (TEXT_EXT.test(file.name) || !/\.[a-z0-9]+$/i.test(file.name)) {
    const sample = new Uint8Array(await file.slice(0, 8192).arrayBuffer());
    if (sample.includes(0)) throw new ApiError(415, "This looks like a binary file, not text.");
    return { kind: "text", mime: "text/plain" };
  }
  throw new ApiError(415, "Unsupported file type. Use text, code, CSV/JSON or PNG/JPEG/WebP/GIF images.");
}

export function uploadFile(file: File, onProgress: (frac: number) => void): { promise: Promise<UploadedFile>; abort: () => void } {
  const promise = (async () => {
    if (file.size > MAX_BYTES) throw new ApiError(413, "File is larger than 10 MB.");
    if (file.size === 0) throw new ApiError(400, "The file is empty.");
    const { kind, mime } = await sniff(file);
    const name = file.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 120) || "file";
    const row: FileRow = { id: uid("fil"), name, mime, size: file.size, kind, created_at: now() };
    if (kind === "text") row.text = (await file.text()).slice(0, 60000);
    else row.dataUrl = await new Promise<string>((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result as string);
      fr.onerror = () => rej(new ApiError(400, "Couldn't read the file."));
      fr.readAsDataURL(file);
    });
    await put("files", row);
    onProgress(1);
    return { id: row.id, name, mime, size: file.size, kind, chars: row.text?.length ?? 0, truncated: (row.text?.length ?? 0) >= 60000 };
  })();
  return { promise, abort: () => {} };
}

// ---------------- chat ----------------
export const fileUrl = (_id: string, _download = false) => "";
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

const BASE_SYSTEM = "You are zenvqo, a helpful assistant. Use Markdown when it helps (lists, tables, fenced code with a language). Write mathematics in LaTeX: inline as $...$ and displayed equations as $$...$$ on their own lines. When the user asks for a PDF (quiz, notes, paragraph, worksheet…), write the complete content as a well-structured Markdown document that starts with a # title — the app turns your reply into a PDF file automatically, so never say you can't create PDFs.";
type ChatMsg = { role: string; content: string | { type: string; text?: string; image_url?: { url: string } }[] };

async function buildHistory(cid: string, s: UserSettings, vision: boolean): Promise<ChatMsg[]> {
  const rows = (await messagesOf(cid)).filter((m) => m.status !== "error" && !(m.role === "assistant" && !m.content));
  const out: ChatMsg[] = [];
  let used = 0;
  for (const r of [...rows].reverse()) {
    let text = r.content;
    const images: string[] = [];
    for (const a of r.attachments) {
      const f = await get<FileRow>("files", a.id);
      if (f?.text) text += `\n\n<attached_file name="${f.name}">\n${f.text}\n</attached_file>`;
      if (f?.dataUrl && vision) images.push(f.dataUrl);
    }
    if (used + text.length > 24000 && out.length) break;
    used += text.length;
    out.push(images.length ? { role: r.role, content: [{ type: "text", text }, ...images.map((u) => ({ type: "image_url", image_url: { url: u } }))] } : { role: r.role, content: text });
  }
  const system = BASE_SYSTEM + "\n" + nowContext() + (s.system_prompt ? "\n\n" + s.system_prompt : "");
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

async function* echoStream(messages: ChatMsg[], temperature: number, signal: AbortSignal): AsyncGenerator<string> {
  const last = messages[messages.length - 1].content;
  const text = typeof last === "string" ? last : last.map((p) => p.text || "").join(" ");
  const q = text.split("\n\n<attached_file")[0].trim();
  const files = (text.match(/<attached_file/g) || []).length;
  let reply: string;
  if (DATE_Q.test(q) && !/code|table/i.test(q)) {
    const d = new Date();
    reply = `Today is **${d.toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}**, and the time is **${d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}** (from your device's clock).\n\n`;
  } else {
    reply = `I'm the **offline demo**, not a real AI, so I can't answer “${q.slice(0, 120)}”.\n\n`;
    reply += "**To get real answers:** open **Settings → Connection**, choose **Google Gemini — free key**, paste a free key from Google AI Studio, tap **Test connection**, then **Save**.\n\n";
  }
  if (files) reply += `I can see ${files} attached file(s). First line: \`${(text.split("<attached_file")[1]?.split(">")[1] || "").trim().split("\n")[0].slice(0, 80).replace(/`/g, "'")}\`\n\n`;
  if (/code/i.test(q)) reply += "Here's how code looks:\n\n```python\ndef greet(name: str) -> str:\n    return f\"Namaste, {name}!\"\n\nprint(greet(\"zenvqo\"))\n```\n\n";
  if (/\bpdf\b/i.test(q)) reply += demoDocument(q);
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

async function* serverStream(model: string, messages: ChatMsg[], s: UserSettings, signal: AbortSignal): AsyncGenerator<string> {
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

async function runTurn(cid: string, modelId: string, userMsg: Message | null, h: StreamHandlers, signal: AbortSignal) {
  const s = loadSettings();
  const vision = modelId.startsWith("srv:");
  const history = await buildHistory(cid, s, vision);
  const aid = uid("msg");
  const row: MsgRow = { id: aid, conversation_id: cid, role: "assistant", content: "", model: modelId, status: "streaming", error: null, attachments: [], created_at: now() + 0.001 };
  await put("messages", row);
  h.onMeta?.({ user_message: userMsg, assistant_message: { id: aid, model: modelId } });
  const gen = modelId === "echo" ? echoStream(history, s.temperature, signal) : serverStream(modelId.replace(/^srv:/, ""), history, s, signal);
  let lastSave = Date.now();
  try {
    for await (const t of gen) {
      row.content += t;
      h.onDelta(t);
      if (Date.now() - lastSave > 1000) { await put("messages", row); lastSave = Date.now(); }   // survive a closed tab
    }
    if (signal.aborted) { row.status = "stopped"; return; }
    row.status = "complete";
    const c = await get<Conversation>("conversations", cid);
    let title: string | null = null;
    if (c && c.title === "New chat") {
      const first = (await messagesOf(cid)).find((m) => m.role === "user");
      if (first) {
        const w = first.content.split(/\s+/).join(" ");
        title = w.length > 60 ? w.slice(0, 60).replace(/\s+\S*$/, "") + "…" : w;
        await put("conversations", { ...c, title, updated_at: now() });
      }
    }
    h.onDone?.({ status: "complete", title });
  } catch (e) {
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
    if (f.kind === "image" && model === "echo") throw new ApiError(400, "The demo model can't read images. Connect a vision model in Settings.");
    atts.push({ id: f.id, name: f.name, mime: f.mime, size: f.size, kind: f.kind });
  }
  if (model !== c.model) await put("conversations", { ...c, model });
  const um: MsgRow = { id: uid("msg"), conversation_id: cid, role: "user", content: body.content, model: null, status: "complete", error: null, attachments: atts, created_at: now() };
  await put("messages", um);
  await runTurn(cid, model, strip(um), h, signal);
}

export async function regenerate(cid: string, h: StreamHandlers, signal: AbortSignal) {
  const c = await get<Conversation>("conversations", cid);
  if (!c) throw new ApiError(404, "Conversation not found.");
  const rows = await messagesOf(cid);
  while (rows.length && rows[rows.length - 1].role === "assistant") await del("messages", rows.pop()!.id);
  if (!rows.length) throw new ApiError(400, "Nothing to regenerate.");
  await runTurn(cid, c.model, null, h, signal);
}

export async function request<T>(): Promise<T> { throw new ApiError(400, "not available in the standalone app"); }
export async function streamChat(): Promise<void> { throw new ApiError(400, "not available in the standalone app"); }
