import { readSSE } from "./sse";
import type { Conversation, ConversationDetail, Message, ModelInfo, UploadedFile, User, UserSettings } from "./types";

/** false = talks to the FastAPI backend; the standalone build swaps in api/local.ts where this is true. */
export const LOCAL_MODE = false;

/** standalone-only helpers (see api/local.ts); inert in the server build */
export async function fetchServerModels(_s: UserSettings, _signal?: AbortSignal): Promise<ModelInfo[]> { return []; }
export async function clearAllLocalData(): Promise<void> {}

export class ApiError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number, public code?: string) {
    super(message);
  }
  get isAuth() { return this.status === 401; }
  get isNetwork() { return this.status === 0; }
}

const HEADERS = { "X-Requested-With": "zenvqo" };
let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

/** FastAPI errors: {"detail": "text"} or {"detail": [{"loc": [...], "msg": "..."}]} (422). */
export function errorMessage(status: number, body: unknown): string {
  const d = (body as { detail?: unknown })?.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d) && d.length) {
    const first = d[0] as { loc?: unknown[]; msg?: string };
    const field = first.loc?.filter((x) => x !== "body").join(".");
    const msg = (first.msg || "Invalid value").replace(/^Value error, /, "");
    return field ? `${field}: ${msg}` : msg;
  }
  if (status === 413) return "That's too large.";
  if (status === 429) return "Too many requests — please wait a moment.";
  if (status >= 500) return "The server had a problem. Please try again.";
  return `Request failed (${status}).`;
}

async function fail(r: Response): Promise<never> {
  let body: unknown = null;
  try { body = await r.json(); } catch { /* non-JSON error */ }
  if (r.status === 401) onUnauthorized();
  const ra = Number(r.headers.get("Retry-After")) || undefined;
  throw new ApiError(r.status, errorMessage(r.status, body), ra);
}

export async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, {
      method, signal, credentials: "same-origin",
      headers: body === undefined ? HEADERS : { ...HEADERS, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.");
  }
  if (!r.ok) return fail(r);
  if (r.status === 204) return undefined as T;
  return (await r.json()) as T;
}

export const api = {
  me: () => request<User>("GET", "/api/auth/me"),
  login: (email: string, password: string) => request<User>("POST", "/api/auth/login", { email, password }),
  register: (email: string, name: string, password: string) => request<User>("POST", "/api/auth/register", { email, name, password }),
  logout: () => request<void>("POST", "/api/auth/logout"),
  models: () => request<{ items: ModelInfo[] }>("GET", "/api/models"),
  settings: () => request<UserSettings>("GET", "/api/settings"),
  saveSettings: (s: UserSettings) => request<UserSettings>("PUT", "/api/settings", s),
  conversations: (q = "", signal?: AbortSignal) =>
    request<{ items: Conversation[]; has_more: boolean }>("GET", `/api/conversations?limit=100&q=${encodeURIComponent(q)}`, undefined, signal),
  conversation: (id: string, signal?: AbortSignal) => request<ConversationDetail>("GET", `/api/conversations/${encodeURIComponent(id)}`, undefined, signal),
  createConversation: (model?: string) => request<Conversation>("POST", "/api/conversations", model ? { model } : {}),
  updateConversation: (id: string, patch: Partial<Pick<Conversation, "title" | "pinned" | "model">>) =>
    request<Conversation>("PATCH", `/api/conversations/${encodeURIComponent(id)}`, patch),
  deleteConversation: (id: string) => request<void>("DELETE", `/api/conversations/${encodeURIComponent(id)}`),
  deleteFile: (id: string) => request<void>("DELETE", `/api/files/${encodeURIComponent(id)}`),
};

export interface StreamHandlers {
  onMeta?: (m: { user_message: Message | null; assistant_message: { id: string; model: string } }) => void;
  onDelta: (text: string) => void;
  onDone?: (d: { status: string; title: string | null }) => void;
  onError?: (e: ApiError) => void;
}

/** POST that answers with an SSE stream. Resolves when the stream ends; abort via `signal` (Stop button). */
export async function streamChat(path: string, body: unknown, h: StreamHandlers, signal: AbortSignal): Promise<void> {
  let r: Response;
  try {
    r = await fetch(path, {
      method: "POST", signal, credentials: "same-origin",
      headers: { ...HEADERS, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.");
  }
  if (!r.ok || !r.body) return fail(r);
  let gotEnd = false;
  try {
    await readSSE(r.body, ({ event, data }) => {
      const d = JSON.parse(data);
      if (event === "meta") h.onMeta?.(d);
      else if (event === "delta") h.onDelta(d.text);
      else if (event === "done") { gotEnd = true; h.onDone?.(d); }
      else if (event === "error") { gotEnd = true; h.onError?.(new ApiError(502, d.message, undefined, d.code)); }
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    throw new ApiError(0, "The connection dropped while the reply was streaming.");
  }
  if (!gotEnd && !signal.aborted) throw new ApiError(0, "The reply ended unexpectedly. Try regenerating.");
}

export const sendMessage = (cid: string, body: { content: string; model?: string; file_ids: string[] }, h: StreamHandlers, s: AbortSignal) =>
  streamChat(`/api/conversations/${encodeURIComponent(cid)}/messages`, body, h, s);
export const regenerate = (cid: string, h: StreamHandlers, s: AbortSignal) =>
  streamChat(`/api/conversations/${encodeURIComponent(cid)}/regenerate`, undefined, h, s);

/** Upload with progress (fetch has no upload progress), abortable. */
export function uploadFile(file: File, onProgress: (frac: number) => void): { promise: Promise<UploadedFile>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<UploadedFile>((resolve, reject) => {
    xhr.open("POST", "/api/files");
    xhr.setRequestHeader("X-Requested-With", "zenvqo");
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let body: unknown = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as UploadedFile);
      else {
        if (xhr.status === 401) onUnauthorized();
        reject(new ApiError(xhr.status, errorMessage(xhr.status, body)));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "Upload failed — check your connection."));
    xhr.onabort = () => reject(new DOMException("aborted", "AbortError"));
    const fd = new FormData();
    fd.append("file", file);
    xhr.send(fd);
  });
  return { promise, abort: () => xhr.abort() };
}
