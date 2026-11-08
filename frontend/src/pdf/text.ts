// Turning pdf.js text items into readable text (no pdf.js import here, so it can be unit-tested).
export type Item = { str?: string; hasEOL?: boolean; transform?: number[]; height?: number };

/** Words of a page in reading order, with line breaks where the PDF has them (or where the baseline moves). */
export function pageText(items: Item[]): string {
  let out = "";
  let lastY: number | null = null;
  for (const it of items) {
    if (typeof it.str !== "string") continue;
    const y = it.transform?.[5];
    if (lastY !== null && y !== undefined && it.str && !/\n$/.test(out) && Math.abs(y - lastY) > Math.max(2, (it.height || 10) * 0.6)) out += "\n";
    out += it.str;                                   // pdf.js already puts spaces where the PDF has gaps
    if (it.hasEOL) out += "\n";
    if (y !== undefined && it.str) lastY = y;
  }
  return fixIndic(out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim());
}

// Indic scripts in PDFs are stored in display order: the short-i sign (ि) is drawn before its consonant cluster, so
// "दिल्ली" comes out as "िदल्ली"; and a gap inside a conjunct can give "दिल् ली". Put them back in reading order.
const CONS = "[\\u0915-\\u0939\\u0958-\\u095F\\u0979-\\u097F]\\u093C?";        // Devanagari consonant (+ nukta)
const PRE_I: [RegExp, string][] = [
  [new RegExp(`\\u093F((?:${CONS}\\u094D)*${CONS})`, "g"), "$1\u093F"],
  [/\u09BF((?:[\u0995-\u09B9\u09DC-\u09DF]\u09BC?\u09CD)*[\u0995-\u09B9\u09DC-\u09DF]\u09BC?)/g, "$1\u09BF"],   // Bengali ি
  [/\u0A3F((?:[\u0A15-\u0A39\u0A59-\u0A5E]\u0A3C?\u0A4D)*[\u0A15-\u0A39\u0A59-\u0A5E]\u0A3C?)/g, "$1\u0A3F"],   // Gurmukhi ਿ
];
export function fixIndic(text: string): string {
  if (!/[\u0900-\u0A7F]/.test(text)) return text;
  let t = text.replace(/([\u094D\u09CD\u0A4D]) (?=[\u0900-\u0A7F])/g, "$1");          // no space right after a virama
  for (const [re, to] of PRE_I) t = t.replace(re, to);
  return t;
}

/** Text from fonts without a Unicode map comes out as nonsense: Kruti Dev Hindi gives "Hkkjr dh jkt/kkuh",
 * symbol fonts give private-use characters or �. Then the page is better sent as a picture. */
export function looksGarbled(text: string): boolean {
  const chars = text.replace(/\s/g, "");
  if (chars.length < 20) return false;
  const bad = (chars.match(/[\uFFFD\uE000-\uF8FF\u0000-\u0008\u000E-\u001F]/g) || []).length;
  if (bad / chars.length > 0.1) return true;
  const words = text.match(/[A-Za-z]{2,}/g) || [];
  if (words.length < 6) return false;
  const noVowel = words.filter((w) => !/[aeiouyAEIOUY]/.test(w)).length / words.length;
  const oddCaps = words.filter((w) => /[a-z][A-Z]/.test(w)).length / words.length;     // "fnYyh", "ubZ"
  return noVowel + oddCaps * 0.6 > 0.35;
}

