/** Picture models: AI models that make pictures themselves — Google's Nano Banana, OpenAI's GPT Image, OpenRouter's
 *  picture models (Grok Imagine, Seedream…) — picked in the model menu like a chat model. And the free picture AI, which
 *  works with any connection: the chat's own AI writes the picture from the conversation, and a free service (or this
 *  phone) draws it. */
import type { ModelInfo } from "../api/types";

/** The free picture AI's id in the model menu. */
export const FREE_PICTURES = "img:free";

export const FREE_PICTURE_MODEL: ModelInfo = {
  id: FREE_PICTURES, label: "Picture AI — free", vision: false, pictures: true,
  description: "Your chat AI writes the picture from the conversation; a free picture service (or this phone) draws it.",
};

/** Google's and OpenAI's picture models by their ids (OpenRouter says it in its model list: output "image"). */
const GEMINI_PICTURES = /(?:^|\/)(?:gemini-[\d.]+(?:-flash|-pro)?(?:-lite)?-image(?:-preview)?(?:-\d{2}-\d{4})?|nano-banana[\w.-]*)$/i;
const OPENAI_PICTURES = /(?:^|\/)(?:gpt-image-[\w.-]+|chatgpt-image-latest)$/i;

const bare = (id: string) => id.replace(/^srv:/, "").replace(/:free$/, "");

/** Does this model make pictures (rather than write)? */
export function isPictureModel(m: string | ModelInfo): boolean {
  if (typeof m !== "string") return !!m.pictures || isPictureModel(m.id);
  return m === FREE_PICTURES || GEMINI_PICTURES.test(bare(m)) || OPENAI_PICTURES.test(bare(m));
}

/** Who makes the picture, for a picture model on the user's connection. */
export type PictureEngine = { kind: "free" } | { kind: "gemini" | "openai" | "openrouter"; model: string; name: string };

export function pictureEngine(id: string, baseUrl: string, name?: string): PictureEngine | null {
  if (id === FREE_PICTURES) return { kind: "free" };
  const model = id.replace(/^srv:/, "");
  const label = name || pictureName(id);
  if (/openrouter\.ai/.test(baseUrl)) return { kind: "openrouter", model, name: label };
  if (/generativelanguage\.googleapis\.com/.test(baseUrl) && GEMINI_PICTURES.test(model)) return { kind: "gemini", model, name: label };
  if (OPENAI_PICTURES.test(model)) return { kind: "openai", model, name: label };
  return null;
}

/** A picture model's name for people: "gemini-3.1-flash-image" → "Nano Banana 2", "gpt-image-2" → "GPT Image 2",
 *  "Google: Nano Banana Pro (Gemini 3 Pro Image)" (OpenRouter's own name) → "Nano Banana Pro (Gemini 3 Pro Image)". */
export function pictureName(id: string, listed?: string): string {
  if (id === FREE_PICTURES) return FREE_PICTURE_MODEL.label;
  if (listed && listed !== id) return listed.replace(/^[^:]{2,30}:\s*/, "");
  const m = bare(id).split("/").pop()!;
  const g = m.match(/^gemini-([\d.]+)-(flash|pro)(-lite)?-image/i);
  if (g) {
    const gen = g[1] === "2.5" ? "" : g[1].startsWith("3.1") ? " 2" : ` ${g[1]}`;
    return `Nano Banana${g[2].toLowerCase() === "pro" ? " Pro" : gen}${g[3] ? " Lite" : ""}`.replace(/ {2,}/g, " ");
  }
  const o = m.match(/^gpt-image-([\d.]+)(?:-([a-z]+))?/i);
  if (o) return `GPT Image ${o[1]}${o[2] ? " " + o[2][0].toUpperCase() + o[2].slice(1) : ""}`;
  if (/^chatgpt-image-latest$/i.test(m)) return "ChatGPT Image";
  return m.replace(/-/g, " ").replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

/* ---------- the free picture AI: the chat's AI writes the picture ---------- */
const WRITER = "You write prompts for an image generator. From the conversation and the user's latest request, write ONE " +
  "detailed prompt for the picture to make now: the subject and what it looks like, what it is doing, the setting, the " +
  "composition and camera angle, lighting, colours and the style (photo, illustration, 3D…). Keep details the user asked " +
  "for earlier when the request builds on them (\"same cat, now in space\"). Write it in English even when the user writes in " +
  "another language. Words that must appear in the picture go in double quotes. Reply with the prompt only — one paragraph " +
  "of 30 to 90 words, no title, no explanation.";

/** What the chat's AI is asked: the recent conversation (text) and the request. */
export function pictureWriterMessages(history: { role: string; text: string }[], request: string): { role: string; content: string }[] {
  const recent = history.filter((m) => m.text.trim()).slice(-6)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text.replace(/\s+/g, " ").trim().slice(0, 500)}`).join("\n");
  return [
    { role: "system", content: WRITER },
    { role: "user", content: (recent ? `The conversation so far:\n${recent}\n\n` : "") + `The picture to make now: ${request.trim()}` },
  ];
}

/** The written prompt, cleaned: no "Prompt:" label, quotes around it, markdown or line breaks. */
export function cleanWrittenPrompt(t: string): string {
  const s = t.replace(/^```[\w-]*\s*|\s*```$/g, "").replace(/^\s*(?:\*\*)?(?:image )?prompt(?:\*\*)?\s*:\s*/i, "")
    .replace(/[*_#>`]/g, "").replace(/\s+/g, " ").trim().replace(/^["“](.*)["”]$/, "$1").trim();
  return s.length >= 12 ? s.slice(0, 900) : "";
}
