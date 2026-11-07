import assert from "node:assert/strict";
import { test } from "node:test";
import { extractMath, restoreMath, texToSpeech } from "./math";

test("finds every delimiter style", () => {
  const { text, blocks } = extractMath("Euler: $e^{i\\pi}+1=0$ and \\(a^2+b^2=c^2\\).\n\n$$\\int_0^1 x^2\\,dx=\\frac13$$\n\n\\[\\sum_{n=1}^\\infty \\frac1{n^2}=\\frac{\\pi^2}{6}\\]");
  assert.deepEqual(blocks.map((b) => [b.tex, b.display]), [
    ["\\int_0^1 x^2\\,dx=\\frac13", true], ["\\sum_{n=1}^\\infty \\frac1{n^2}=\\frac{\\pi^2}{6}", true],
    ["a^2+b^2=c^2", false], ["e^{i\\pi}+1=0", false]]);
  assert.ok(!text.includes("$") && !text.includes("\\("));
});

test("money, code and escaped dollars are not math", () => {
  for (const s of ["It costs $5 and $10 later.", "Price: $3.50 or $4", "use `$x = 1` in PHP", "```bash\necho $HOME $PATH\n```", "Literal \\$x\\$ here"]) {
    assert.equal(extractMath(s).blocks.length, 0, s);
  }
  assert.equal(extractMath("```math\nE = mc^2\n```").blocks[0].display, true);
});

test("renders KaTeX HTML + MathML, keeps errors visible", () => {
  const { text, blocks } = extractMath("Area $A=\\pi r^2$.\n\n$$x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}$$");
  const html = restoreMath(text.split(/\n{2,}/).filter((x) => x.trim()).map((x) => `<p>${x.trim()}</p>`).join("\n"), blocks);
  assert.match(html, /class="math-inline"><span class="katex">/);
  assert.match(html, /<math xmlns="http:\/\/www\.w3\.org\/1998\/Math\/MathML"/);
  assert.match(html, /class="math-display".*data-copy-tex="x=\\frac\{-b\\pm\\sqrt\{b\^2-4ac\}\}\{2a\}"/s);
  assert.equal(extractMath("a lone $ sign, and $ spaced $ dollars").blocks.length, 0);
  const err = extractMath("$$\\badcommand{x}$$");
  assert.match(restoreMath(`<p>${err.text.trim()}</p>`, err.blocks), /<code class="math-source"[^>]*>\$\$\\badcommand\{x\}\$\$<\/code>/);
});

test("formulas are read aloud in words", () => {
  assert.equal(texToSpeech("x^2 + y^2 = r^2"), "x squared plus y squared equals r squared");
  assert.equal(texToSpeech("\\frac{a}{b}"), "a over b");
  assert.equal(texToSpeech("\\sqrt{2} \\approx 1.414"), "square root of 2 approximately 1.414");
  assert.equal(texToSpeech("x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}"), "x equals minus b plus or minus square root of b squared minus 4ac over 2a");
});

test("a stray $$ doesn't swallow later paragraphs", () => {
  const src = "Question was cut off: $$\\sum_{k=0}^{n}\n\nNow the real one:\n\n$$x = \\frac{-b}{2a}$$\n\nand $$y = 1$$";
  const { blocks } = extractMath(src);
  assert.deepEqual(blocks.map((b) => b.tex), ["x = \\frac{-b}{2a}", "y = 1"]);
});
