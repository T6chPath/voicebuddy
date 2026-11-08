// What to draw: a ```plot block, one equation per line, in ordinary maths notation.
//
//   y = sin(x)                    function of x               x = y^2            function of y
//   x^2 + y^2 = 25                any equation in x and y     y > x^2            shaded inequality
//   r = 1 + cos(theta)            polar                       x = cos(3t), y = sin(2t)   parametric
//   (2, 3)                        a point                     y = sqrt(x) {0 <= x <= 4}  restricted domain
//   z = sin(x) * cos(y)           3D surface                  x^2 + y^2 + z^2 = 9        any equation in x, y, z
//   x = cos t, y = sin t, z = t/5               3D curve
//   x = (2 + cos v) cos u, y = (2 + cos v) sin u, z = sin v     parametric surface (u, v)
//   a = 2 [0..5]                  a parameter, with a slider  x: -5..5   t: 0..2pi   title: …   ranges / title
import { type Compiled, CONSTANTS, ExprError, parseExpr, type Scope } from "./expr";

export type Range = [number, number];
export type Item2D =
  | { kind: "fx"; f: Compiled; domain?: Range }
  | { kind: "fy"; f: Compiled; domain?: Range }
  | { kind: "implicit"; f: Compiled }
  | { kind: "region"; f: Compiled; strict: boolean; boundary: boolean }
  | { kind: "polar"; f: Compiled; domain?: Range }
  | { kind: "param2"; fx: Compiled; fy: Compiled; domain?: Range }
  | { kind: "point"; fx: Compiled; fy: Compiled };
export type Item3D =
  | { kind: "surface"; f: Compiled }
  | { kind: "implicit3"; f: Compiled }
  | { kind: "curve3"; fx: Compiled; fy: Compiled; fz: Compiled; domain?: Range }
  | { kind: "param3"; fx: Compiled; fy: Compiled; fz: Compiled };
export type Item = (Item2D | Item3D) & { label: string; color: string };

export interface Param { name: string; value: number; min: number; max: number; slider: boolean }

export interface Spec {
  dim: 2 | 3;
  items: Item[];
  ranges: Partial<Record<"x" | "y" | "z" | "t" | "theta" | "u" | "v", Range>>;
  params: Param[];
  title?: string;
  errors: string[];
}

export const COLORS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#db2777", "#65a30d", "#4f46e5", "#b45309"];
const PLOT_VARS = new Set(["x", "y", "z", "t", "theta", "r", "u", "v"]);
const RANGE_VARS = new Set(["x", "y", "z", "t", "theta", "u", "v"]);

function num(src: string, params: Scope): number {
  const e = parseExpr(src, Object.keys(params));
  const v = e.fn(params);
  if (!Number.isFinite(v)) throw new ExprError(`“${src}” isn't a number`);
  return v;
}

