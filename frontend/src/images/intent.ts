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
  text?: string;                     // exact words to show in the picture
  textLayout?: "poster" | "logo" | "caption" | "banner";
  references?: string[];             // pictures to follow: "attached" | "#3" | "latest" | "last-made"
  refMode?: "style" | "subject";     // follow the reference's look, or keep its character/object
  side?: "center" | "left" | "right" | "top" | "bottom";   // outpainting: where the new area goes
  target?: string;                   // replace_object: the thing being replaced
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
  "flat-2d": ["flat 2D illustration, clean vector shapes, bold flat colors, minimal shading, crisp edges", "photo, 3d render, noise, lowres"],
  isometric: ["isometric 3D illustration, clean geometry, soft shadows, pastel colors, high detail", "photo, flat, lowres"],
  icon: ["app icon, one simple bold symbol, centered, flat design, rounded square, high contrast, plain background", "photo, clutter, small details, text"],
  branding: ["brand identity presentation, logo applied to business card, letterhead and packaging, clean studio mockup, soft light", "clutter, lowres"],
  sticker: ["die-cut sticker, thick white border, bold outlines, vibrant colors, simple plain background", "photo, clutter, lowres"],
  watercolor: ["watercolor painting, soft washes, paper texture, gentle colors, hand painted", "photo, 3d render, lowres"],
  "oil-painting": ["oil painting, visible brush strokes, rich colors, canvas texture, classical lighting", "photo, flat, lowres"],
  "pixel-art": ["pixel art, 16-bit retro game style, crisp pixels, limited palette", "photo, smooth, blurry, lowres"],
  sketch: ["pencil sketch, graphite on paper, fine hatching, monochrome, hand drawn", "color, photo, 3d render"],
  comic: ["comic book art, bold ink outlines, halftone shading, dynamic composition, vivid colors", "photo, lowres"],
  "low-poly": ["low poly 3D art, faceted geometric shapes, flat shading, vibrant gradient colors", "photo, lowres"],
};
const STYLE_ALIASES: Record<string, string> = {
  realistic: "photorealistic", photo: "photorealistic", photograph: "photorealistic", real: "photorealistic",
  "3d render": "3d", "3-d": "3d", render: "3d", movie: "cinematic", film: "cinematic",
  cartoonish: "cartoon", "comic book": "comic", "digital art": "digital-art", digital: "digital-art",
  "2d": "flat-2d", flat: "flat-2d", vector: "flat-2d", "flat 2d": "flat-2d", "app icon": "icon", "brand identity": "branding",
  mockup: "branding", "brand kit": "branding", watercolour: "watercolor", "oil painting": "oil-painting", pixel: "pixel-art", "pixel art": "pixel-art", "8-bit": "pixel-art",
  pencil: "sketch", "line art": "sketch", "low poly": "low-poly", ghibli: "anime", "3d illustration": "3d", "3d cartoon": "3d", pixar: "3d",
  "concept art": "digital-art", illustrated: "illustration", drawing: "illustration", manga: "anime",
};
export const ASPECTS = ["1:1", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "4:5", "5:4", "21:9", "9:21"];
export const RESOLUTIONS = [512, 768, 1024, 1536, 2048];

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
const NOUNS = "(image|picture|pic|photo|photograph|logo|portrait|illustration|poster|wallpaper|artwork|art|drawing|painting|icon|sticker|banner|thumbnail|avatar|render|sketch|meme|tasveer|tasvir|chitra|foto|card|invitation|flyer|cover|label|badge|emblem|mascot|scene|mockup|infographic|thumbnail)s?";
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
  if (/\b(4k|uhd|2048|2k|ultra hd)\b/.test(t)) p.resolution = 2048;
  else if (/\b(1536|full hd|1080p)\b/.test(t)) p.resolution = 1536;
  else if (/\b(hd|high[- ]?res(olution)?|1024|detailed large)\b/.test(t)) p.resolution = 1024;
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

