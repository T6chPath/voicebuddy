// Is this chat message asking for a picture? Same rules as the server app (backend/app/images/intent.py), so both
// behave alike: "generate an image of …", "make a logo for …", "isko night me bana do", "remove the background",
// "make it anime style", "two more variations", plus Hinglish. Also the safety check that runs before any engine.
import type { ImageOp } from "../api/types";

export interface Plan {
  op: ImageOp;
  prompt: string;
  style?: string;
  aspect_ratio?: string;
  resolution?: number;
  n?: number;
  seed?: number;
  negative_prompt?: string;
  output_format?: "png" | "jpeg" | "webp";
  background?: string;
  image_ref: string;                 // "attached" | "latest" | "#3"
  clarify?: string;                  // ask this instead of making an image
  fresh?: boolean;                   // "regenerate": a new seed even when changing an AI-made picture
}

/* ---------- styles and sizes ---------- */
export const STYLES: Record<string, [string, string]> = {
  none: ["", ""],
  photorealistic: ["photorealistic, natural lighting, sharp focus, high detail, 35mm photograph", "cartoon, illustration, painting, drawing, cgi, lowres, blurry"],
  anime: ["anime style, cel shading, clean line art, vibrant colors, detailed anime illustration", "photorealistic, photo, 3d render, lowres, blurry"],
  "3d": ["3d render, octane render, soft global illumination, physically based materials, highly detailed", "flat, sketch, painting, lowres, blurry"],
  cinematic: ["cinematic film still, dramatic lighting, shallow depth of field, anamorphic, color graded", "cartoon, flat lighting, lowres, blurry"],
  cartoon: ["cartoon style, bold outlines, flat colors, playful, clean vector look", "photorealistic, photo, lowres, blurry"],
  "digital-art": ["digital art, concept art, trending on artstation, highly detailed, vivid colors", "photo, lowres, blurry"],
  illustration: ["illustration, storybook art, textured brush strokes, soft colors", "photo, 3d render, lowres, blurry"],
  logo: ["minimal vector logo, flat design, simple shapes, centered, plain background, crisp edges", "photo, photorealistic, clutter, gradient noise, lowres"],
};
const STYLE_ALIASES: Record<string, string> = {
  realistic: "photorealistic", photo: "photorealistic", photograph: "photorealistic", real: "photorealistic",
  "3d render": "3d", "3-d": "3d", render: "3d", movie: "cinematic", film: "cinematic",
  cartoonish: "cartoon", comic: "cartoon", "digital art": "digital-art", digital: "digital-art",
  "concept art": "digital-art", illustrated: "illustration", drawing: "illustration", manga: "anime",
};
export const ASPECTS = ["1:1", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "4:5", "5:4", "21:9"];

export function normStyle(s?: string | null): string {
  let v = (s || "none").trim().toLowerCase();
  v = STYLE_ALIASES[v] || v;
  return v in STYLES ? v : "none";
}

export function styledPrompt(prompt: string, style?: string): string {
  const add = STYLES[normStyle(style)][0];
  return add && prompt ? `${prompt}, ${add}` : prompt || add;
}

export function sizeFor(aspect: string, longest: number, multiple = 64): [number, number] {
  const [a, b] = (ASPECTS.includes(aspect) ? aspect : "1:1").split(":").map(Number);
  const [w, h] = a >= b ? [longest, (longest * b) / a] : [(longest * a) / b, longest];
  const rnd = (v: number) => Math.max(multiple, Math.round(v / multiple) * multiple);
  return [rnd(w), rnd(h)];
}

