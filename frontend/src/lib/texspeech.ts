/** Plain-language reading of simple LaTeX, for text-to-speech. */
export function texToSpeech(tex: string): string {
  let t = ` ${tex} `;
  const words: [RegExp, string][] = [
    [/\\sqrt\s*\{([^{}]*)\}/g, " square root of $1 "],
    [/\^\s*\{?2\}?/g, " squared "], [/\^\s*\{?3\}?/g, " cubed "], [/\^\s*\{([^{}]*)\}/g, " to the power $1 "], [/\^\s*(\w)/g, " to the power $1 "],
    [/_\s*\{([^{}]*)\}/g, " sub $1 "], [/_\s*(\w)/g, " sub $1 "],
    [/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, " $1 over $2 "], [/\\[dt]?frac\s*(\w)(\w)/g, " $1 over $2 "],
    [/\\(times|cdot)/g, " times "], [/\\div/g, " divided by "], [/\\pm/g, " plus or minus "], [/\\le(q)?\b/g, " less than or equal to "],
    [/\\ge(q)?\b/g, " greater than or equal to "], [/\\ne(q)?\b/g, " not equal to "], [/\\approx/g, " approximately "], [/\\infty/g, " infinity "],
    [/\\sum/g, " the sum of "], [/\\int/g, " the integral of "], [/\\lim/g, " the limit "], [/\\to\b|\\rightarrow/g, " goes to "],
    [/\\(alpha|beta|gamma|delta|epsilon|theta|lambda|mu|pi|sigma|phi|omega|Delta|Sigma|Omega)\b/g, " $1 "],
    [/\\(sin|cos|tan|log|ln|exp)\b/g, " $1 "], [/=/g, " equals "], [/\+/g, " plus "], [/(?<=\s|\w)-(?=\s|\w)/g, " minus "], [/</g, " less than "], [/>/g, " greater than "],
    [/\\(left|right|mathrm|text|mathbf|operatorname|displaystyle|,|;|!|quad|qquad)/g, " "], [/[{}\\]/g, " "],
  ];
  for (const [rx, rep] of words) t = t.replace(rx, rep);
  return t.replace(/\s+/g, " ").trim();
}
