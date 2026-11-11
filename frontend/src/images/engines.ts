// Image engines the phone app calls directly (no server):
//   free    — Pollinations' public image endpoint: no key, no sign-up (rate-limited: about one image per 15 s).
//   gemini  — Google's Gemini image model with the user's Gemini key: makes AND edits images. Google offers it on paid
//             (billing-enabled) keys; free keys get "limit: 0", and the app then falls back to the free engine.
//   openai  — gpt-image-1 with an OpenAI key (new images).
// Everything comes back as a data: URL that the chat stores on the device.
import type { ImageOp } from "../api/types";
import { sizeFor, STYLES, normStyle, styledPrompt } from "./intent";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface ImageJob {
  op: ImageOp;
  prompt: string;
  style?: string;
  aspect: string;
  resolution: number;
  seed: number;
  negative?: string;
  source?: string;          // data: URL of the image to change
  mask?: string;            // data: URL, white = change
  background?: string;
}

export interface MadeImage { dataUrl: string; mime: string; width: number; height: number; engine: string; model: string; notes: string[] }

export type EngineErrorCode = "quota" | "rate_limited" | "blocked" | "auth" | "network" | "unsupported" | "failed" | "config";
export class ImageEngineError extends Error {
  constructor(message: string, public code: EngineErrorCode, public retryAfter = 0) { super(message); this.name = "ImageEngineError"; }
}

type Progress = (fraction: number, text: string) => void;

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("aborted", "AbortError")); }, { once: true });
});

export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(s)}`;
}

/** Real pixel size of an image data: URL (and a check that it really is a picture). */
export function measure(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new ImageEngineError("The image service sent something that isn't a picture.", "failed"));
    img.src = dataUrl;
  });
}

function sniffMime(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return "image/webp";
  if (b[0] === 0x47 && b[1] === 0x49) return "image/gif";
  return null;
}

/* ---------------- free: Pollinations ---------------- */
export const POLLINATIONS = "https://image.pollinations.ai/prompt/";

export async function pollinations(job: ImageJob, net: Fetcher, signal: AbortSignal, progress: Progress): Promise<MadeImage> {
  const [w, h] = sizeFor(job.aspect, Math.min(job.resolution, 1024), 64);
  let prompt = styledPrompt(job.prompt, job.style);
  if (job.negative) prompt += `. Avoid: ${job.negative}`;
  const q = new URLSearchParams({ width: String(w), height: String(h), seed: String(job.seed), model: "flux", nologo: "true", safe: "true", referrer: "zenvqo" });
  const url = POLLINATIONS + encodeURIComponent(prompt.slice(0, 1500)) + "?" + q.toString();
  for (let attempt = 0; attempt < 3; attempt++) {
    let r: Response;
    try {
      r = await net(url, { headers: { Accept: "image/*", "X-Zenvqo-Binary": "1" }, signal });
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      throw new ImageEngineError("Couldn't reach the free image service. Check your internet connection.", "network");
    }
    if (r.status === 429 || r.status === 503 || r.status === 502) {
      // the anonymous tier allows about one image per 15 seconds
      const wait = Math.min(30, Number(r.headers.get("retry-after")) || 16);
      if (attempt === 2) throw new ImageEngineError("The free image service is busy. Wait a minute and try again.", "rate_limited", wait);
      for (let s = wait; s > 0; s--) { progress(0.05, `The free image service is busy — trying again in ${s} s…`); await sleep(1000, signal); }
      continue;
    }
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (!r.ok) {
      const text = new TextDecoder().decode(bytes.slice(0, 400));
      if (/nsfw|safety|blocked|inappropriate/i.test(text)) throw new ImageEngineError("The image service declined this request under its safety rules.", "blocked");
      throw new ImageEngineError(`The free image service failed (${r.status}). Try again in a moment.`, "failed");
    }
    const mime = sniffMime(bytes);
    if (!mime) throw new ImageEngineError("The free image service sent something that isn't a picture. Try again.", "failed");
    const dataUrl = bytesToDataUrl(bytes, mime);
    const { width, height } = await measure(dataUrl);
    return { dataUrl, mime, width, height, engine: "pollinations", model: "flux", notes: [] };
  }
  throw new ImageEngineError("The free image service is busy. Wait a minute and try again.", "rate_limited");
}

/* ---------------- Gemini ---------------- */
export const GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";

function instruction(job: ImageJob): string {
  const style = STYLES[normStyle(job.style)][0];
  const avoid = job.negative ? ` Avoid: ${job.negative}.` : "";
  const p = job.prompt.trim();
  switch (job.op) {
    case "generate": return `Generate an image: ${styledPrompt(p, job.style)}.${avoid}`;
    case "style": return `Redraw this image in this style: ${style || p}. Keep the same subject and composition.${avoid}`;
    case "variations": return `Create a new variation of this image: same subject and style, different details and composition. ${p}${avoid}`;
    case "remove_background": return "Remove the background completely. Put the subject alone on a plain pure white background. Do not change the subject.";
    case "replace_background": return `Replace the background with: ${job.background || p}. Keep the subject exactly as it is.${avoid}`;
    case "remove_object": return `Remove ${p || "the marked object"} from this image and fill the area so it looks natural. Change nothing else.${job.mask ? " The second image is a mask: remove only what is under the white area." : ""}`;
    default: return `Edit this image: ${p}.${style ? " Style: " + style + "." : ""}${avoid}${job.mask ? " The second image is a mask: change only the area under the white part, keep everything else identical." : ""}`;
  }
}

function inline(dataUrl: string) {
  const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  if (!m) throw new ImageEngineError("That image can't be read.", "failed");
  return { inlineData: { mimeType: m[1], data: m[2] } };
}

export async function gemini(job: ImageJob, key: string, net: Fetcher, signal: AbortSignal): Promise<MadeImage> {
  const parts: unknown[] = [{ text: instruction(job) }];
  if (job.source) parts.push(inline(job.source));
  if (job.mask) parts.push(inline(job.mask));
  const cfg: Record<string, unknown> = { responseModalities: ["TEXT", "IMAGE"] };
  if (job.op === "generate") cfg.imageConfig = { aspectRatio: job.aspect };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent`;
  let r: Response;
  try {
    r = await net(url, { method: "POST", signal, headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: cfg }) });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ImageEngineError("Couldn't reach Gemini. Check your internet connection.", "network");
  }
  const text = await r.text();
  let j: { error?: { message?: string }; promptFeedback?: { blockReason?: string };
    candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean; inlineData?: { mimeType?: string; data?: string }; inline_data?: { mime_type?: string; data?: string } }[] } }[] } = {};
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (r.status !== 200) {
    const msg = j.error?.message || "";
    if (r.status === 429 && /limit: 0|free_tier/i.test(text)) {
      throw new ImageEngineError("Your Gemini key can't make images: Google offers its image model only on keys with billing turned on.", "quota");
    }
    if (r.status === 429) throw new ImageEngineError("Gemini's rate limit was reached. Wait a minute and try again.", "rate_limited", 60);
    if (r.status === 401 || r.status === 403 || /API key not valid/i.test(msg)) throw new ImageEngineError("Gemini rejected the API key. Check it in Settings → Connection.", "auth");
    if (r.status === 404) throw new ImageEngineError(`Gemini doesn't offer the image model “${GEMINI_IMAGE_MODEL}” for this key.`, "config");
    throw new ImageEngineError(`Gemini returned an error (${r.status}). ${msg.slice(0, 200)}`.trim(), "failed");
  }
  if (j.promptFeedback?.blockReason) throw new ImageEngineError("Gemini declined this request under its safety rules.", "blocked");
  const cands = j.candidates || [];
  for (const c of cands) {
    for (const part of c.content?.parts || []) {
      const d = part.inlineData || (part.inline_data && { mimeType: part.inline_data.mime_type, data: part.inline_data.data });
      if (d?.data && !part.thought && String(d.mimeType || "").startsWith("image/")) {
        const dataUrl = `data:${d.mimeType};base64,${d.data}`;
        const { width, height } = await measure(dataUrl);
        const notes: string[] = [];
        if (job.op === "remove_background") notes.push("Gemini can't make transparent images, so the subject is on white.");
        if (job.mask) notes.push("Gemini follows the painted area approximately.");
        return { dataUrl, mime: d.mimeType!, width, height, engine: "gemini", model: GEMINI_IMAGE_MODEL, notes };
      }
    }
  }
  const reason = cands[0]?.finishReason || "";
  if (/SAFETY|PROHIBITED|BLOCKLIST|SPII/.test(reason)) throw new ImageEngineError("Gemini declined to make this image under its safety rules.", "blocked");
  const said = cands.flatMap((c) => c.content?.parts || []).map((p) => p.text || "").join(" ").trim();
  throw new ImageEngineError(`Gemini answered without an image${said ? `: “${said.slice(0, 160)}”` : "."} Try rephrasing.`, "failed");
}