/* ---------- safety: before any engine is called ---------- */
const MINOR = "(child|children|kid|kids|minor|minors|underage|under-age|teen|teenage|teenager|preteen|schoolgirl|schoolboy|toddler|baby|infant|loli|shota|\\d\\s*-?\\s*(?:yo|years?[- ]old)|young girl|young boy|little girl|little boy)";
const SEXUAL = "(nude|naked|nsfw|sexual|sexy|porn|pornographic|erotic|explicit|lingerie|topless|undress|undressed|stripper|genitals?|nipples|sex)";
const UNDRESS = /(undress|remove (her|his|their|the) (clothes|clothing|shirt|dress|top|bra)|take off (her|his|their) (clothes|clothing)|make (her|him|them) (naked|nude)|nudify|x-?ray (her|him|them))/i;
const GORE = "(dismember\\w*|decapitat\\w*|beheading|disembowel\\w*|mutilat\\w*|gore|gory|torture)";
const EXTREMISM = "(swastika|isis flag|nazi propaganda|terrorist propaganda)";
const SAFETY: [RegExp, string][] = [
  [new RegExp(`\\b${MINOR}\\b[\\s\\S]*\\b${SEXUAL}\\b|\\b${SEXUAL}\\b[\\s\\S]*\\b${MINOR}\\b`, "i"), "I can't create sexual or suggestive images involving minors."],
  [new RegExp(`\\b${SEXUAL}\\b`, "i"), "I can't create sexual or nude images."],
  [new RegExp(`\\b${GORE}\\b`, "i"), "I can't create graphic violence or gore."],
  [new RegExp(`\\b${EXTREMISM}\\b`, "i"), "I can't create extremist propaganda."],
];

/** A user-facing reason when the request isn't allowed, else null. */
export function safetyCheck(text: string, editingPhoto = false): string | null {
  const t = (text || "").split(/\s+/).join(" ");
  if (editingPhoto && UNDRESS.test(t)) return "I can't remove clothing from or sexualise a photo of a person.";
  for (const [rx, msg] of SAFETY) if (rx.test(t)) return msg;
  return null;
}

/* ---------- the rules ---------- */
const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, ek: 1, do: 2, teen: 3, char: 4, chaar: 4 };
const NOUNS = "(image|picture|pic|photo|photograph|logo|portrait|illustration|poster|wallpaper|artwork|art|drawing|painting|icon|sticker|banner|thumbnail|avatar|render|sketch|meme|tasveer|tasvir|chitra|foto)s?";
const GEN_VERB = "(generate|create|make|draw|paint|design|render|sketch|produce|imagine|illustrate|banao|bana do|banado|bnao|bana de|banaiye)";
const NOT_IMAGE = /\b(code|script|function|component|react|html|css|javascript|typescript|python|java|kotlin|program|website|web ?site|api|sql|database|regex|essay|email|story|poem|song|list|table|plan|summary|resume|graph|plot|chart|pdf)\b|\b(image|picture|photo)\s+(gallery|viewer|editor|upload\w*|slider|carousel|folder|files?|compression|classifier|dataset)\b/i;
const QUESTION = /^\s*(how|what|why|which|when|where|who|explain|tell me about|kya|kaise|kyun)\b/i;
const STYLE_WORDS = [...new Set([...Object.keys(STYLES).filter((s) => s !== "none"), ...Object.keys(STYLE_ALIASES)])].sort((a, b) => b.length - a.length);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const STYLE_RX = new RegExp(`\\b(${STYLE_WORDS.map((w) => esc(w).replace(/\\-/g, "[- ]?").replace(/-/g, "[- ]?")).join("|")})\\b`, "i");

