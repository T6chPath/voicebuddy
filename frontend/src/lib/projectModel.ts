/** Projects (an app, a website, a game, a program with several files) are written with the strongest coding model on the
 *  user's own AI service. Model names change every few months, so models are matched by family and the newest version
 *  wins — whatever the service lists today. */
import type { ModelInfo } from "../api/types";
import { detect } from "../images/intent";
import { isPictureModel } from "../images/pictureModels";
import { bare, isFree, preview, version } from "./bookModel";

type Rank = { re: RegExp; pick: boolean };
const R = (re: RegExp, pick = true): Rank => ({ re, pick });

/** Coding strength, best first. `pick: false` = never switched to (paid-only, very costly or not for chat), but a model the
 *  user chose from these is kept: it is already stronger than anything the app would pick. */
const RANKS: Rank[] = [
  R(/(?:^|\/)claude-(?:fable|mythos)/, false),                                         // Anthropic's top tier
  R(/(?:^|\/)gpt-\d+(?:\.\d+)?-pro(?:-\d{4}-\d{2}-\d{2})?$/, false),                     // OpenAI Pro (very costly)
  R(/(?:^|\/)gemini-(?:[3-9]|\d{2,})(?:\.\d+)?-pro/, false),                            // Gemini 3+ Pro: paid keys only
  R(/(?:^|\/)claude-opus-\d+(?:[-.]\d+)?(?:-\d{8})?$/),                                 // Claude Opus
  R(/(?:^|\/)gpt-\d+(?:\.\d+)?(?:-\d{4}-\d{2}-\d{2})?$/),                               // OpenAI's flagship GPT
  R(/(?:^|\/)claude-sonnet-\d+(?:[-.]\d+)?(?:-\d{8})?$/),                               // Claude Sonnet
  R(/(?:^|\/)gemini-\d+(?:\.\d+)?-flash(?:-latest)?$/),                                 // Google: the newest Flash (free keys too)
  R(/(?:^|\/)gemini-[12](?:\.\d+)?-pro/, false),                                        // an older Pro: the newest Flash codes better
  R(/(?:^|\/)deepseek-(?:v\d+(?:\.\d+)?-)?pro$/),                                       // DeepSeek Pro
  R(/(?:^|\/)deepseek-flash$/), R(/(?:^|\/)deepseek-v\d+(?:\.\d+)?-flash(?:-\d{4})?$/), R(/(?:^|\/)deepseek-chat$/),
  R(/(?:^|\/)devstral(?!-small)[\w.-]*$/), R(/(?:^|\/)mistral-large(?:-latest|-[\d-]+)?$/),
  R(/(?:^|\/)codestral(?:-latest|-[\d-]+)?$/), R(/(?:^|\/)mistral-medium(?:-latest|-[\d-]+)?$/),
  R(/(?:^|\/)qwen-?3(?:\.\d+)?-coder(?!.*(?:flash|30b))/), R(/(?:^|\/)kimi-k\d/), R(/(?:^|\/)glm-?(?:[5-9]|4\.[6-9])(?!.*(?:air|flash))/),
  R(/(?:^|\/)minimax-m\d/),
  R(/nemotron.*ultra/),                                                                // OpenRouter's biggest free model
  R(/(?:^|\/)gpt-oss-120b$/),                                                          // Groq
  R(/nemotron.*super/), R(/(?:^|\/)glm-?\d/), R(/(?:^|\/)qwen-?3(?:\.\d+)?-coder/),
  R(/(?:^|\/)claude-haiku-\d+(?:[-.]\d+)?(?:-\d{8})?$/), R(/(?:^|\/)gpt-\d+(?:\.\d+)?-mini$/),
  R(/(?:^|\/)qwen-?3/), R(/(?:^|\/)llama-?4/), R(/(?:^|\/)gemma-?4/),
  R(/coder|codestral|\bcode\b/),                                                       // other coding models
  R(/^openrouter\/free$/),                                                             // OpenRouter picks a free one
];

