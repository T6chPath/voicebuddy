/** Talks directly to an OpenAI-compatible server (llama-server, Ollama, vLLM, OpenAI) from the browser / WebView. */
import { readSSE } from "../api/sse";
import type { LocalMessage, Server } from "./store";

export class ProviderError extends Error {
  constructor(message: string, public code = "provider_error") { super(message); }
}

type Part = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export interface ChatMsg { role: "system" | "user" | "assistant"; content: string | Part[] }

const BASE_SYSTEM = "You are zenvqo, a helpful assistant. Use Markdown when it helps (lists, tables, fenced code with a language).";

export function buildMessages(history: LocalMessage[], systemPrompt: string, vision: boolean, budget = 24000): ChatMsg[] {
  const system = BASE_SYSTEM + (systemPrompt ? "\n\n" + systemPrompt : "");
  const out: ChatMsg[] = [];
  let used = system.length;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.status === "error" || (m.role === "assistant" && !m.content)) continue;
    let text = m.content;
    const images: string[] = [];
    for (const a of m.attachments) {
      if (a.text) text += `\n\n<attached_file name="${a.name.replace(/"/g, "'")}">\n${a.text}\n</attached_file>`;
      if (a.dataUrl) images.push(a.dataUrl);
    }
    if (used + text.length > budget && out.length) break;
    used += text.length;
    out.unshift(images.length && vision ? { role: m.role, content: [{ type: "text", text }, ...images.map((u) => ({ type: "image_url" as const, image_url: { url: u } }))] }
      : { role: m.role, content: text });
  }
  return [{ role: "system", content: system }, ...out];
}

function endpoint(base: string) { return base.replace(/\/+$/, ""); }

export async function listModels(s: Server, signal?: AbortSignal): Promise<string[]> {
  let r: Response;
  try {
    r = await fetch(endpoint(s.baseUrl) + "/models", { signal, headers: s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {} });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ProviderError(unreachable(s), "unreachable");
  }
  if (!r.ok) throw new ProviderError(`${s.name} answered ${r.status} for /models.`, "http");
  const j = await r.json();
  const ids = (j?.data || j?.models || []).map((m: { id?: string; name?: string; model?: string }) => m.id || m.model || m.name).filter(Boolean);
  return [...new Set<string>(ids)];
}

function unreachable(s: Server) {
  const lan = /127\.0\.0\.1|localhost/.test(s.baseUrl) && /Android|iPhone/i.test(navigator.userAgent)
    ? " On a phone, use your laptop's Wi-Fi address (e.g. http://192.168.1.20:8080/v1) instead of 127.0.0.1." : "";
  return `Can't reach “${s.name}” at ${s.baseUrl}. Check that the server is running and the address is right.${lan} ` +
    "If it is running, it may be blocking requests from this app (CORS) — start it with --host 0.0.0.0 and allow cross-origin requests.";
}

export async function streamChat(s: Server, model: string, messages: ChatMsg[], temperature: number, signal: AbortSignal,
                                 onDelta: (t: string) => void): Promise<void> {
  let r: Response;
  try {
    r = await fetch(endpoint(s.baseUrl) + "/chat/completions", {
      method: "POST", signal,
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...(s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {}) },
      body: JSON.stringify({ model, messages, stream: true, temperature }),
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ProviderError(unreachable(s), "unreachable");
  }
  if (r.status === 401 || r.status === 403) throw new ProviderError(`${s.name} rejected the request (check the API key).`, "auth");
  if (r.status === 429) throw new ProviderError(`${s.name} is busy (rate limited). Try again shortly.`, "rate_limited");
  if (!r.ok || !r.body) {
    let detail = "";
    try { const j = await r.json(); detail = j?.error?.message || j?.detail || ""; } catch { /* ignore */ }
    throw new ProviderError(`${s.name} returned an error (${r.status})${detail ? ": " + String(detail).slice(0, 200) : "."}`, "http");
  }
  let done = false;
  try {
    await readSSE(r.body, ({ data }) => {
      if (data === "[DONE]") { done = true; return; }
      try {
        const j = JSON.parse(data);
        if (j.error) throw new ProviderError(String(j.error.message || j.error), "server_error");
        const t = j.choices?.[0]?.delta?.content;
        if (t) onDelta(t);
        if (j.choices?.[0]?.finish_reason) done = true;
      } catch (e) {
        if (e instanceof ProviderError) throw e;
      }
    });
  } catch (e) {
    if ((e as Error).name === "AbortError" || e instanceof ProviderError) throw e;
    throw new ProviderError("The connection dropped while the reply was streaming.", "network");
  }
  if (!done && !signal.aborted) throw new ProviderError("The reply ended unexpectedly. Try regenerating.", "truncated");
}

/** Offline demo model: same behaviour as the server's echo model (markdown, code, table, [fail]). */
export async function demoStream(messages: ChatMsg[], temperature: number, signal: AbortSignal, onDelta: (t: string) => void, delayMs = 25) {
  const lastC = messages[messages.length - 1].content;
  const last = typeof lastC === "string" ? lastC : lastC.map((p) => (p.type === "text" ? p.text : "")).join(" ");
  const q = last.split("\n\n<attached_file")[0].trim();
  const files = (last.match(/<attached_file/g) || []).length;
  const parts = [`You said: **${q.slice(0, 300)}**\n\n`];
  if (files) parts.push(`I can see ${files} attached file(s). First line: \`${(last.split("<attached_file")[1]?.split(">")[1] || "").trim().split("\n")[0].slice(0, 80).replace(/`/g, "'")}\`\n\n`);
  if (/code/i.test(q)) parts.push("Here's an example:\n\n```python\ndef greet(name: str) -> str:\n    return f\"Namaste, {name}!\"\n\nprint(greet(\"zenvqo\"))\n```\n\n");
  if (/table/i.test(q)) parts.push("| Model | Size |\n|---|---|\n| zenvqo | 3B |\n| demo | 0B |\n\n");
  const earlier = messages.slice(0, -1).filter((m) => m.role !== "system").length;
  parts.push(`(_demo model — ${earlier} earlier message(s) in context, temperature ${temperature}_)`);
  const tokens = parts.join("").match(/[^ \n]*[ \n]?/g)!.filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    if (signal.aborted) return;
    if (/\[fail\]/.test(q) && i === 6) throw new ProviderError("The demo model failed on purpose ([fail] in your message).", "demo_failure");
    await new Promise((res) => setTimeout(res, delayMs));
    onDelta(tokens[i]);
  }
}