const RX = {
  remove_bg: /\b(remove|erase|delete|cut ?out|get rid of|clear|hata\w*|nikal\w*)\s+(the\s+|its\s+|my\s+|this\s+)?(background|bg|backdrop)\b|\b(background|bg)\s+(hatao|hata do|hata de|remove|nikalo|nikal do|hatana|delete|erase)\b|\btransparent (background|bg)\b|\bbackground transparent\b|\bremove\s?bg\b|\bno background\b/i,
  replace_bg: /\b(change|replace|swap|switch|set|make)\s+(the\s+|its\s+|my\s+|this\s+)?(background|bg|backdrop)\b(\s+(to|with|into|as|for|of))?\s*(?<bg>[^.?!]*)|\b(background|bg)\s+(to|with|into)\s+(?<bg2>[^.?!]+)|\b(put|place)\s+(him|her|it|them|me|this|that|the \w+)\s+(on|in|at|against)\s+(?<bg3>[^.?!]+)|\b(?<bg4>[\w\s,-]{2,60}?)\s+(ka|ki|wala)\s+(background|bg)\s+(lagao|laga do|daalo|kar do|karo)\b|\b(background|bg)\s+(badlo|badal do|change karo|change kar do)\b/i,
  remove_obj: /\b(remove|erase|delete|get rid of|take out|take away|hide|hata do|hatao|hata de|mita do)\s+(the\s+|that\s+|this\s+|those\s+|these\s+|a\s+|an\s+)?(?<obj>[\w\s'-]{2,50}?)(\s+(from|in|on)\s+(the|this|my)\s+(image|photo|picture|pic))?\s*$/i,
  variations: /\b(variations?|another version|more versions|other versions|different versions?|similar (ones?|images?)|more like (this|that|it)|alternatives?|re-?roll)\b/i,
  style: new RegExp(`\\b(make|turn|convert|redraw|render|change|transform|bana\\w*|kar\\w*)\\b.*\\b(${STYLE_WORDS.map(esc).join("|")})\\b`, "i"),
  edit: /^\s*(now\s+|also\s+|and\s+|ok\s+|okay\s+|please\s+|can you\s+|could you\s+)*(make|change|add|turn|put|give|replace|edit|adjust|brighten|darken|colou?r|fix|let|place|move|swap|convert)\b|\b(make it|make the|change (it|the|this)|add (a|an|some|the)|edit (it|this|the)|in (the|this) (image|photo|picture)|isko|ise|isme)\b/i,
  gen: new RegExp(`\\b${GEN_VERB}\\b.*\\b${NOUNS}\\b|\\b${NOUNS}\\b.*\\b${GEN_VERB}\\b|^\\s*(an?\\s+)?(image|picture|photo|drawing|painting|illustration|render) of\\b|^\\s*((hey|hi|ok|okay|please|pls|plz|kindly|can you|could you|would you|will you)[\\s,]+)*(draw|paint|sketch|illustrate|imagine)\\b|\\btext[- ]to[- ]image\\b`, "i"),
  image_word: new RegExp(`\\b(${NOUNS}|it|this|that|the one|isko|ise|isme|use)\\b`, "i"),
};

type Params = Omit<Plan, "op" | "prompt" | "image_ref" | "clarify">;

export function extractParams(text: string): Params {
  const t = text.toLowerCase();
  const p: Params = {};
  let m = t.match(/\b(\d{1,2})\s*[:x×]\s*(\d{1,2})\b/);
  if (m && ASPECTS.includes(`${m[1]}:${m[2]}`)) p.aspect_ratio = `${m[1]}:${m[2]}`;
  else if (/\b(phone wallpaper|mobile wallpaper|story|reel|vertical|tall)\b/.test(t)) p.aspect_ratio = "9:16";
  else if (/\bportrait (orientation|mode|format)\b|\bin portrait\b/.test(t)) p.aspect_ratio = "2:3";
  else if (/\b(landscape|horizontal|widescreen|wide|desktop wallpaper|youtube thumbnail|thumbnail|banner)\b/.test(t)) p.aspect_ratio = "16:9";
  else if (/\b(square|instagram post|profile picture|avatar|logo|icon)\b/.test(t)) p.aspect_ratio = "1:1";
  m = t.match(/\b(\d|one|two|three|four|ek|do|teen|chaar|char)\s+(?:[a-z0-9:-]+\s+){0,3}?(images|pictures|pics|photos|variations|versions|options|logos|ideas|designs|wallpapers|portraits|posters|icons|stickers|alag)\b/);
  if (m) p.n = /^\d$/.test(m[1]) ? +m[1] : NUM[m[1]];
  m = t.match(/\bseed\s*(?:=|:|of|#)?\s*(\d{1,10})\b/);
  if (m) p.seed = +m[1];
  if (/\b(4k|2k|hd|high[- ]?res(olution)?|1024|detailed large)\b/.test(t)) p.resolution = 1024;
  else if (/\b768\b/.test(t)) p.resolution = 768;
  else if (/\b(quick|fast|small|draft|512)\b/.test(t)) p.resolution = 512;
  m = t.match(/\b(?:as|in|to|format)\s+(?:a\s+)?(png|jpe?g|webp)\b|\b(png|jpe?g|webp)\s+(?:format|file)\b/);
  if (m) p.output_format = (m[1] || m[2]).replace("jpg", "jpeg") as Params["output_format"];
  m = t.match(/\bnegative(?: prompt)?\s*[:=]\s*([^.;\n]+)|\bavoid(?:ing)?\s+([^.;\n]+)/);
  if (m) p.negative_prompt = (m[1] || m[2]).trim();
  m = t.match(STYLE_RX);
  if (m) { const w = m[1].replace(/ /g, "-"); p.style = normStyle(w in STYLES ? w : m[1]); }
  return p;
}

const STRIP_PARAMS = [
  /\b(in|at|with)?\s*(\d{1,2})\s*[:x×]\s*(\d{1,2})( aspect( ratio)?)?\b/gi, /\bseed\s*(=|:|of|#)?\s*\d+\b/gi,
  /\b(as|in)\s+(a\s+)?(png|jpe?g|webp)( format| file)?\b/gi, /\bnegative(?: prompt)?\s*[:=][^.;\n]+/gi,
  /\b(\d|one|two|three|four)\s+(images|pictures|pics|photos|variations|versions|options|ideas|designs)\b/gi,
  /\b(in )?(hd|4k|2k|high[- ]?res(olution)?)\b/gi, /\bin (landscape|portrait|square)( (orientation|mode|format))?\b/gi,
];
const LEAD = new RegExp(
  `^\\s*(hey|hi|ok|okay|please|pls|plz|kindly)?[\\s,]*(can|could|would|will)?\\s*(you)?\\s*(please|pls)?\\s*${GEN_VERB}?\\s*(me|us)?\\s*(an?|the|some|ek)?\\s*` +
  "((\\d|one|two|three|four|high[- ]quality|hd|quick|simple|nice|cool|beautiful|stunning|detailed|new|ai)\\s+)*" +
  "(((anime|cartoon|realistic|photorealistic|3d|cinematic|digital[- ]art|illustration|logo)\\s+style\\s+|phone\\s+|mobile\\s+|desktop\\s+)*" +
  "(image|picture|pic|photo|photograph|illustration|drawing|painting|render|artwork|art|wallpaper|poster|portrait|icon|sticker|banner|avatar|thumbnail)s?\\s*(of|showing|with|that shows|depicting|for)?\\s*)?", "i");
const TAIL_HI = /\s*(ki|ka|ke)?\s*(ek\s+)?(image|photo|picture|tasveer|tasvir|foto|pic)?\s*(banao|bana do|banado|bnao|bana de|banaiye|chahiye|do)\s*$/i;

export function cleanPrompt(text: string): string {
  let t = text.trim();
  for (const rx of STRIP_PARAMS) t = t.replace(rx, " ");
  t = t.replace(TAIL_HI, "");
  t = t.replace(LEAD, "");
  t = t.replace(new RegExp(`,\\s*(in\\s+)?(an?\\s+)?(${STYLE_WORDS.map(esc).join("|")})(\\s+style)?\\s*(?=,|$)`, "gi"), "");
  t = t.replace(/\s+/g, " ").replace(/^[\s,.;:!-]+|[\s,.;:!-]+$/g, "");
  return t || text.trim();
}

const EDIT_LEAD = /^\s*((now|also|and|ok|okay|please|pls|can you|could you)\s+)*(make|turn|change|convert|edit|render|redraw|transform)\s+(it|this|that|the (image|photo|picture|pic)|the whole thing|everything)?\s*(into|to|look|be|in|as|more)?\s*(like\s+)?(an?\s+)?/i;

export function cleanEdit(text: string): string {
  let t = text.trim().replace(EDIT_LEAD, "");
  for (const rx of STRIP_PARAMS) t = t.replace(rx, " ");
  t = t.replace(/\s+/g, " ").replace(/^[\s,.;:!-]+|[\s,.;:!-]+$/g, "");
  return t || text.trim();
}

function ref(text: string, attached: boolean): string {
  if (attached) return "attached";
  const m = text.match(/(?:image|picture|photo|pic|#)\s*#?(\d{1,2})\b/i);
  if (m) return "#" + m[1];
  for (const [word, k] of [["first", 1], ["second", 2], ["third", 3]] as const) {
    if (new RegExp(`\\b${word} (one|image|picture|photo)\\b`, "i").test(text)) return `#${k}`;
  }
  return "latest";
}

/** Rules route: a Plan when the message clearly asks for an image (or a change to one), else null. */
export function detect(text: string, o: { attachedImage: boolean; hasImages: boolean; lastReplyHasImage: boolean }): Plan | null {
  const t = text.split(/\s+/).join(" ").trim();
  if (!t || t.length > 1500) return null;
  const params = extractParams(t);
  const canEdit = o.attachedImage || o.hasImages;
  const r = ref(t, o.attachedImage);
  const aboutImage = o.attachedImage || o.lastReplyHasImage || RX.image_word.test(t);
  const plan = (op: ImageOp, prompt = "", extra: Partial<Plan> = {}): Plan => ({ op, prompt, image_ref: r, ...params, ...extra });

  if (canEdit && aboutImage && RX.remove_bg.test(t)) return plan("remove_background");
  const mb = canEdit && aboutImage ? t.match(RX.replace_bg) : null;
  if (mb) {
    const g = mb.groups || {};
    let bg = [g.bg, g.bg2, g.bg3, g.bg4].find((x) => x && x.trim()) || "";
    bg = bg.trim().replace(/^[ ,.]+|[ ,.]+$/g, "").replace(/^(a|an|the)\s+/i, "").trim();
    if (!bg) return plan("replace_background", "", { clarify: "What should the new background be? For example: “a beach at sunset” or “plain white”." });
    return plan("replace_background", bg, { background: bg });
  }
  if (QUESTION.test(t) && !RX.gen.test(t.split("?").pop() || "")) return null;
  if (canEdit && (o.attachedImage || o.lastReplyHasImage) && RX.variations.test(t)) return plan("variations", "", { n: params.n ?? 3 });
  const mo = t.match(RX.remove_obj);
  if (mo && canEdit && (o.attachedImage || o.lastReplyHasImage) && !RX.gen.test(t)) {
    const obj = (mo.groups?.obj || "").replace(/\b(from|in) (the|this|my) (image|photo|picture|pic)\b/i, "").trim();
    if (obj && !/^(it|this|that|them)$/i.test(obj)) return plan("remove_object", obj);
  }
  if (canEdit && (o.attachedImage || o.lastReplyHasImage) && RX.style.test(t) && params.style && !RX.gen.test(t.replace(/ it /g, " ")) && t.length < 120) {
    return plan("style", cleanEdit(t));
  }
  const genHit = RX.gen.test(t) && !(NOT_IMAGE.test(t) && !/\b(image|picture|photo|drawing|painting) of\b/i.test(t));
  if (genHit && !(o.attachedImage && RX.edit.test(t) && !/\b(new|another|fresh)\b/i.test(t))) {
    if (/\blogo\b/i.test(t) && !params.style) params.style = "logo";
    const prompt = cleanPrompt(t);
    if (prompt.length < 3) return plan("generate", "", { clarify: "What should the image show?" });
    return { op: "generate", prompt, image_ref: r, ...params };
  }
  if (canEdit && (o.attachedImage || o.lastReplyHasImage) && RX.edit.test(t)) return plan("edit", cleanEdit(t));
  return null;
}

/** The chat model can ask for a picture itself by writing [[image: …]] (any model can, no function calling needed). */
export const MARKER = /\[\[\s*image\s*:\s*([^\]]+?)\s*\]\]/i;
