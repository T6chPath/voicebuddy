// Shared bits of the 2D and 3D graphs: tick marks, number formatting, colours, theme.

export interface Theme { bg: string; text: string; muted: string; grid: string; minor: string; axis: string; dark: boolean }

export const LIGHT: Theme = { bg: "#ffffff", text: "#111827", muted: "#6b7280", grid: "rgba(17,24,39,0.12)", minor: "rgba(17,24,39,0.05)", axis: "rgba(17,24,39,0.7)", dark: false };
export const DARK: Theme = { bg: "#151821", text: "#e5e7eb", muted: "#9ca3af", grid: "rgba(229,231,235,0.14)", minor: "rgba(229,231,235,0.05)", axis: "rgba(229,231,235,0.75)", dark: true };

/** The app's current theme (dark / light), read from the page. */
export function pageTheme(el: Element): Theme {
  const cs = getComputedStyle(el);
  const bg = cs.getPropertyValue("--bg-elev").trim() || cs.getPropertyValue("--bg").trim();
  const m = bg.match(/^#([0-9a-f]{6})$/i);
  const dark = m ? parseInt(m[1].slice(0, 2), 16) * 0.3 + parseInt(m[1].slice(2, 4), 16) * 0.59 + parseInt(m[1].slice(4, 6), 16) * 0.11 < 128
    : document.documentElement.dataset.theme === "dark";
  return { ...(dark ? DARK : LIGHT), bg: bg || (dark ? DARK.bg : LIGHT.bg) };
}

/** "nice" tick step (1, 2 or 5 × 10^k) for about `count` ticks across `span` */
export function niceStep(span: number, count: number): number {
  const raw = span / Math.max(1, count);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}

export function ticks(a: number, b: number, step: number): number[] {
  const out: number[] = [];
  const start = Math.ceil(a / step - 1e-9) * step;
  for (let v = start, i = 0; v <= b + step * 1e-9 && i < 500; v = start + ++i * step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

/** 3.14159 → "3.142", 1e-7 → "1e-7", 120000 → "1.2e5" */
export function fmt(v: number, step = 0): string {
  if (!Number.isFinite(v)) return v > 0 ? "∞" : v < 0 ? "−∞" : "undefined";
  if (v === 0) return "0";
  const a = Math.abs(v);
  let s: string;
  if (a >= 1e6 || a < 1e-4) s = v.toExponential(2).replace(/\.?0+e/, "e").replace("e+", "e");
  else {
    const digits = step > 0 ? Math.max(0, Math.min(8, -Math.floor(Math.log10(step) + 1e-9))) : a >= 100 ? 2 : a >= 1 ? 3 : 4;
    s = v.toFixed(digits);
    if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  }
  return s.replace(/^-/, "−");
}

/** multiples of π/2 as "π/2", "π", "3π/2", "−2π" */
export function piLabel(v: number): string {
  const k = Math.round((v / Math.PI) * 2);           // in halves of π
  if (k === 0) return "0";
  const sign = k < 0 ? "−" : "";
  const n = Math.abs(k);
  if (n % 2 === 0) return `${sign}${n / 2 === 1 ? "" : n / 2}π`;
  return `${sign}${n === 1 ? "" : n}π/2`;
}

/** colour map for heights in 3D (dark blue → teal → yellow → red), t in 0..1 */
export function heat(t: number): [number, number, number] {
  const stops: [number, number, number, number][] = [
    [0, 49, 54, 149], [0.25, 69, 117, 180], [0.45, 116, 196, 168], [0.62, 230, 216, 99], [0.8, 244, 128, 66], [1, 200, 40, 50]];
  const x = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [a, ...ca] = stops[i - 1], [b, ...cb] = stops[i];
      const u = (x - a) / (b - a);
      return [ca[0] + (cb[0] - ca[0]) * u, ca[1] + (cb[1] - ca[1]) * u, ca[2] + (cb[2] - ca[2]) * u];
    }
  }
  return [200, 40, 50];
}

/** robust value range: ignores the extreme 2% (poles like tan x or 1/x shouldn't flatten everything else) */
export function robustRange(vals: number[], lo = 0.02, hi = 0.98): [number, number] | null {
  const v = vals.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const a = v[Math.floor(lo * (v.length - 1))], b = v[Math.ceil(hi * (v.length - 1))];
  return [a, b];
}

export function hexRgb(hex: string): [number, number, number] {
  const m = hex.replace("#", "");
  return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
}