/* ---------- words to show in the picture ---------- */
/** "a poster that says 'Summer Sale'", "logo for a chai shop called Garam Chai", "with the text HELLO" → the words. */
export function extractText(t: string): string | undefined {
  const q = t.match(/["“”«]([^"“”»]{1,80})["“”»]|(?:^|\s)'([^']{1,80})'(?=\s|$|[,.!?])/);
  if (q && /\b(text|says?|saying|words?|title[sd]?|written|reads?|reading|name[sd]?|called|caption|heading|slogan|tagline|letters?|quote|likh\w*)\b|\blogo\b|\bposter\b|\bbanner\b|\bsign\b|\bthumbnail\b|\bcard\b/i.test(t)) return (q[1] || q[2]).trim();
  const m = t.match(/\b(?:that says|saying|which says|with the (?:text|words?|title|name|caption|heading)|with (?:text|words?|caption|title)|text|titled|reading|written|likha ho|likha)\s*[:\-]?\s+([^,.;!?\n]{1,60}?)(?=\s+(?:in|on|at|with|for|and|using|written|text)\b|[,.;!?\n]|$)/i)
    || t.match(/\b(?:called|named)\s+([A-Z0-9][\w&'’ -]{0,40}?)(?=\s+(?:in|on|at|with|for|and|using|that|which)\b|[,.;!?\n]|$)/);
  if (m) return m[1].trim().replace(/^(the|a|an)\s+/i, (x) => (/^(a|an)\s+$/i.test(x) ? "" : x)) || undefined;
  return undefined;
}

function textLayout(t: string, style?: string): Plan["textLayout"] {
  if (style === "logo" || /\blogo\b/i.test(t)) return "logo";
  if (/\b(poster|flyer|cover|card|invitation|title|heading|thumbnail|wallpaper|sign|signboard)\b/i.test(t)) return "poster";
  if (/\b(banner|meme|caption|quote)\b/i.test(t)) return "caption";
  return "poster";
}

const OUTPAINT = /\b(extend|expand|uncrop|zoom out|out-?paint\w*|widen|make (it|the image|the picture|this) (wider|taller|bigger canvas)|show more (of )?(the )?(surroundings|scene|background|area)|fill (in )?(the )?(sides|edges)|more space (around|on the (left|right|top|bottom)))\b/i;
const UPSCALE = /\b(upscale|up-?scale|upsize|super[- ]?resolution|increase (the )?(resolution|quality|size)|enhance (the )?(resolution|quality)|make (it|this|the image) (hd|4k|2k|sharper|bigger|larger|higher resolution|high resolution))\b/i;
const REPLACE_OBJ = /\b(?:replace|swap|substitute)\s+(?:the\s+|that\s+|this\s+|his\s+|her\s+|its\s+|my\s+)?(?<old>[\w\s'-]{2,40}?)\s+(?:with|for|by)\s+(?:a\s+|an\s+|the\s+|some\s+)?(?<new>[^.?!]{2,80})|\b(?:change|turn|convert)\s+(?:the\s+|that\s+|this\s+|his\s+|her\s+|its\s+)(?<old2>[\w\s'-]{2,40}?)\s+(?:in)?to\s+(?:a\s+|an\s+|the\s+)?(?<new2>[^.?!]{2,80})|\b(?<old3>[\w\s'-]{2,30}?)\s+ki jagah\s+(?<new3>[^.?!]{2,60}?)\s*(?:laga do|lagao|daalo|kar do|bana do|rakh do)?\s*$/i;
const REFERENCE = /\b(in the style of|same style as|like|similar to|based on|inspired by|using|use|from|with|matching|as a reference|reference)\s+(this|that|the attached|my|the|these)\s+(image|photo|picture|pic|style|drawing|painting|look|character|person|reference|one|logo)s?\b|\b(this|the attached|my)\s+(image|photo|picture)\s+as\s+(a\s+)?reference\b|\breference (image|photo|picture)\b/i;
const SAME = /\b(same|consistent|identical|this same|that same)\s+(character|person|girl|boy|man|woman|child|kid|guy|lady|cat|dog|animal|pet|robot|hero|mascot|face|model|car|product|object|outfit|style|look)\b|\bkeep (him|her|them|it|the (character|person|face|mascot|product|cat|dog)) (the same|consistent)\b|\b(isi|wahi|wohi|usi)\s+\w+\s+(ki|ka|ke)\b/i;
const CONTINUE = /^\s*(now|next|then|also|and)?\s*(show|draw|generate|create|imagine)\s+(him|her|them|the same)\b/i;

/** "use this as a reference and draw the same character as an astronaut" → "the character as an astronaut" */
function stripRefWords(t: string): string {
  return t.replace(new RegExp(REFERENCE.source, "gi"), " ").replace(/\b(use|using|take|with)\s+(this|it|that)\s+(as\s+(a\s+)?reference|as\s+(the\s+)?base)\b/gi, " ")
    .replace(/\b(the\s+)?(same|consistent|identical)\s+/gi, " ").replace(/^\s*(and|,)\s*/i, "").replace(/\s+and\s+(?=(draw|make|create|generate|show|put|imagine|design|paint|render)\b)/i, " ")
    .replace(/\s+/g, " ").trim();
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
  const recent = o.attachedImage || o.lastReplyHasImage;
  if (canEdit && recent && UPSCALE.test(t) && !RX.gen.test(t.replace(/\b(make|create|generate)\s+(it|this)\b/gi, ""))) {
    return plan("upscale", "", { resolution: params.resolution && params.resolution > 1024 ? params.resolution : 2048 });
  }
  if (canEdit && recent && (OUTPAINT.test(t) || (params.aspect_ratio && /\b(make|change|convert|turn|set|resize)\b/i.test(t) && t.length < 80 && !RX.gen.test(t)))) {
    const side = /\bleft\b/i.test(t) ? "left" : /\bright\b/i.test(t) ? "right" : /\b(top|above|sky)\b/i.test(t) ? "top" : /\b(bottom|below|ground)\b/i.test(t) ? "bottom" : "center";
    const what = t.replace(OUTPAINT, " ").replace(/\b(the|this|image|picture|photo|it|to|on|of|left|right|top|bottom|side|sides|and|please|show|more|with|add|make|change|convert|turn|set|resize|aspect|ratio|landscape|portrait|square|wider|taller)\b/gi, " ").replace(/\b\d{1,2}\s*[:x]\s*\d{1,2}\b/g, " ").replace(/\s+/g, " ").trim();
    return plan("outpaint", what.length > 3 ? what : "", { side });
  }
  const ro = canEdit && recent ? t.match(REPLACE_OBJ) : null;
  if (ro) {
    const g = ro.groups || {};
    const old = (g.old || g.old2 || g.old3 || "").trim(), nw = (g.new || g.new2 || g.new3 || "").trim().replace(/\s+(in|from) (the|this|my) (image|photo|picture|pic)$/i, "");
    if (old && nw && !/^(background|bg|backdrop|it|this|that|image|photo|picture|style)$/i.test(old) && !STYLE_RX.test(nw.split(" ").slice(0, 2).join(" ") + " ") ) {
      return plan("replace_object", nw, { target: old.replace(/\s+(in|from) (the|this|my) (image|photo|picture|pic)$/i, "") });
    }
  }
  if (canEdit && (o.attachedImage || o.lastReplyHasImage) && RX.variations.test(t)) return plan("variations", "", { n: params.n ?? 3 });
  const mo = t.match(RX.remove_obj);
  if (mo && canEdit && (o.attachedImage || o.lastReplyHasImage) && !RX.gen.test(t)) {
    const obj = (mo.groups?.obj || "").replace(/\b(from|in) (the|this|my) (image|photo|picture|pic)\b/i, "").trim();
    if (obj && !/^(it|this|that|them)$/i.test(obj)) return plan("remove_object", obj);
  }
  if (canEdit && (o.attachedImage || o.lastReplyHasImage) && RX.style.test(t) && params.style && !RX.gen.test(t.replace(/ it /g, " ")) && t.length < 120) {
    return plan("style", cleanEdit(t));
  }
  const refAsk = o.attachedImage && (REFERENCE.test(t) || SAME.test(t)) && /\b(draw|make|create|generate|show|put|imagine|design|paint|render|turn)\b/i.test(t);
  const genHit = refAsk || (RX.gen.test(t) && !(NOT_IMAGE.test(t) && !/\b(image|picture|photo|drawing|painting) of\b/i.test(t)));
  if (genHit && (refAsk || !(o.attachedImage && RX.edit.test(t) && !/\b(new|another|fresh)\b/i.test(t)))) {
    if (/\blogo\b/i.test(t) && (!params.style || params.style === "flat-2d")) params.style = "logo";
    let prompt = cleanPrompt(refAsk ? stripRefWords(t) : t);
    const words = extractText(t);
    if (words) {                                                     // the words go on the picture; the prompt describes the picture
      const esc = words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const rest = prompt.replace(new RegExp(`\\s*,?\\s*\\b(?:with|that says|saying|which says|reading|titled|says)?\\s*(?:the\\s+)?(?:text|words?|title|caption|heading|slogan)?\\s*[:\\-]?\\s*["“']?${esc}["”']?`, "i"), "").trim();
      prompt = rest.replace(/\s+(called|named)$/i, "").trim();
      prompt = prompt.length >= 3 ? prompt : (t.match(/\b(poster|flyer|banner|card|invitation|cover|thumbnail|sign|logo|label|badge|sticker|wallpaper)\b/i)?.[1].toLowerCase() || "poster") + " design";
    }
    if (prompt.length < 3) return plan("generate", "", { clarify: "What should the image show?" });
    const noun = t.match(/\b(poster|flyer|banner|card|invitation|cover|thumbnail|logo|sticker|wallpaper|illustration|painting|drawing)\b/i)?.[1].toLowerCase();
    if (noun && /^(about|for|of|showing|with)\b/i.test(prompt)) prompt = `${noun} ${prompt}`;
    const out: Plan = { op: "generate", prompt, image_ref: r, ...params };
    if (words) { out.text = words; out.textLayout = textLayout(t, params.style); }
    if (o.attachedImage && (REFERENCE.test(t) || SAME.test(t))) {
      out.references = ["attached"];
      out.refMode = /\b(style|look|drawing|painting)\b/i.test((t.match(REFERENCE) || t.match(SAME))![0]) && !SAME.test(t.replace(/same (style|look)/i, "")) ? "style" : "subject";
    } else if (o.hasImages && (SAME.test(t) || /\b(like|same as|based on) (image|picture|photo) ?#?\d/i.test(t))) {
      const n = t.match(/#\s*(\d{1,2})|(?:image|picture|photo)\s*#?\s*(\d{1,2})/i);
      out.references = [n ? "#" + (n[1] || n[2]) : "last-made"];
      out.refMode = /\bstyle|look\b/i.test(t) && !/\b(character|person|girl|boy|man|woman|cat|dog|mascot|face|product)\b/i.test(t) ? "style" : "subject";
    }
    return out;
  }
  // "now show her riding a bike" right after a picture: same character, new scene
  if (o.lastReplyHasImage && CONTINUE.test(t) && !NOT_IMAGE.test(t)) {
    const prompt = t.replace(CONTINUE, "").replace(/^[\s,]+/, "").trim();
    if (prompt.length >= 3) return { op: "generate", prompt, image_ref: r, ...params, references: ["last-made"], refMode: "subject" };
  }
  if (canEdit && (o.attachedImage || o.lastReplyHasImage) && RX.edit.test(t)) return plan("edit", cleanEdit(t));
  return null;
}

/** The chat model can ask for a picture itself by writing [[image: …]] (any model can, no function calling needed). */
export const MARKER = /\[\[\s*image\s*:\s*([^\]]+?)\s*\]\]/i;
