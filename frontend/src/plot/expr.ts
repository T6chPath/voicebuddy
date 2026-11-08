// A small, safe maths-expression parser for the graph plotter (no eval / new Function: expressions come from the AI
// and from users). Understands how people actually write maths:
//   2x, 3sin(x), (x+1)(x-1), x y          implicit multiplication
//   sin x, sin 2x, sin^2 x, cos x sin x   functions without brackets
//   |x - 1|, x², √x, π, θ, ×, ÷, −         bars, unicode
//   \frac{1}{x}, \sqrt{x}, e^{-x^2}        LaTeX
//   x!, log(x) (base 10), ln, log(x, 2), mod(x, 3), min/max, floor/ceil/round, gamma …
// Parsed once into a tree and compiled to plain closures, so evaluating thousands of points is fast.

export type Scope = Record<string, number>;
export type Compiled = (s: Scope) => number;

export class ExprError extends Error {
  constructor(msg: string) { super(msg); this.name = "ExprError"; }
}

function gamma(x: number): number {                       // Lanczos approximation
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gamma(1 - x));
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return Math.sqrt(2 * Math.PI) * Math.pow(t, x + 0.5) * Math.exp(-t) * a;
}

const F1: Record<string, (x: number) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, sec: (x) => 1 / Math.cos(x), csc: (x) => 1 / Math.sin(x), cosec: (x) => 1 / Math.sin(x),
  cot: (x) => 1 / Math.tan(x), asin: Math.asin, acos: Math.acos, atan: Math.atan, arcsin: Math.asin, arccos: Math.acos, arctan: Math.atan,
  acot: (x) => Math.PI / 2 - Math.atan(x), asec: (x) => Math.acos(1 / x), acsc: (x) => Math.asin(1 / x),
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, asinh: Math.asinh, acosh: Math.acosh, atanh: Math.atanh,
  sech: (x) => 1 / Math.cosh(x), csch: (x) => 1 / Math.sinh(x), coth: (x) => 1 / Math.tanh(x),
  exp: Math.exp, ln: Math.log, log10: Math.log10, log2: Math.log2, lg: Math.log10, sqrt: Math.sqrt, cbrt: Math.cbrt,
  abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign, sgn: Math.sign, trunc: Math.trunc,
  frac: (x) => x - Math.floor(x), gamma, fact: (x) => gamma(x + 1), factorial: (x) => gamma(x + 1),
  sinc: (x) => (x === 0 ? 1 : Math.sin(x) / x), erf: (x) => {
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return x >= 0 ? y : -y;
  },
  heaviside: (x) => (x < 0 ? 0 : 1), step: (x) => (x < 0 ? 0 : 1),
};
const FN: Record<string, (...a: number[]) => number> = {
  log: (x, b) => (b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b)),
  pow: Math.pow, atan2: Math.atan2, min: Math.min, max: Math.max, hypot: Math.hypot,
  mod: (a, b) => ((a % b) + b) % b, root: (x, n) => nthroot(x, n), nthroot: (x, n) => nthroot(x, n),
};
function nthroot(x: number, n: number): number {
  if (x < 0 && Math.abs(n % 2) === 1) return -Math.pow(-x, 1 / n);   // odd roots of negatives: ∛(-8) = -2
  return Math.pow(x, 1 / n);
}
export const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: 2 * Math.PI, inf: Infinity, infinity: Infinity };
export const FUNCTION_NAMES = new Set([...Object.keys(F1), ...Object.keys(FN)]);

/* ---------------- text clean-up: unicode and LaTeX → plain ---------------- */
const SUP: Record<string, string> = { "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4", "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9", "⁻": "-", "⁺": "+" };

