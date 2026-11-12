/** "Learn as a book" writes with the best model for the job on the user's own AI service: one that is fast (a book
 *  page is 1,500–3,000 words) and still accurate enough to teach from. The model names change every few months, so
 *  models are matched by family and the newest version wins — whatever the service lists today. */
import type { ModelInfo } from "../api/types";

/** Families that write books well and fast, best first; inside a family the newest version is taken. */
const FAMILIES: RegExp[][] = [
  [/(?:^|\/)gemini-\d+(?:\.\d+)?-flash(?:-latest)?$/],                                    // Google: the newest Flash
  [/(?:^|\/)claude-haiku-\d+(?:[-.]\d+)?(?:-\d{8})?$/],                                  // Anthropic: Haiku
  [/(?:^|\/)gpt-\d+(?:\.\d+)?-mini$/],                                                   // OpenAI: the newest mini
  [/(?:^|\/)deepseek-flash$/, /(?:^|\/)deepseek-v\d+(?:\.\d+)?-flash$/, /(?:^|\/)deepseek-chat$/],   // DeepSeek Flash
  [/(?:^|\/)gpt-oss-120b$/],                                                             // Groq (about 500 tokens a second)
  [/(?:^|\/)mistral-medium(?:-latest)?$/, /(?:^|\/)mistral-medium-[\d-]+$/],              // Mistral Medium
  [/nemotron.*ultra/, /nemotron.*super/],                                                // OpenRouter's free models
  [/(?:^|\/)gemma-?4/, /(?:^|\/)qwen-?3/, /(?:^|\/)llama-?4/, /(?:^|\/)glm-?\d/, /(?:^|\/)kimi-k\d/],
  [/^openrouter\/free$/],                                                                // OpenRouter picks a free one
];

/** Not for writing a book: too small, or made for something else (speech, pictures, search, code…). */
const UNFIT = /lite|nano|live|tts|image|audio|embed|guard|transcri|translate|robotics|research|agent|antigravity|omni|realtime|search|computer|codex|coder|\bcode\b|instant/i;

const bare = (id: string) => id.replace(/^srv:/, "");
const isFree = (id: string) => /:free$/.test(id) || bare(id) === "openrouter/free";

/** The version in a model's name ("gemini-3.8-flash" → 3.8, "claude-haiku-4-5-20251001" → 4.5), for newest first. */
function version(id: string): [number, number] {
  const m = bare(id).split("/").pop()!.match(/(\d+)(?:[.-](\d{1,2})(?!\d))?/);
  return m ? [+m[1], m[2] ? +m[2] : 0] : [0, 0];
}
const preview = (id: string) => /preview|exp\b|experimental|beta/i.test(id);

/** The model a book should be written with, from the service's list — or null when there is no better choice than the
 *  chat's own model (one model on a laptop, the offline demo, nothing that fits). On OpenRouter a free key stays on
 *  free models. */
export function bestBookModel(models: ModelInfo[], current: string): ModelInfo | null {
  const all = models.filter((m) => m.id !== "echo");
  if (!all.length) return null;
  const router = all.some((m) => isFree(m.id));
  const pool = router && (isFree(current) || !all.some((m) => m.id === current)) ? all.filter((m) => isFree(m.id)) : all;
  for (const family of FAMILIES) {
    for (const re of family) {
      const hits = pool.filter((m) => re.test(bare(m.id).replace(/:free$/, "")) && !UNFIT.test(bare(m.id)));
      if (!hits.length) continue;
      hits.sort((a, b) => Number(preview(a.id)) - Number(preview(b.id)) || version(b.id)[0] - version(a.id)[0] || version(b.id)[1] - version(a.id)[1]);
      return hits[0];
    }
  }
  return null;
}

/** A model's name for people: "gemini-3.8-flash" → "Gemini 3.8 Flash", "openai/gpt-oss-120b" → "GPT-OSS 120B". */
export function modelName(id: string): string {
  const s = bare(id).replace(/:free$/, "").split("/").pop()!.replace(/-latest$/, "").replace(/-\d{8}$/, "");
  if (s === "free") return "OpenRouter free models";
  return s.replace(/^(claude-[a-z]+)-(\d+)-(\d+)$/i, "$1-$2.$3")
    .replace(/-/g, " ")
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\b(\d+)b\b/gi, "$1B")
    .replace(/\s(It|Instruct)$/, "")
    .replace(/^Gpt Oss (\d+)B$/i, "GPT-OSS $1B")
    .replace(/^Gpt (\d)/, "GPT-$1")
    .replace(/^Deepseek/, "DeepSeek")
    .replace(/\bGlm\b/g, "GLM");
}

/** Book pages start sooner: models that think before they write think briefly ("low"), where the service takes that
 *  setting — Gemini 2.5 and later, GPT-OSS and Qwen 3 on Groq, OpenAI's GPT-5 and later, anything on OpenRouter. (If a
 *  service refuses it, the app asks again without it.) */
export function bookSpeed(baseUrl: string, model: string): Record<string, unknown> | undefined {
  if (/generativelanguage\.googleapis\.com/.test(baseUrl) && /gemini-(2\.5|[3-9])/.test(model)) return { reasoning_effort: "low" };
  if (/api\.groq\.com/.test(baseUrl) && /gpt-oss|qwen-?3/.test(model)) return { reasoning_effort: "low" };
  if (/api\.openai\.com/.test(baseUrl) && /^(gpt-[5-9]|o\d)/.test(model)) return { reasoning_effort: "low" };
  if (/openrouter\.ai/.test(baseUrl)) return { reasoning: { effort: "low" } };
  return undefined;
}