/* ---------------- OpenAI ---------------- */
export async function openai(job: ImageJob, base: string, key: string, net: Fetcher, signal: AbortSignal): Promise<MadeImage> {
  if (job.op !== "generate") throw new ImageEngineError("Editing pictures needs a Gemini key here.", "unsupported");
  const [a, b] = job.aspect.split(":").map(Number);
  const size = a > b ? "1536x1024" : a < b ? "1024x1536" : "1024x1024";
  let r: Response;
  try {
    r = await net(base.replace(/\/+$/, "") + "/images/generations", { method: "POST", signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "gpt-image-1", prompt: styledPrompt(job.prompt, job.style) + (job.negative ? `. Avoid: ${job.negative}` : ""), size, n: 1 }) });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ImageEngineError("Couldn't reach OpenAI. Check your internet connection.", "network");
  }
  const j = await r.json().catch(() => ({})) as { data?: { b64_json?: string }[]; error?: { message?: string; code?: string } };
  if (!r.ok) {
    const msg = j.error?.message || "";
    if (r.status === 401) throw new ImageEngineError("OpenAI rejected the API key.", "auth");
    if (j.error?.code === "moderation_blocked" || /safety|moderation/i.test(msg)) throw new ImageEngineError("OpenAI declined this request under its safety rules.", "blocked");
    if (r.status === 429) throw new ImageEngineError("OpenAI's limit was reached. " + msg.slice(0, 120), "quota");
    throw new ImageEngineError(`OpenAI returned an error (${r.status}). ${msg.slice(0, 200)}`.trim(), "failed");
  }
  const b64 = j.data?.[0]?.b64_json;
  if (!b64) throw new ImageEngineError("OpenAI answered without an image.", "failed");
  const dataUrl = `data:image/png;base64,${b64}`;
  const { width, height } = await measure(dataUrl);
  return { dataUrl, mime: "image/png", width, height, engine: "openai", model: "gpt-image-1", notes: [] };
}
