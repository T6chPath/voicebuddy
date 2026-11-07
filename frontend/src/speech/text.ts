// Same rules as backend/app/tts/text.py: Markdown → speakable text, sentence splitting, language per sentence.

export type SpeechLang = "en" | "hi" | "hinglish" | "es" | "fr" | "it" | "pt";
export interface Segment { text: string; lang: SpeechLang }

const MD: [RegExp, string][] = [
  [/```[\s\S]*?```/g, " (code omitted) "], [/`([^`]*)`/g, "$1"], [/!\[[^\]]*\]\([^)]*\)/g, " "], [/\[([^\]]+)\]\([^)]*\)/g, "$1"],
  [/https?:\/\/\S+/g, " link "], [/^\s*#{1,6}\s*/gm, ""], [/^\s*[-*•]\s+/gm, ""], [/^\s*\d+[.)]\s+/gm, ""], [/^\s*>\s?/gm, ""],
  [/^\s*\|?\s*:?-{3,}.*$/gm, ""], [/(\*\*|__|\*|_|~~)(\S(?:.*?\S)?)\1/g, "$2"], [/\s*\|\s*/g, ", "],
];
const EMOJI = /[\u{1F000}-\u{1FAFF}☀-➿️]/gu;
const DEVA = /[ऀ-ॿ]/g;
const ROMAN_HINDI = new Set(`hai hain nahi nahin kya kaise kaisa kaisi kyun kyon kyunki mera meri mere tum aap hum main mujhe
tera teri tumhara tumhari accha acha achha theek thik haan bhai yaar kar karo karna karte karta raha rahi rahe tha thi the
bahut bohot kuch abhi kal aaj matlab chalo ruko batao bolo dekho ghar kaam paisa paise ki ka ke ko se mein par aur bhi
toh to sab koi kaun kab kahan kitna kitne liye wala wali sakte sakta sakti hota hoti hote jaise agar lekin`.split(/\s+/));

export function speakable(text: string): string {
  let t = text || "";
  for (const [rx, rep] of MD) t = t.replace(rx, rep);
  t = t.replace(EMOJI, "").replace(/₹\s?([\d,]+(?:\.\d+)?)/g, "$1 rupees").replace(/₹/g, " rupees ").replace(/&/g, " and ").replace(/%/g, " percent");
  return t.split("\n").map((l) => l.split(/\s+/).filter(Boolean).join(" ")).filter((l) => l.replace(/[ ,]/g, "")).join("\n");
}

export function detectLang(text: string): SpeechLang {
  const deva = (text.match(DEVA) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (deva && deva >= 0.15 * (deva + latin)) return "hi";
  const words = text.toLowerCase().match(/[a-z]+/g) || [];
  if (words.length >= 2 && words.filter((w) => ROMAN_HINDI.has(w)).length / words.length >= 0.3) return "hinglish";
  return "en";
}

const SENT = /(?<=[.!?।॥])["'”’)]*\s+|\n+/;

function split(clean: string, maxChars = 240, minChars = 30): string[] {
  const out: string[] = [];
  for (let s of clean.split(SENT).map((x) => (x || "").trim()).filter(Boolean)) {
    while (s.length > maxChars) {
      let cut = Math.max(s.lastIndexOf(", ", maxChars), s.lastIndexOf("; ", maxChars));
      if (cut < maxChars / 3) cut = s.lastIndexOf(" ", maxChars);
      if (cut <= 0) cut = maxChars;
      out.push(s.slice(0, cut + 1).trim());
      s = s.slice(cut + 1).trim();
    }
    if (!s) continue;
    const prev = out[out.length - 1];
    if (prev && prev.length < minChars && prev.length + s.length < maxChars && detectLang(prev) === detectLang(s)) out[out.length - 1] = `${prev} ${s}`;
    else out.push(s);
  }
  return out;
}

export function segments(text: string, forced?: SpeechLang): Segment[] {
  return split(speakable(text)).map((s) => ({ text: s, lang: forced || detectLang(s) }));
}

/** For text that is still streaming: the sentences that are certainly finished. A sentence counts as finished once
 * something follows its end mark; open code fences hold everything back until they close. */
export function finishedSegments(partial: string, forced?: SpeechLang): Segment[] {
  const fences = (partial.match(/```/g) || []).length;
  let upto = partial;
  if (fences % 2 === 1) upto = partial.slice(0, partial.lastIndexOf("```"));
  const m = [...upto.matchAll(/[.!?।॥]["'”’)]*\s+|\n\s*\n/g)];
  if (!m.length) return [];
  const last = m[m.length - 1];
  const done = upto.slice(0, (last.index ?? 0) + last[0].length);
  const segs = segments(done, forced);
  // the last piece may still grow by merging with a short follower: keep it back unless it is long
  return segs.length && segs[segs.length - 1].text.length < 30 ? segs.slice(0, -1) : segs;
}