/** split at commas that aren't inside brackets */
function splitTop(s: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const c of s) {
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") depth--;
    if (c === sep && depth === 0) { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** first relation operator outside brackets → [left, op, right] */
function splitRelation(s: string): [string, string, string] | null {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (depth === 0) {
      const two = s.slice(i, i + 2);
      if (two === "<=" || two === ">=" || two === "==") return [s.slice(0, i), two === "==" ? "=" : two, s.slice(i + 2)];
      if (c === "≤") return [s.slice(0, i), "<=", s.slice(i + 1)];
      if (c === "≥") return [s.slice(0, i), ">=", s.slice(i + 1)];
      if (c === "<" || c === ">" || c === "=") return [s.slice(0, i), c, s.slice(i + 1)];
    }
  }
  return null;
}

const RANGE_RE = /^(x|y|z|t|theta|θ|u|v)\s*(?::|=|∈|\bin\b|\bfrom\b|\brange\b)?\s*[[(]?\s*(.+?)\s*(?:\.\.|\bto\b|,|…)\s*(.+?)\s*[\])]?$/i;
const CHAIN_RE = /^(.+?)\s*(<=|<|≤)\s*(x|y|z|t|theta|θ|u|v)\s*(<=|<|≤)\s*(.+)$/i;

function varName(v: string): string { return v === "θ" ? "theta" : v.toLowerCase(); }

/** "{0 <= x <= 4}" or "for 0 <= x <= 4" at the end of a line → [rest, range] */
function domainSuffix(line: string, params: Scope): [string, Range | undefined] {
  const m = line.match(/^(.*?)(?:\{([^{}]+)\}|\s+for\s+(.+))\s*$/i);
  if (!m) return [line, undefined];
  const cond = (m[2] || m[3]).trim();
  const c = cond.match(CHAIN_RE);
  if (!c) return [line, undefined];
  return [m[1].trim(), [num(c[1], params), num(c[5], params)]];
}

export function parseSpec(src: string): Spec {
  const spec: Spec = { dim: 2, items: [], ranges: {}, params: [], errors: [] };
  const lines = src.split(/\n|;/).map((l) => l.replace(/^\s*[-*•]\s+/, "").replace(/#.*$/, "").trim()).filter(Boolean);
  const scope: Scope = {};
  const rest: string[] = [];

  // pass 1: title, ranges, parameters
  for (const line of lines) {
    try {
      const title = line.match(/^title\s*[:=]\s*(.+)$/i);
      if (title) { spec.title = title[1].replace(/^["']|["']$/g, ""); continue; }
      if (/^(view|dim|mode|type)\s*[:=]/i.test(line)) continue;
      const chain = line.match(CHAIN_RE);
      if (chain && !/[,{]/.test(line)) { spec.ranges[varName(chain[3]) as "x"] = [num(chain[1], scope), num(chain[5], scope)]; continue; }
      const r = line.match(RANGE_RE);
      const after = r ? line.slice(r[1].length) : "";
      if (r && (/\.\.|\bto\b|…/i.test(after) || /^\s*(:|∈|in\b|from\b|range\b)/i.test(after)) && RANGE_VARS.has(varName(r[1]))) {
        spec.ranges[varName(r[1]) as "x"] = [num(r[2], scope), num(r[3], scope)];
        continue;
      }
      const p = line.match(/^([a-zA-Zα-ω])\s*=\s*([^[\]]+?)\s*(?:\[\s*(.+?)\s*(?:\.\.|,|to)\s*(.+?)\s*\])?$/);
      if (p && !PLOT_VARS.has(p[1].toLowerCase()) && !(p[1].toLowerCase() in CONSTANTS)) {
        const name = p[1].toLowerCase();
        try {
          const value = num(p[2], scope);
          const span = 2 * Math.max(Math.abs(value), 1);
          const min = p[3] !== undefined ? num(p[3], scope) : value - span;
          const max = p[4] !== undefined ? num(p[4], scope) : value + span;
          scope[name] = value;
          spec.params.push({ name, value, min: Math.min(min, value), max: Math.max(max, value), slider: true });
          continue;
        } catch { /* not a number: it's an equation like "a = x^2" → ignore here */ }
      }
      rest.push(line);
    } catch (e) {
      spec.errors.push(`${line}: ${(e as Error).message}`);
    }
  }
  const P = spec.params.map((p) => p.name);
  const known = (...v: string[]) => [...v, ...P];

  // pass 2: what to draw
  let colour = 0;
  const add = (item: Item2D | Item3D, label: string) => spec.items.push({ ...item, label, color: COLORS[colour++ % COLORS.length] } as Item);
  for (const raw of rest) {
    try {
      const [line, domain] = domainSuffix(raw, scope);
      // tuples: (2, 3) point · (cos t, sin t) curve · (…, …, …) 3D curve/surface
      const tuple = line.match(/^\(\s*(.+)\s*\)$/);
      if (tuple && splitTop(tuple[1]).length >= 2 && !splitRelation(line)) {
        const parts = splitTop(tuple[1]);
        const all = parts.map((s) => parseExpr(s, known("t", "u", "v")));
        const used = new Set(all.flatMap((e) => [...e.vars]));
        const [fx, fy, fz] = all.map((e) => e.fn);
        if (parts.length === 2) add(used.has("t") ? { kind: "param2", fx, fy, domain } : { kind: "point", fx, fy }, line);
        else if (parts.length === 3) add(used.has("u") || used.has("v") ? { kind: "param3", fx, fy, fz } : { kind: "curve3", fx, fy, fz, domain }, line);
        else throw new ExprError("A point needs 2 or 3 numbers");
        continue;
      }
      // x = …, y = … [, z = …]  (parametric, one line)
      const parts = splitTop(line);
      if (parts.length >= 2) {
        const asg: Record<string, string> = {};
        for (const p of parts) {
          const m = p.match(/^([xyz])\s*(?:\(\s*[tuv](?:\s*,\s*[uv])?\s*\))?\s*=\s*(.+)$/i);
          if (!m) throw new ExprError("Write a parametric curve as: x = …, y = …");
          asg[m[1].toLowerCase()] = m[2];
        }
        const e = (k: string) => parseExpr(asg[k], known("t", "u", "v"));
        if (asg.x && asg.y && asg.z) {
          const [ex, ey, ez] = [e("x"), e("y"), e("z")];
          const surf = [ex, ey, ez].some((q) => q.vars.has("u") || q.vars.has("v"));
          add(surf ? { kind: "param3", fx: ex.fn, fy: ey.fn, fz: ez.fn } : { kind: "curve3", fx: ex.fn, fy: ey.fn, fz: ez.fn, domain }, line);
        } else if (asg.x && asg.y) add({ kind: "param2", fx: e("x").fn, fy: e("y").fn, domain }, line);
        else throw new ExprError("A parametric curve needs x = … and y = …");
        continue;
      }
      const rel = splitRelation(line);
      if (!rel) {                                                        // a bare expression: y = it, or z = it
        const e = parseExpr(line, known("x", "y", "theta"));
        if (e.vars.has("y")) add({ kind: "surface", f: e.fn }, `z = ${line}`);
        else if (e.vars.has("theta")) add({ kind: "polar", f: e.fn, domain }, `r = ${line}`);
        else add({ kind: "fx", f: e.fn, domain }, `y = ${line}`);
        continue;
      }
      let [L, op, R] = rel.map((s) => s.trim()) as [string, string, string];
      if (splitRelation(R)) throw new ExprError("Use one = or < per line (or a {a <= x <= b} range at the end)");
      const fnName = /^[a-z]\s*\(\s*([xyt]|theta|x\s*,\s*y)\s*\)$/i;                // f(x) = …, f(x, y) = …
      const fm = L.match(fnName);
      if (op === "=" && fm) {
        const arg = fm[1].replace(/\s/g, "");
        if (arg === "x,y") { add({ kind: "surface", f: parseExpr(R, known("x", "y")).fn }, line); continue; }
        if (arg === "theta") { add({ kind: "polar", f: parseExpr(R, known("theta")).fn, domain }, line); continue; }
        add({ kind: "fx", f: parseExpr(R, known("x")).fn, domain }, line);
        continue;
      }
      if (op === "=") {
        const lv = L.toLowerCase().replace(/\s/g, "");
        const tryOne = (target: string, allowed: string[]) => {
          if (lv !== target) return null;
          try { return parseExpr(R, known(...allowed)); } catch { return null; }
        };
        let e;
        if ((e = tryOne("y", ["x"]))) { add({ kind: "fx", f: e.fn, domain }, line); continue; }
        if ((e = tryOne("x", ["y"]))) { add({ kind: "fy", f: e.fn, domain }, line); continue; }
        if ((e = tryOne("r", ["theta", "t"]))) {
          const f = e.vars.has("t") && !e.vars.has("theta") ? ((g) => (s: Scope) => g({ ...s, t: s.theta }))(e.fn) : e.fn;
          add({ kind: "polar", f, domain }, line);
          continue;
        }
        if ((e = tryOne("z", ["x", "y"]))) { add({ kind: "surface", f: e.fn }, line); continue; }
        if (R.toLowerCase().replace(/\s/g, "") === "z") {
          try { add({ kind: "surface", f: parseExpr(L, known("x", "y")).fn }, line); continue; } catch { /* fall through */ }
        }
        if (R.toLowerCase().replace(/\s/g, "") === "y") {
          try { add({ kind: "fx", f: parseExpr(L, known("x")).fn, domain }, line); continue; } catch { /* fall through */ }
        }
      }
      // any other equation / inequality: F(x, y[, z]) = L - R
      const l = parseExpr(L, known("x", "y", "z", "r", "theta")), r = parseExpr(R, known("x", "y", "z", "r", "theta"));
      const vars = new Set([...l.vars, ...r.vars]);
      const usesPolar = vars.has("r") || vars.has("theta");
      const lf = l.fn, rf = r.fn;
      const diff: Compiled = usesPolar
        ? (s) => { const sc = { ...s, r: Math.hypot(s.x, s.y), theta: Math.atan2(s.y, s.x) }; return lf(sc) - rf(sc); }
        : (s) => lf(s) - rf(s);
      if (vars.has("z")) {
        if (op !== "=") throw new ExprError("3D inequalities can't be drawn — use an equation");
        add({ kind: "implicit3", f: diff }, line);
      } else if (op === "=") {
        add({ kind: "implicit", f: diff }, line);
      } else {
        const sign = op[0] === ">" ? 1 : -1;
        add({ kind: "region", f: (s) => sign * diff(s), strict: op.length === 1, boundary: true }, line);
      }
    } catch (e) {
      spec.errors.push(`${raw}: ${(e as Error).message}`);
    }
  }
  spec.dim = spec.items.some((i) => ["surface", "implicit3", "curve3", "param3"].includes(i.kind)) ? 3 : 2;
  if (spec.dim === 3) {
    const flat = spec.items.filter((i) => !["surface", "implicit3", "curve3", "param3"].includes(i.kind));
    for (const f of flat) spec.errors.push(`${f.label}: 2D curves can't be mixed into a 3D graph`);
    spec.items = spec.items.filter((i) => !flat.includes(i));
  }
  return spec;
}

export function paramScope(spec: Spec, overrides: Scope = {}): Scope {
  const s: Scope = {};
  for (const p of spec.params) s[p.name] = overrides[p.name] ?? p.value;
  return s;
}
