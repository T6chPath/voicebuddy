/** Bold labels that turn a Markdown blockquote into a highlight box ("> **Tip:** …"). */
const KINDS: [RegExp, string][] = [
  [/^(tip|tips|pro tip|hint|trick)$/i, "tip"],
  [/^(note|notes|remember|did you know|fun fact|key point|key points)$/i, "note"],
  [/^(important|warning|caution|careful|common mistake|watch out|danger)$/i, "warn"],
  [/^(example|for example|e\.g\.|analogy|real-life example|in real life)$/i, "example"],
  [/^(in short|summary|tl;?dr|in summary|key takeaway|takeaway|bottom line|short answer|answer|result|formula)$/i, "summary"],
];
export function calloutKind(label: string): string {
  const l = label.trim().replace(/[.!]$/, "");
  for (const [rx, k] of KINDS) if (rx.test(l)) return k;
  return "";
}