function latexToPlain(s: string): string {
  let t = s;
  for (let i = 0; i < 20 && /\\[dt]?frac\s*\{/.test(t); i++) {          // innermost first: \frac{a}{b} → ((a)/(b))
    t = t.replace(/\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, "(($1)/($2))");
  }
  for (let i = 0; i < 20 && /\\sqrt/.test(t); i++) {
    t = t.replace(/\\sqrt\s*\[([^\]]*)\]\s*\{([^{}]*)\}/g, "nthroot(($2),($1))").replace(/\\sqrt\s*\{([^{}]*)\}/g, "sqrt($1)");
    if (!/\\sqrt\s*[[{]/.test(t)) t = t.replace(/\\sqrt/g, "sqrt");
  }
  return t
    .replace(/\\left|\\right|\\big|\\Big|\\bigg|\\displaystyle|\\,|\\;|\\!|\\quad|\\qquad/g, " ")
    .replace(/\\(cdot|times)/g, "*").replace(/\\div/g, "/")
    .replace(/\\operatorname\s*\{([a-z]+)\}/gi, "$1")
    .replace(/\\(pi|theta|phi|tau|alpha|beta|lambda|mu|omega|rho|sigma)\b/g, "$1")
    .replace(/\\([a-z]+)/gi, "$1")
    .replace(/[{]/g, "(").replace(/[}]/g, ")");
}

export function normalize(src: string): string {
  let s = src.trim();
  if (/\\[a-z]/i.test(s) || /[{}]/.test(s)) s = latexToPlain(s);
  s = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹⁻⁺]+/g, (m) => "^(" + [...m].map((c) => SUP[c]).join("") + ")");
  return s
    .replace(/[×·∙⋅]/g, "*").replace(/÷/g, "/").replace(/[−–—]/g, "-").replace(/\*\*/g, "^")
    .replace(/π/g, " pi ").replace(/θ/g, " theta ").replace(/φ|ϕ/g, " phi ").replace(/τ/g, " tau ")
    .replace(/∞/g, " inf ").replace(/√/g, " sqrt ").replace(/∛/g, " cbrt ")
    .replace(/\barc(sin|cos|tan)\b/g, "a$1").replace(/\bsin\^-1\b|\bsin\^\(-1\)/g, "asin").replace(/\bcos\^-1\b|\bcos\^\(-1\)/g, "acos")
    .replace(/\btan\^-1\b|\btan\^\(-1\)/g, "atan");
}

/* ---------------- tokens ---------------- */
type Tok = { t: "num"; v: number } | { t: "id"; v: string } | { t: "op"; v: string };

function tokenize(src: string, known: Set<string>): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = src.slice(i).match(/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i);
      if (!m) throw new ExprError(`Can't read the number at “${src.slice(i, i + 8)}”`);
      // "2e" is 2·e, not an exponent, unless digits follow
      out.push({ t: "num", v: parseFloat(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[a-z_]/i.test(c)) {
      const m = src.slice(i).match(/^[a-z_][a-z_0-9]*/i)!;
      out.push(...splitName(m[0], known));
      i += m[0].length;
      continue;
    }
    if ("+-*/^(),|!%[]".includes(c)) {
      out.push({ t: "op", v: c === "[" ? "(" : c === "]" ? ")" : c });
      i++;
      continue;
    }
    throw new ExprError(`Unexpected “${c}”`);
  }
  return out;
}

/** "xsinx" → x, sin, x; "xy" → x, y; "theta" stays theta; "x2" → x·2 */
function splitName(word: string, known: Set<string>): Tok[] {
  const w = word.toLowerCase();
  if (known.has(w) || FUNCTION_NAMES.has(w) || w in CONSTANTS) return [{ t: "id", v: w }];
  const digits = w.match(/^([a-z_]+)(\d+)$/);
  // "x2" is how x² often arrives after copy-paste: a power for the plot variables, a product otherwise
  if (digits && ["x", "y", "z", "t", "r"].includes(digits[1]) && known.has(digits[1])) return [{ t: "id", v: digits[1] }, { t: "op", v: "^" }, { t: "num", v: +digits[2] }];
  if (digits && (known.has(digits[1]) || digits[1] in CONSTANTS)) return [{ t: "id", v: digits[1] }, { t: "num", v: +digits[2] }];
  // longest known name at each position
  const names = [...known, ...FUNCTION_NAMES, ...Object.keys(CONSTANTS)].sort((a, b) => b.length - a.length);
  const out: Tok[] = [];
  let i = 0;
  while (i < w.length) {
    const hit = names.find((n) => w.startsWith(n, i));
    if (hit) { out.push({ t: "id", v: hit }); i += hit.length; continue; }
    if (/\d/.test(w[i])) { const d = w.slice(i).match(/^\d+/)![0]; out.push({ t: "num", v: +d }); i += d.length; continue; }
    throw new ExprError(`Unknown name “${word}”`);
  }
  return out;
}

