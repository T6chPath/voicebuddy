/** Device-local storage for the standalone app (localStorage). Nothing leaves the device except prompts sent to
 * the model server the user configures. */
import type { Attachment, Conversation, Message } from "../api/types";

export interface Server { id: string; name: string; baseUrl: string; apiKey: string; vision: boolean; models: string[] }

export interface LocalSettings {
  theme: "system" | "light" | "dark";
  font_size: "small" | "medium" | "large";
  temperature: number;
  system_prompt: string;
  send_on_enter: boolean;
  show_timestamps: boolean;
  default_model: string;
  servers: Server[];
}

/** Attachment content travels with the message so history can be re-sent to the model. */
export interface LocalAttachment extends Attachment { text?: string; dataUrl?: string }
export interface LocalMessage extends Message { attachments: LocalAttachment[] }

export interface Data { v: 1; conversations: Conversation[]; messages: Record<string, LocalMessage[]>; settings: LocalSettings }

export const DEMO_MODEL = "demo";
export const DEFAULT_SETTINGS: LocalSettings = {
  theme: "system", font_size: "medium", temperature: 0.7, system_prompt: "", send_on_enter: true, show_timestamps: false,
  default_model: DEMO_MODEL,
  servers: [{ id: "srv1", name: "zenvqo (laptop)", baseUrl: "http://127.0.0.1:8080/v1", apiKey: "", vision: false, models: [] }],
};

const KEY = "zenvqo.standalone.v1";

export function uid(prefix: string): string {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return prefix + "_" + Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function load(storage: Storage = localStorage): Data {
  try {
    const raw = storage.getItem(KEY);
    if (raw) {
      const d = JSON.parse(raw) as Data;
      d.settings = { ...DEFAULT_SETTINGS, ...d.settings };
      for (const list of Object.values(d.messages))       // replies interrupted by closing the app
        for (const m of list) if (m.status === "streaming") m.status = "stopped";
      return d;
    }
  } catch { /* corrupt → start fresh (the old value is kept under a backup key) */
    try { storage.setItem(KEY + ".corrupt", storage.getItem(KEY) || ""); } catch { /* ignore */ }
  }
  return { v: 1, conversations: [], messages: {}, settings: { ...DEFAULT_SETTINGS } };
}

export class StorageFullError extends Error {}

export function save(d: Data, storage: Storage = localStorage) {
  try {
    storage.setItem(KEY, JSON.stringify(d));
  } catch (e) {
    if ((e as DOMException).name === "QuotaExceededError" || /quota/i.test(String(e))) throw new StorageFullError("Device storage is full — delete old chats or export and clear your data.");
    throw e;
  }
}

export function exportJson(d: Data): string {
  const safe = { ...d, settings: { ...d.settings, servers: d.settings.servers.map((s) => ({ ...s, apiKey: "" })) } };
  return JSON.stringify(safe, null, 1);
}

export function importJson(text: string, current: Data): Data {
  const d = JSON.parse(text) as Data;
  if (d?.v !== 1 || !Array.isArray(d.conversations) || typeof d.messages !== "object") throw new Error("Not a zenvqo export file.");
  const known = new Set(current.conversations.map((c) => c.id));
  const convs = [...current.conversations, ...d.conversations.filter((c) => !known.has(c.id))];
  return { ...current, conversations: convs, messages: { ...d.messages, ...current.messages } };
}

export function titleFrom(text: string): string {
  const w = text.split(/\s+/).join(" ").trim();
  return w.length > 60 ? w.slice(0, 60).replace(/\s+\S*$/, "") + "…" : w || "New chat";
}