/** Not for writing a project: made for something else (speech, pictures, search…) or only on another API (Codex). */
const UNFIT = /lite|nano|live|tts|image|audio|embed|guard|transcri|translate|robotics|research|agent|antigravity|omni|realtime|search|computer|codex|instant|-chat-latest/i;
/** A coding model the user chose themselves (Codestral, Devstral, Qwen Coder, Codex…): it stays. */
const CODING = /coder|codestral|devstral|codex|\bcode\b|grok-code/i;
/** Small or quick models that a project outgrows (up to about 32 billion parameters). */
const SMALL = /lite|nano|mini|small|tiny|instant|(?:^|[-:_/])(?:[1-9]|[12]\d|3[0-2])(?:\.\d+)?b(?:$|[-:_])/i;

const name = (id: string) => bare(id).replace(/:free$/, "");
const rankOf = (id: string) => RANKS.findIndex((r) => r.re.test(name(id)) && !UNFIT.test(name(id)));
const size = (id: string) => +(name(id).match(/(\d+)b(?:$|[-:_])/i)?.[1] || 0);
const newer = (a: string, b: string) => {
  const va = version(a), vb = version(b);
  return va[0] - vb[0] || va[1] - vb[1];
};

/** The model a project should be written with, from the service's list — or null to keep the chat's own model: it is
 *  already the strongest (or a coding model the user chose), or there is nothing better (one model on a laptop, the
 *  offline demo). On OpenRouter a free key stays on free models; with pictures attached, the model must see them. */
export function bestProjectModel(models: ModelInfo[], current: string, needsVision = false): ModelInfo | null {
  const all = models.filter((m) => m.id !== "echo" && !m.pictures && !isPictureModel(m.id));
  if (!all.length) return null;
  const listed = all.some((m) => m.id === current);
  if (listed && CODING.test(name(current))) return null;
  const router = all.some((m) => isFree(m.id));
  let pool = router && (isFree(current) || !listed) ? all.filter((m) => isFree(m.id)) : all;
  if (needsVision) pool = pool.filter((m) => m.vision);
  let best: ModelInfo | null = null, bestRank = -1;
  for (let r = 0; r < RANKS.length && !best; r++) {
    if (!RANKS[r].pick) continue;
    const hits = pool.filter((m) => RANKS[r].re.test(name(m.id)) && !UNFIT.test(name(m.id)));
    if (!hits.length) continue;
    hits.sort((a, b) => Number(preview(a.id)) - Number(preview(b.id)) || newer(b.id, a.id) || size(b.id) - size(a.id) || a.id.length - b.id.length);
    best = hits[0];
    bestRank = r;
  }
  if (!best || best.id === current) return null;
  if (!listed) return best;                                    // a picture model, the demo, a model the service no longer lists
  const cur = rankOf(current);
  if (cur === -1) return SMALL.test(name(current)) ? best : null;   // an unknown model: only a small one is replaced
  if (cur < bestRank) return null;                             // already stronger (a Pro, Opus…)
  if (cur === bestRank && newer(best.id, current) <= 0) return null;
  return best;
}