/* ---------------- parser (precedence climbing) ---------------- */
type Node = { k: "num"; v: number } | { k: "var"; v: string } | { k: "neg"; a: Node } | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "call"; f: string; args: Node[] } | { k: "abs"; a: Node } | { k: "fact"; a: Node };

class Parser {
  i = 0;
  constructor(private toks: Tok[], private absDepth = 0) {}
  peek(): Tok | undefined { return this.toks[this.i]; }
  isOp(v: string): boolean { const t = this.peek(); return !!t && t.t === "op" && t.v === v; }
  eat(v: string) {
    if (!this.isOp(v)) throw new ExprError(`Expected “${v}”`);
    this.i++;
  }

  parse(): Node {
    const n = this.expr();
    if (this.i < this.toks.length) throw new ExprError(`Unexpected “${(this.toks[this.i] as { v: string | number }).v}”`);
    return n;
  }

  expr(): Node {
    let a = this.term();
    while (this.isOp("+") || this.isOp("-")) {
      const op = (this.toks[this.i++] as { v: string }).v;
      a = { k: "bin", op, a, b: this.term() };
    }
    return a;
  }

  /** starts a factor? (for implicit multiplication) */
  startsFactor(): boolean {
    const t = this.peek();
    if (!t) return false;
    if (t.t === "num" || t.t === "id") return true;
    if (t.t === "op" && t.v === "(") return true;
    if (t.t === "op" && t.v === "|") return this.absDepth === 0;     // inside |…|, a bar closes
    return false;
  }

  term(): Node {
    let a = this.unary();
    for (;;) {
      if (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
        const op = (this.toks[this.i++] as { v: string }).v;
        a = op === "%" ? { k: "call", f: "mod", args: [a, this.unary()] } : { k: "bin", op, a, b: this.unary() };
      } else if (this.startsFactor()) {
        a = { k: "bin", op: "*", a, b: this.power() };                  // implicit: 2x, x(x+1), 3sin x
      } else return a;
    }
  }

  unary(): Node {
    if (this.isOp("-")) { this.i++; return { k: "neg", a: this.unary() }; }
    if (this.isOp("+")) { this.i++; return this.unary(); }
    return this.power();
  }

  power(): Node {
    const base = this.postfix();
    if (this.isOp("^")) {
      this.i++;
      const exp = this.isOp("-") ? (this.i++, { k: "neg", a: this.power() } as Node) : this.power();   // right-assoc; x^-2
      return { k: "bin", op: "^", a: base, b: exp };
    }
    return base;
  }

  postfix(): Node {
    let a = this.primary();
    while (this.isOp("!")) { this.i++; a = { k: "fact", a }; }
    return a;
  }

  primary(): Node {
    const t = this.peek();
    if (!t) throw new ExprError("The expression ends too early");
    if (t.t === "num") { this.i++; return { k: "num", v: t.v }; }
    if (t.t === "op" && t.v === "(") {
      this.i++;
      const n = this.expr();
      if (this.isOp(",")) throw new ExprError("Unexpected “,”");
      this.eat(")");
      return n;
    }
    if (t.t === "op" && t.v === "|") {
      this.i++;
      const inner = new Parser(this.toks, this.absDepth + 1);
      inner.i = this.i;
      const n = inner.expr();
      this.i = inner.i;
      this.eat("|");
      return { k: "abs", a: n };
    }
    if (t.t === "id") {
      this.i++;
      if (FUNCTION_NAMES.has(t.v)) return this.call(t.v);
      if (t.v in CONSTANTS) return { k: "num", v: CONSTANTS[t.v] };
      return { k: "var", v: t.v };
    }
    throw new ExprError(`Unexpected “${t.v}”`);
  }