/* ---------------- is this a request to build something? ---------------- */
const VERB = String.raw`(?:make|create|build|develop|write|code|generate|design|program|implement|set ?up)`;
const HINDI_VERB = String.raw`(?:bana(?:o|do|a ?do|iye|na|ke|kar)?|banado|chahiye)`;
const THING = String.raw`(?:(?:android |ios |mobile |desktop |web |flutter |react |pwa )?apps?(?! icon)|application|websites?|web ?sites?|sites?(?! visit)|web ?pages?|webpage|landing ?page|games?(?! plan)|software|dashboard|admin panel|(?:rest |graphql )?api(?! key)|back-?end|front-?end|full[- ]?stack|(?:browser|chrome|firefox|edge|vs ?code) extension|chat ?bot|(?:discord|telegram|whatsapp|slack) bot|bot|calculator|clone|e-?commerce|online (?:store|shop)|(?:management|billing|inventory|attendance|booking|reservation|login|payment|recommendation|voting|banking|hospital|library|school|student|employee|hotel|parking|ticket(?:ing)?|chat) system|cli tool|compiler|interpreter|emulator)`;
/** Words that make it writing, not building: "write an essay about historic sites", "make a list of websites". */
const WRITING = String.raw`(?:essay|article|story|poem|letter|email|mail|report|paragraph|speech|summary|notes?|list|plan|post|caption|review|description|blog|quiz|questions?|answers?|explanation|lesson|book|pdf|table|chart|comparison|names?|ideas?|slogan|tagline|script for|presentation|slides?)`;
const APPISH = String.raw`(?:apps?|application|website|web ?app|site|web ?page|game|bot|tool|manager|tracker|maker|generator|system)`;
const GAP = String.raw`(?:\s+(?!${WRITING}\b(?!\s+${APPISH}\b))[\w'+#./&-]+){0,6}?\s+`;
const LANG = String.raw`(?:python|java(?!script)|javascript|typescript|node(?:\.?js)?|react(?: native)?|next\.?js|vue(?:\.?js)?|angular|svelte|flutter|dart|kotlin|swift(?:ui)?|c\+\+|c#|golang|rust|php|laravel|django|flask|fastapi|spring(?: boot)?|express(?:\.?js)?|html(?:\s*(?:\/|,|and|&)?\s*css)?|tailwind|bootstrap|mysql|mongodb|mern|mean|unity|pygame|tkinter|streamlit|electron|ruby on rails|rails)`;
const CODE_WORD = String.raw`(?:program|script|code|project|app|application|website|game|bot|api|backend|frontend|server|cli|gui)`;
const BUILD = new RegExp(String.raw`\b${VERB}(?:\s+me)?${GAP}${THING}\b`, "i");
const BUILD_HINDI = new RegExp(String.raw`\b${THING}\b(?:\s+[\w'-]+){0,3}?\s+${HINDI_VERB}\b`, "i");
const IN_LANG = new RegExp(String.raw`\b${VERB}${GAP}(?:in|using|with)\s+${LANG}(?![\w+#])`, "i");
const LANG_CODE = new RegExp(String.raw`(?:^|[^\w+#])${LANG}\s+${CODE_WORD}s?\b`, "i");
const PROJECT = /\b(?:large|big|huge|complete|full|whole|entire|mini|major|final[- ]year|college|capstone|coding|code|programming|software|web|app|website|python|java|javascript|react|html|node|flutter|android|full[- ]?stack|backend|frontend|django|flask|php|mern|c\+\+|machine learning|ml|ai|iot|arduino)\s+projects?\b|\bprojects?\s+(?:in|using|with)\s+(?:python|java|javascript|react|html|node|flutter|django|flask|php|c\+\+)\b/i;
const FULL_CODE = /\b(?:complete|full|whole|entire|source)\s+code\b/i;
const NOT_BUILD = /^(?:please\s+)?(?:explain|tell me|what|why|how|who|when|where|which|is|are|does|can you explain|teach me|summari[sz]e|translate|define|compare)\b|\bpdf\b|^continue the book:/i;

/** Whether a message asks the AI to build something with code: an app, a website, a game, a program, a whole project.
 *  Questions ("how do I build a website?"), PDFs, writing ("an essay about historic sites") and pictures ("make an app
 *  icon") are not projects. */
export function isProjectRequest(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (/^make an app:/i.test(t)) return true;                         // the "Build an app" shortcut
  if (t.length > 4000 || NOT_BUILD.test(t)) return false;
  if (detect(t, { attachedImage: false, hasImages: false, lastReplyHasImage: false })) return false;
  return BUILD.test(t) || BUILD_HINDI.test(t) || IN_LANG.test(t) || LANG_CODE.test(t) || PROJECT.test(t) || FULL_CODE.test(t);
}