  /** f(x), f(x, y), f x, f 2x, f^2 x, f^2(x) */
  call(f: string): Node {
    let power: Node | null = null;
    if (this.isOp("^")) { this.i++; power = this.isOp("-") ? (this.i++, { k: "neg", a: this.postfix() } as Node) : this.postfix(); }
    let args: Node[];
    if (this.isOp("(")) {
      this.i++;
      args = [this.expr()];
      while (this.isOp(",")) { this.i++; args.push(this.expr()); }
      this.eat(")");
    } else {
      // argument without brackets: a product of plain factors, stopping at the next function (sin x cos x)
      let a = this.argFactor();
      while (this.startsFactor() && !(this.peek()!.t === "id" && FUNCTION_NAMES.has((this.peek() as { v: string }).v))) {
        a = { k: "bin", op: "*", a, b: this.argFactor() };
      }
      args = [a];
    }
    const want = f in F1 ? 1 : FN[f].length;
    if (f in F1 && args.length !== 1) throw new ExprError(`${f} takes one value`);
    if (f === "log" && args.length > 2) throw new ExprError("log takes one or two values");
    if (!(f in F1) && f !== "log" && !["min", "max", "hypot"].includes(f) && args.length !== want) throw new ExprError(`${f} takes ${want} values`);
    const n: Node = { k: "call", f, args };
    return power ? { k: "bin", op: "^", a: n, b: power } : n;
  }

  argFactor(): Node {
    if (this.isOp("-")) { this.i++; return { k: "neg", a: this.argFactor() }; }
    return this.power();
  }
}

function compileNode(n: Node): Compiled {
  switch (n.k) {
    case "num": { const v = n.v; return () => v; }
    case "var": { const name = n.v; return (s) => { const v = s[name]; return v === undefined ? NaN : v; }; }
    case "neg": { const a = compileNode(n.a); return (s) => -a(s); }
    case "abs": { const a = compileNode(n.a); return (s) => Math.abs(a(s)); }
    case "fact": { const a = compileNode(n.a); return (s) => gamma(a(s) + 1); }
    case "bin": {
      const a = compileNode(n.a), b = compileNode(n.b);
      switch (n.op) {
        case "+": return (s) => a(s) + b(s);
        case "-": return (s) => a(s) - b(s);
        case "*": return (s) => a(s) * b(s);
        case "/": return (s) => a(s) / b(s);
        default: {
          // x^(1/3) of negatives: real odd roots, like a calculator
          const bn = n.b.k === "bin" && n.b.op === "/" && n.b.a.k === "num" && n.b.b.k === "num" ? [n.b.a.v, n.b.b.v] : null;
          if (bn && Math.abs(bn[1] % 2) === 1) { const [p, q] = bn; return (s) => { const x = a(s); return x < 0 ? (Math.abs(p % 2) === 1 ? -1 : 1) * Math.pow(-x, p / q) : Math.pow(x, p / q); }; }
          return (s) => Math.pow(a(s), b(s));
        }
      }
    }
    case "call": {
      const args = n.args.map(compileNode);
      if (n.f in F1) { const f = F1[n.f], a = args[0]; return (s) => f(a(s)); }
      const f = FN[n.f];
      if (args.length === 1) { const a = args[0]; return (s) => f(a(s)); }
      if (args.length === 2) { const [a, b] = args; return (s) => f(a(s), b(s)); }
      return (s) => f(...args.map((g) => g(s)));
    }
  }
}

function variables(n: Node, out = new Set<string>()): Set<string> {
  if (n.k === "var") out.add(n.v);
  else if (n.k === "neg" || n.k === "abs" || n.k === "fact") variables(n.a, out);
  else if (n.k === "bin") { variables(n.a, out); variables(n.b, out); }
  else if (n.k === "call") n.args.forEach((a) => variables(a, out));
  return out;
}

export interface Expr { fn: Compiled; vars: Set<string>; text: string }

/** Parse an expression. `known` are the variable/parameter names allowed (x, y, t, a, …); anything else is an error. */
export function parseExpr(src: string, known: Iterable<string>): Expr {
  const k = new Set(known);
  const text = normalize(src);
  if (!text) throw new ExprError("Empty expression");
  const node = new Parser(tokenize(text, k)).parse();
  const vars = variables(node);
  for (const v of vars) if (!k.has(v)) throw new ExprError(`Unknown name “${v}”`);
  return { fn: compileNode(node), vars, text: src.trim() };
}
