// The 2D graph: a canvas that draws functions, equations, inequalities, polar and parametric curves and points, with
// a proper grid (π ticks for trig), pan / zoom / pinch, tracing with coordinates, and the interesting points of each
// function (roots, extrema, y-intercept, intersections) found numerically.
import type { Compiled, Scope } from "./expr";
import { fmt, niceStep, piLabel, robustRange, type Theme, ticks } from "./common";
import type { Item, Range, Spec } from "./spec";

export interface View { x0: number; x1: number; y0: number; y1: number }
export interface Hover { x: number; y: number; text: string; color: string }
interface KeyPoint { x: number; y: number; kind: string; color: string }
interface Poly { pts: [number, number][]; color: string; label: string }

export const KIND = /^(Root|Maximum|Minimum|y-intercept|Intersection|Point)( & (Root|Maximum|Minimum|y-intercept|Intersection))*$/;
const TRIG = /(^|[^a-z])(sin|cos|tan|sec|csc|cot)/i;
const SAMPLE_T: Range = [0, 2 * Math.PI];

export class Graph2D {
  readonly ctx: CanvasRenderingContext2D;
  view: View;
  home: View;
  W = 0;
  H = 0;
  private dpr = 1;
  private scope: Scope;
  private keyPoints: KeyPoint[] = [];
  private polys: Poly[] = [];
  hover: (Hover & { sx: number; sy: number; vertical: boolean }) | null = null;
  private piTicks: boolean;
  private equal: boolean;

  constructor(readonly canvas: HTMLCanvasElement, readonly spec: Spec, scope: Scope, public theme: Theme,
              size: { w: number; h: number }, private legend = false) {
    this.ctx = canvas.getContext("2d")!;
    this.scope = scope;
    this.piTicks = spec.items.some((i) => i.kind === "fx" && TRIG.test(i.label)) && spec.items.every((i) => i.kind === "fx" || i.kind === "point");
    this.equal = spec.items.some((i) => i.kind !== "fx");
    this.setSize(size.w, size.h);
    this.view = this.home = this.autoView();
  }

  setSize(w: number, h: number) {
    this.W = w;
    this.H = h;
    this.dpr = Math.min(3, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
  }

  setScope(s: Scope) { this.scope = s; }

  /* ---------- coordinates ---------- */
  sx(x: number) { return ((x - this.view.x0) / (this.view.x1 - this.view.x0)) * this.W; }
  sy(y: number) { return this.H - ((y - this.view.y0) / (this.view.y1 - this.view.y0)) * this.H; }
  wx(px: number) { return this.view.x0 + (px / this.W) * (this.view.x1 - this.view.x0); }
  wy(py: number) { return this.view.y0 + ((this.H - py) / this.H) * (this.view.y1 - this.view.y0); }

  private ev(f: Compiled, vars: Scope): number {
    try { return f({ ...this.scope, ...vars }); } catch { return NaN; }
  }

  /* ---------- where to look first ---------- */
  autoView(): View {
    const r = this.spec.ranges;
    let xr: Range | undefined = r.x, yr: Range | undefined = r.y;
    const items = this.spec.items;
    const xs: number[] = [], ys: number[] = [];
    // curves with their own parameter: take their extent
    for (const it of items) {
      if (it.kind === "polar" || it.kind === "param2") {
        const [a, b] = it.domain || (it.kind === "polar" ? r.theta : r.t) || SAMPLE_T;
        for (let i = 0; i <= 600; i++) {
          const t = a + ((b - a) * i) / 600;
          const p = this.curvePoint(it, t);
          if (p) { xs.push(p[0]); ys.push(p[1]); }
        }
      } else if (it.kind === "point") {
        const x = this.ev(it.fx, {}), y = this.ev(it.fy, {});
        if (Number.isFinite(x) && Number.isFinite(y)) { xs.push(x); ys.push(y); }
      } else if (it.kind === "implicit" || it.kind === "region") {
        const box = this.crossings(it.f, [-10, 10], [-10, 10], 90);
        if (box) { xs.push(box[0], box[1]); ys.push(box[2], box[3]); }
      }
    }
    if (!xr) {
      const onlyFx = items.every((i) => i.kind === "fx" || i.kind === "fy");
      if (xs.length && !items.some((i) => i.kind === "fx")) xr = pad([Math.min(...xs), Math.max(...xs)], 0.15, 2);
      else if (onlyFx && this.piTicks) xr = [-2 * Math.PI, 2 * Math.PI];
      else if (onlyFx && items.some((i) => i.kind === "fx")) xr = this.featureRange();
      else xr = [-10, 10];
      if (xs.length && items.some((i) => i.kind === "fx")) xr = [Math.min(xr[0], ...xs), Math.max(xr[1], ...xs)];
    }
    if (!yr) {
      const vals: number[] = [...ys];
      for (const it of items) {
        if (it.kind !== "fx") continue;
        const [a, b] = clip(xr, it.domain);
        for (let i = 0; i <= 400; i++) vals.push(this.ev(it.f, { x: a + ((b - a) * i) / 400 }));
      }
      for (const it of items) if (it.kind === "fy") vals.push(xr[0] * 0.6, xr[1] * 0.6);
      const rr = robustRange(vals, 0.03, 0.97);
      if (!rr) yr = [-10, 10];
      else {
        let [lo, hi] = rr;
        if (hi - lo < 1e-9) { lo -= 5; hi += 5; }
        const span = hi - lo;
        if (lo > 0 && lo < span * 0.6) lo = 0;                      // keep the x-axis in view when it's close
        if (hi < 0 && -hi < span * 0.6) hi = 0;
        yr = pad([lo, hi], 0.12, 1e-6);
      }
    }
    let v: View = { x0: xr[0], x1: xr[1], y0: yr[0], y1: yr[1] };
    if (this.equal && !(r.x && r.y)) v = equalize(v, this.W, this.H, !!r.x, !!r.y);
    return v;
  }

  /** x-range that frames the roots and turning points of the functions (x² − 4 → about −5..5, not −10..10) */
  private featureRange(): Range {
    const feats: number[] = [];
    for (const it of this.spec.items) {
      if (it.kind !== "fx") continue;
      const [a, b] = clip([-10, 10], it.domain);
      const n = 800;
      let p2 = NaN, p1 = NaN;
      for (let i = 0; i <= n; i++) {
        const x = a + ((b - a) * i) / n, y = this.ev(it.f, { x });
        if (Number.isFinite(y) && Number.isFinite(p1)) {
          if (y === 0 || p1 * y < 0) feats.push(x);
          if (Number.isFinite(p2) && (p1 - p2) * (y - p1) < 0) feats.push(x);
        }
        if (it.domain && i === 0 && Number.isFinite(y)) feats.push(x);
        p2 = p1; p1 = y;
      }
    }
    if (!feats.length) return [-5, 5];
    let lo = Math.min(...feats, 0), hi = Math.max(...feats, 0);
    const span = Math.max(hi - lo, 4);
    lo -= Math.max(2, span * 0.35); hi += Math.max(2, span * 0.35);
    return [Math.max(lo, -10.5), Math.min(hi, 10.5)];
  }

  /** bounding box of where F(x, y) changes sign, on a coarse grid */
  private crossings(f: Compiled, xr: Range, yr: Range, n: number): [number, number, number, number] | null {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const g: number[] = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) g.push(this.ev(f, { x: xr[0] + ((xr[1] - xr[0]) * i) / n, y: yr[0] + ((yr[1] - yr[0]) * j) / n }));
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = g[j * (n + 1) + i], b = g[j * (n + 1) + i + 1], c = g[(j + 1) * (n + 1) + i];
        if ((a > 0) !== (b > 0) || (a > 0) !== (c > 0) || a === 0) {
          const x = xr[0] + ((xr[1] - xr[0]) * i) / n, y = yr[0] + ((yr[1] - yr[0]) * j) / n;
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
        }
      }
    }
    if (x0 === Infinity) return null;
    const cx = (xr[1] - xr[0]) / n;
    return [x0 - cx, x1 + 2 * cx, y0 - cx, y1 + 2 * cx];
  }

  private curvePoint(it: Item, t: number): [number, number] | null {
    if (it.kind === "polar") {
      const r = this.ev(it.f, { theta: t, t });
      return Number.isFinite(r) ? [r * Math.cos(t), r * Math.sin(t)] : null;
    }
    if (it.kind === "param2") {
      const x = this.ev(it.fx, { t }), y = this.ev(it.fy, { t });
      return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
    }
    return null;
  }

  /* ---------- drawing ---------- */
  draw(fast = false) {
    const { ctx, W, H, theme } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, W, H);
    this.drawGrid();
    this.polys = [];
    this.keyPoints = [];
    for (const it of this.spec.items) if (it.kind === "region") this.drawRegion(it, fast);
    for (const it of this.spec.items) {
      ctx.save();
      ctx.strokeStyle = it.color;
      ctx.lineWidth = 2.4;
      ctx.lineJoin = ctx.lineCap = "round";
      if (it.kind === "fx") this.drawFx(it, fast);
      else if (it.kind === "fy") this.drawFy(it);
      else if (it.kind === "implicit") this.drawImplicit(it.f, it.color, fast, false);
      else if (it.kind === "polar" || it.kind === "param2") this.drawParam(it, fast);
      ctx.restore();
    }
    if (!fast) this.findIntersections();
    for (const it of this.spec.items) if (it.kind === "point") this.drawPoint(it);
    this.drawKeyPoints();
    if (this.legend) this.drawLegend();
    if (this.hover) this.drawHover();
  }

  private drawGrid() {
    const { ctx, W, H, view, theme } = this;
    const xs = view.x1 - view.x0, ys = view.y1 - view.y0;
    let xStep = niceStep(xs, W / 85), yStep = niceStep(ys, H / 55);
    const usePi = this.piTicks && xs / Math.PI > 0.8 && xs / Math.PI < 60;
    if (usePi) {
      const halves = Math.max(1, Math.round(niceStep(xs / (Math.PI / 2), W / 85)));
      xStep = (Math.PI / 2) * halves;
    }
    if (this.equal && !usePi) xStep = yStep = Math.max(xStep, yStep);
    ctx.lineWidth = 1;
    // minor grid
    if (!usePi) {
      ctx.strokeStyle = theme.minor;
      ctx.beginPath();
      for (const x of ticks(view.x0, view.x1, xStep / 5)) { const p = Math.round(this.sx(x)) + 0.5; ctx.moveTo(p, 0); ctx.lineTo(p, H); }
      for (const y of ticks(view.y0, view.y1, yStep / 5)) { const p = Math.round(this.sy(y)) + 0.5; ctx.moveTo(0, p); ctx.lineTo(W, p); }
      ctx.stroke();
    }
    ctx.strokeStyle = theme.grid;
    ctx.beginPath();
    const xt = ticks(view.x0, view.x1, xStep), yt = ticks(view.y0, view.y1, yStep);
    for (const x of xt) { const p = Math.round(this.sx(x)) + 0.5; ctx.moveTo(p, 0); ctx.lineTo(p, H); }
    for (const y of yt) { const p = Math.round(this.sy(y)) + 0.5; ctx.moveTo(0, p); ctx.lineTo(W, p); }
    ctx.stroke();
    // axes
    const ax = Math.min(Math.max(this.sy(0), -1), H + 1), ay = Math.min(Math.max(this.sx(0), -1), W + 1);
    ctx.strokeStyle = theme.axis;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    if (view.y0 <= 0 && view.y1 >= 0) { ctx.moveTo(0, Math.round(ax) + 0.5); ctx.lineTo(W, Math.round(ax) + 0.5); }
    if (view.x0 <= 0 && view.x1 >= 0) { ctx.moveTo(Math.round(ay) + 0.5, 0); ctx.lineTo(Math.round(ay) + 0.5, H); }
    ctx.stroke();
    // labels
    ctx.font = "11px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
    ctx.fillStyle = theme.muted;
    const labelY = Math.min(Math.max(ax + 4, 2), H - 14);
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const x of xt) {
      if (Math.abs(x) < xStep * 1e-6) continue;
      const p = this.sx(x);
      if (p < 12 || p > W - 12) continue;
      this.halo(usePi ? piLabel(x) : fmt(x, xStep), p, labelY);
    }
    const leftOk = ay > 30;
    ctx.textAlign = leftOk ? "right" : "left";
    ctx.textBaseline = "middle";
    const labelX = leftOk ? Math.min(ay - 4, W - 4) : Math.max(ay + 4, 3);
    for (const y of yt) {
      if (Math.abs(y) < yStep * 1e-6) continue;
      const p = this.sy(y);
      if (p < 10 || p > H - 10) continue;
      this.halo(fmt(y, yStep), labelX, p);
    }
    if (view.x0 <= 0 && view.x1 >= 0 && view.y0 <= 0 && view.y1 >= 0) {
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      this.halo("0", ay - 4, ax + 4);
    }
    // axis names
    ctx.fillStyle = theme.text;
    ctx.font = "italic 13px Georgia, 'Times New Roman', serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    if (view.y0 <= 0 && view.y1 >= 0) this.halo("x", W - 5, ax - 3);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    if (view.x0 <= 0 && view.x1 >= 0) this.halo("y", ay + 5, 4);
  }

  /** text with a background-coloured outline, so labels stay readable over lines */
  private halo(text: string, x: number, y: number) {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = this.theme.bg;
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.strokeText(text, x, y);
    ctx.restore();
    ctx.fillText(text, x, y);
  }

  private drawFx(it: Extract<Item, { kind: "fx" }>, fast: boolean) {
    const [a, b] = clip([this.view.x0, this.view.x1], it.domain);
    if (!(b > a)) return;
    const n = Math.ceil(((b - a) / (this.view.x1 - this.view.x0)) * this.W * (fast ? 1 : 2.5)) + 2;
    const f = (x: number) => this.ev(it.f, { x });
    const xs: number[] = [], ys: number[] = [];
    let px = NaN, py = NaN;
    for (let i = 0; i <= n; i++) {
      const x = a + ((b - a) * i) / n;
      const y = f(x);
      // a function starting or ending inside the view (√x at 0, ln x, arcsin at ±1): find the exact edge
      if (i > 0 && Number.isFinite(y) !== Number.isFinite(py)) {
        const e = edge(f, px, x, Number.isFinite(py));
        if (e) { xs.push(e[0]); ys.push(e[1]); }
      }
      xs.push(x); ys.push(y);
      px = x; py = y;
    }
    const segs = this.strokeSeries(xs, ys, f, it.color, it.label, false);
    if (!fast) this.analyse(it, f, segs);
  }

  private drawFy(it: Extract<Item, { kind: "fy" }>) {
    const [a, b] = clip([this.view.y0, this.view.y1], it.domain);
    if (!(b > a)) return;
    const n = Math.ceil(this.H * 2) + 2;
    const g = (y: number) => this.ev(it.f, { y });
    const ys: number[] = [], xs: number[] = [];
    for (let i = 0; i <= n; i++) { const y = a + ((b - a) * i) / n; ys.push(y); xs.push(g(y)); }
    this.strokeSeries(ys, xs, g, it.color, it.label, true);
  }

  /** draws y(x) samples as a path, breaking at gaps and asymptotes; returns the continuous pieces (index ranges) */
  private strokeSeries(us: number[], vs: number[], f: (u: number) => number, color: string, label: string, swap: boolean): [number, number][] {
    const { ctx, H, W } = this;
    const span = swap ? this.view.x1 - this.view.x0 : this.view.y1 - this.view.y0;
    const lim = span * 50;
    const segs: [number, number][] = [];
    let start = -1;
    ctx.beginPath();
    const P = (u: number, v: number): [number, number] => {
      const c = Math.max(-lim, Math.min(lim, v - (swap ? this.view.x0 : this.view.y0))) + (swap ? this.view.x0 : this.view.y0);
      return swap ? [this.sx(c), this.sy(u)] : [this.sx(u), this.sy(c)];
    };
    const poly: [number, number][] = [];
    for (let i = 0; i < us.length; i++) {
      const v = vs[i];
      if (!Number.isFinite(v)) { if (start >= 0) segs.push([start, i - 1]); start = -1; continue; }
      if (start >= 0) {
        const pv = vs[i - 1];
        const jump = Math.abs(v - pv) / span * (swap ? W : H);
        if (jump > (swap ? W : H) * 0.5) {
          const m = f((us[i] + us[i - 1]) / 2);
          const lo = Math.min(v, pv), hi = Math.max(v, pv), tol = (hi - lo) * 0.05;
          if (!Number.isFinite(m) || m < lo - tol || m > hi + tol) {            // pole between the samples: lift the pen
            segs.push([start, i - 1]);
            start = -1;
          }
        }
      }
      const [x, y] = P(us[i], v);
      if (start < 0) { ctx.moveTo(x, y); start = i; } else ctx.lineTo(x, y);
      if (i % 2 === 0) poly.push(swap ? [v, us[i]] : [us[i], v]);
    }
    if (start >= 0) segs.push([start, us.length - 1]);
    ctx.stroke();
    this.polys.push({ pts: poly, color, label });
    return segs;
  }

  private drawParam(it: Extract<Item, { kind: "polar" | "param2" }>, fast: boolean) {
    const [a, b] = it.domain || (it.kind === "polar" ? this.spec.ranges.theta : this.spec.ranges.t) || SAMPLE_T;
    const n = fast ? 700 : 3000;
    const { ctx, W, H } = this;
    ctx.beginPath();
    let pen = false;
    let last: [number, number] | null = null;
    const poly: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const p = this.curvePoint(it, a + ((b - a) * i) / n);
      if (!p) { pen = false; continue; }
      const s: [number, number] = [this.sx(p[0]), this.sy(p[1])];
      if (Math.abs(s[0]) > W * 40 || Math.abs(s[1]) > H * 40) { pen = false; continue; }
      if (pen && last && Math.hypot(s[0] - last[0], s[1] - last[1]) > Math.max(W, H) * 0.6) pen = false;
      if (!pen) ctx.moveTo(s[0], s[1]); else ctx.lineTo(s[0], s[1]);
      pen = true;
      last = s;
      if (i % 3 === 0) poly.push(p);
    }
    ctx.stroke();
    this.polys.push({ pts: poly, color: it.color, label: it.label });
  }

  /** marching squares; for regions the boundary is dashed when the inequality is strict */
  private drawImplicit(f: Compiled, color: string, fast: boolean, dashed: boolean) {
    const { ctx, W, H } = this;
    const cell = fast ? 6 : 2.5;
    const nx = Math.ceil(W / cell), ny = Math.ceil(H / cell);
    const g = new Float64Array((nx + 1) * (ny + 1));
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) g[j * (nx + 1) + i] = this.ev(f, { x: this.wx(i * cell), y: this.wy(j * cell) });
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    if (dashed) ctx.setLineDash([7, 5]);
    ctx.beginPath();
    const poly: [number, number][] = [];
    const cross = (x0: number, y0: number, v0: number, x1: number, y1: number, v1: number): [number, number] | null => {
      if (!Number.isFinite(v0) || !Number.isFinite(v1)) return null;
      const t = v0 === v1 ? 0.5 : v0 / (v0 - v1);
      const px = x0 + (x1 - x0) * t, py = y0 + (y1 - y0) * t;
      // a sign change through a pole (tan, 1/x), not through zero: skip it
      const m = this.ev(f, { x: this.wx(px), y: this.wy(py) });
      if (!(Math.abs(m) <= (Math.abs(v0) + Math.abs(v1)) * 0.75 + 1e-12)) return null;
      return [px, py];
    };
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = g[j * (nx + 1) + i], b = g[j * (nx + 1) + i + 1], c = g[(j + 1) * (nx + 1) + i + 1], d = g[(j + 1) * (nx + 1) + i];
        const code = (a > 0 ? 1 : 0) | (b > 0 ? 2 : 0) | (c > 0 ? 4 : 0) | (d > 0 ? 8 : 0);
        if (code === 0 || code === 15) continue;
        const x0 = i * cell, y0 = j * cell, x1 = x0 + cell, y1 = y0 + cell;
        const eT = () => cross(x0, y0, a, x1, y0, b), eR = () => cross(x1, y0, b, x1, y1, c);
        const eB = () => cross(x0, y1, d, x1, y1, c), eL = () => cross(x0, y0, a, x0, y1, d);
        const seg = (p: [number, number] | null, q: [number, number] | null) => {
          if (!p || !q) return;
          ctx.moveTo(p[0], p[1]); ctx.lineTo(q[0], q[1]);
          if ((i + j) % 3 === 0) poly.push([this.wx(p[0]), this.wy(p[1])]);
        };
        const center = (a + b + c + d) / 4 > 0;
        switch (code) {
          case 1: case 14: seg(eL(), eT()); break;
          case 2: case 13: seg(eT(), eR()); break;
          case 3: case 12: seg(eL(), eR()); break;
          case 4: case 11: seg(eR(), eB()); break;
          case 6: case 9: seg(eT(), eB()); break;
          case 7: case 8: seg(eL(), eB()); break;
          case 5: if (center) { seg(eL(), eB()); seg(eT(), eR()); } else { seg(eL(), eT()); seg(eR(), eB()); } break;
          case 10: if (center) { seg(eL(), eT()); seg(eR(), eB()); } else { seg(eL(), eB()); seg(eT(), eR()); } break;
        }
      }
    }
    ctx.stroke();
    ctx.restore();
    this.polys.push({ pts: poly, color, label: "" });
  }

  private drawRegion(it: Extract<Item, { kind: "region" }>, fast: boolean) {
    const { ctx, W, H } = this;
    const cell = fast ? 4 : 2;
    const nx = Math.ceil(W / cell), ny = Math.ceil(H / cell);
    const off = document.createElement("canvas");
    off.width = nx;
    off.height = ny;
    const o = off.getContext("2d")!;
    const img = o.createImageData(nx, ny);
    const [r, g, b] = [parseInt(it.color.slice(1, 3), 16), parseInt(it.color.slice(3, 5), 16), parseInt(it.color.slice(5, 7), 16)];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const v = this.ev(it.f, { x: this.wx((i + 0.5) * cell), y: this.wy((j + 0.5) * cell) });
        if (v > 0 || (!it.strict && v === 0)) {
          const k = (j * nx + i) * 4;
          img.data[k] = r; img.data[k + 1] = g; img.data[k + 2] = b; img.data[k + 3] = 62;
        }
      }
    }
    o.putImageData(img, 0, 0);
    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, nx * cell, ny * cell);
    ctx.restore();
    if (it.boundary) this.drawImplicit(it.f, it.color, fast, it.strict);
  }

  private drawPoint(it: Extract<Item, { kind: "point" }>) {
    const x = this.ev(it.fx, {}), y = this.ev(it.fy, {});
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const { ctx } = this;
    const px = this.sx(x), py = this.sy(y);
    ctx.fillStyle = it.color;
    ctx.beginPath();
    ctx.arc(px, py, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = "12px system-ui, sans-serif";
    ctx.fillStyle = this.theme.text;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    this.halo(`(${fmt(x)}, ${fmt(y)})`, px + 6, py - 4);
    this.polys.push({ pts: [[x, y]], color: it.color, label: it.label });
    this.keyPoints.push({ x, y, kind: "Point", color: it.color });
  }

  /* ---------- roots, extrema, intercepts ---------- */
  private analyse(it: Extract<Item, { kind: "fx" }>, f: (x: number) => number, segs: [number, number][]) {
    const [a, b] = clip([this.view.x0, this.view.x1], it.domain);
    const n = Math.min(1200, Math.ceil(this.W * 2));
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i <= n; i++) { const x = a + ((b - a) * i) / n; xs.push(x); ys.push(f(x)); }
    const found: KeyPoint[] = [];
    const yspan = this.view.y1 - this.view.y0;
    const continuous = (i: number) => {
      const lo = Math.min(ys[i], ys[i + 1]), hi = Math.max(ys[i], ys[i + 1]);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;
      if (hi - lo < yspan * 0.5) return true;
      const m = f((xs[i] + xs[i + 1]) / 2);
      return m >= lo - (hi - lo) * 0.05 && m <= hi + (hi - lo) * 0.05;
    };
    for (let i = 0; i < n; i++) {
      if (!continuous(i)) continue;
      if (ys[i] === 0) found.push({ x: xs[i], y: 0, kind: "Root", color: it.color });
      else if (ys[i] * ys[i + 1] < 0) {
        const x = bisect(f, xs[i], xs[i + 1]);
        if (Math.abs(f(x)) < yspan * 1e-6) found.push({ x, y: 0, kind: "Root", color: it.color });   // not a pole (tan x)
      }
      if (i > 0 && continuous(i - 1)) {
        const d1 = ys[i] - ys[i - 1], d2 = ys[i + 1] - ys[i];
        if (d1 * d2 < 0 && Math.abs(d1) + Math.abs(d2) > yspan * 1e-9) {
          const max = d1 > 0;
          const x = golden(f, xs[i - 1], xs[i + 1], max);
          const y = f(x);
          if (Number.isFinite(y) && Math.abs(y - (this.view.y0 + this.view.y1) / 2) < yspan * 50) found.push({ x, y, kind: max ? "Maximum" : "Minimum", color: it.color });
        }
      }
    }
    if (0 >= a && 0 <= b) {
      const y0 = f(0);
      if (Number.isFinite(y0)) found.push({ x: 0, y: y0, kind: "y-intercept", color: it.color });
    }
    void segs;
    // too many (sin x over 20 periods) → keep them for tracing but don't draw markers
    const tiny = (this.view.x1 - this.view.x0) * 1e-7, tinyY = (this.view.y1 - this.view.y0) * 1e-7;
    for (const k of found) { if (Math.abs(k.x) < tiny) k.x = 0; if (Math.abs(k.y) < tinyY) k.y = 0; }
    const tidy = dedupe(found, (this.view.x1 - this.view.x0) / this.W);
    for (const k of tidy) (k as KeyPoint & { hidden?: boolean }).hidden = tidy.length > 14;
    this.keyPoints.push(...tidy);
  }

  private findIntersections() {
    const fx = this.spec.items.filter((i): i is Extract<Item, { kind: "fx" }> => i.kind === "fx");
    if (fx.length < 2 || fx.length > 5) return;
    const n = 600;
    for (let p = 0; p < fx.length; p++) {
      for (let q = p + 1; q < fx.length; q++) {
        const h = (x: number) => this.ev(fx[p].f, { x }) - this.ev(fx[q].f, { x });
        let px = this.view.x0, ph = h(px);
        const found: KeyPoint[] = [];
        for (let i = 1; i <= n; i++) {
          const x = this.view.x0 + ((this.view.x1 - this.view.x0) * i) / n;
          const v = h(x);
          if (v === 0) {                                                    // exactly on a sample
            found.push({ x, y: this.ev(fx[p].f, { x }), kind: "Intersection", color: this.theme.text });
          } else if (Number.isFinite(v) && Number.isFinite(ph) && ph !== 0 && ph * v < 0) {
            const r = bisect(h, px, x);
            const y = this.ev(fx[p].f, { x: r });
            if (Math.abs(h(r)) < 1e-6 * (1 + Math.abs(y))) found.push({ x: r, y, kind: "Intersection", color: this.theme.text });
          }
          px = x; ph = v;
        }
        if (found.length <= 10) this.keyPoints.push(...found);
      }
    }
  }

  private drawKeyPoints() {
    const { ctx } = this;
    for (const k of this.keyPoints) {
      if ((k as { hidden?: boolean }).hidden || k.kind === "Point") continue;
      const px = this.sx(k.x), py = this.sy(k.y);
      if (px < -5 || px > this.W + 5 || py < -5 || py > this.H + 5) continue;
      ctx.beginPath();
      ctx.arc(px, py, 3.6, 0, Math.PI * 2);
      ctx.fillStyle = this.theme.bg;
      ctx.fill();
      ctx.lineWidth = 1.8;
      ctx.strokeStyle = k.color;
      ctx.stroke();
    }
  }

  private drawLegend() {
    const { ctx } = this;
    const items = this.spec.items.filter((i) => i.kind !== "point");
    if (!items.length) return;
    ctx.font = "12px system-ui, sans-serif";
    const w = Math.min(this.W * 0.6, Math.max(...items.map((i) => ctx.measureText(i.label).width)) + 34);
    const h = items.length * 18 + 10;
    ctx.fillStyle = this.theme.bg;
    ctx.globalAlpha = 0.9;
    ctx.fillRect(this.W - w - 8, 8, w, h);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = this.theme.grid;
    ctx.strokeRect(this.W - w - 8 + 0.5, 8.5, w, h);
    items.forEach((it, i) => {
      const y = 8 + 14 + i * 18;
      ctx.strokeStyle = it.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(this.W - w, y - 4); ctx.lineTo(this.W - w + 16, y - 4);
      ctx.stroke();
      ctx.fillStyle = this.theme.text;
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillText(it.label.length > 48 ? it.label.slice(0, 46) + "…" : it.label, this.W - w + 22, y);
    });
  }

  /* ---------- tracing ---------- */
  /** nearest curve / key point to a screen position (within `reach` px) */
  pick(px: number, py: number, reach = 40): Graph2D["hover"] {
    let best: Graph2D["hover"] = null, bestD = reach;
    for (const k of this.keyPoints) {
      const d = Math.hypot(this.sx(k.x) - px, this.sy(k.y) - py);
      if (d < Math.min(bestD, 16)) { bestD = d; best = { x: k.x, y: k.y, text: k.kind, color: k.color, sx: this.sx(k.x), sy: this.sy(k.y), vertical: false }; }
    }
    if (best) return best;
    const x = this.wx(px);
    for (const it of this.spec.items) {
      if (it.kind !== "fx") continue;
      if (it.domain && (x < it.domain[0] || x > it.domain[1])) continue;
      const y = this.ev(it.f, { x });
      if (!Number.isFinite(y)) continue;
      const d = Math.abs(this.sy(y) - py);
      if (d < bestD) { bestD = d; best = { x, y, text: it.label, color: it.color, sx: px, sy: this.sy(y), vertical: true }; }
    }
    for (const p of this.polys) {
      if (this.spec.items.some((i) => i.kind === "fx" && i.label === p.label)) continue;
      for (const [x2, y2] of p.pts) {
        const d = Math.hypot(this.sx(x2) - px, this.sy(y2) - py);
        if (d < bestD) { bestD = d; best = { x: x2, y: y2, text: p.label, color: p.color, sx: this.sx(x2), sy: this.sy(y2), vertical: false }; }
      }
    }
    return best;
  }

  private drawHover() {
    const h = this.hover!;
    const { ctx, W, H } = this;
    if (h.vertical) {
      ctx.save();
      ctx.strokeStyle = this.theme.muted;
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(h.sx + 0.5, 0); ctx.lineTo(h.sx + 0.5, H);
      ctx.stroke();
      ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(h.sx, h.sy, 5.5, 0, Math.PI * 2);
    ctx.fillStyle = h.color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = this.theme.bg;
    ctx.stroke();
    const text = `(${fmt(h.x)}, ${fmt(h.y)})`;
    const kind = KIND.test(h.text) ? h.text : "";
    ctx.font = "600 12px system-ui, sans-serif";
    const w = Math.max(ctx.measureText(text).width, kind ? ctx.measureText(kind).width : 0) + 14;
    const bh = kind ? 36 : 22;
    let bx = h.sx + 10, by = h.sy - bh - 8;
    if (bx + w > W - 4) bx = h.sx - w - 10;
    if (by < 4) by = h.sy + 10;
    ctx.fillStyle = this.theme.dark ? "rgba(17,20,28,0.94)" : "rgba(255,255,255,0.95)";
    ctx.strokeStyle = h.color;
    ctx.lineWidth = 1.2;
    roundRect(ctx, bx, by, w, bh, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = this.theme.text;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    if (kind) {
      ctx.fillStyle = h.color;
      ctx.fillText(kind, bx + 7, by + 4);
      ctx.fillStyle = this.theme.text;
      ctx.font = "12px system-ui, sans-serif";
      ctx.fillText(text, bx + 7, by + 19);
    } else ctx.fillText(text, bx + 7, by + 5);
  }

  /* ---------- view changes ---------- */
  zoom(factor: number, px = this.W / 2, py = this.H / 2) {
    const x = this.wx(px), y = this.wy(py);
    const v = this.view;
    this.view = { x0: x - (x - v.x0) * factor, x1: x + (v.x1 - x) * factor, y0: y - (y - v.y0) * factor, y1: y + (v.y1 - y) * factor };
  }

  pan(dx: number, dy: number) {
    const v = this.view;
    const ux = ((v.x1 - v.x0) / this.W) * dx, uy = ((v.y1 - v.y0) / this.H) * dy;
    this.view = { x0: v.x0 - ux, x1: v.x1 - ux, y0: v.y0 + uy, y1: v.y1 + uy };
  }

  describe(): string {
    const v = this.view;
    return `Graph of ${this.spec.items.map((i) => i.label).join("; ")}. Showing x from ${fmt(v.x0)} to ${fmt(v.x1)}, y from ${fmt(v.y0)} to ${fmt(v.y1)}.`;
  }

  keyPointSummary(): string {
    return dedupe(this.keyPoints, 1e-6).filter((k) => k.kind !== "Point").slice(0, 6).map((k) => `${k.kind} (${fmt(k.x)}, ${fmt(k.y)})`).join(", ");
  }
}

/* ---------- helpers ---------- */
function pad([a, b]: Range, f: number, min: number): Range {
  let span = b - a;
  if (span < min) { const m = (a + b) / 2; a = m - min / 2; b = m + min / 2; span = min; }
  return [a - span * f, b + span * f];
}

function clip(r: Range, d?: Range): Range {
  return d ? [Math.max(r[0], d[0]), Math.min(r[1], d[1])] : r;
}

/** same scale on both axes (circles look round), growing whichever axis needs it */
function equalize(v: View, W: number, H: number, keepX: boolean, keepY: boolean): View {
  const ux = (v.x1 - v.x0) / W, uy = (v.y1 - v.y0) / H;
  const u = keepX ? ux : keepY ? uy : Math.max(ux, uy);
  const cx = (v.x0 + v.x1) / 2, cy = (v.y0 + v.y1) / 2;
  return { x0: cx - (u * W) / 2, x1: cx + (u * W) / 2, y0: cy - (u * H) / 2, y1: cy + (u * H) / 2 };
}

function bisect(f: (x: number) => number, a: number, b: number): number {
  let fa = f(a);
  for (let i = 0; i < 60; i++) {
    const m = (a + b) / 2, fm = f(m);
    if (fm === 0) return m;
    if ((fm > 0) === (fa > 0)) { a = m; fa = fm; } else b = m;
  }
  return (a + b) / 2;
}

function golden(f: (x: number) => number, a: number, b: number, max: boolean): number {
  const g = (Math.sqrt(5) - 1) / 2;
  const h = (x: number) => (max ? -f(x) : f(x));
  let c = b - g * (b - a), d = a + g * (b - a);
  for (let i = 0; i < 60; i++) {
    if (h(c) < h(d)) b = d; else a = c;
    c = b - g * (b - a);
    d = a + g * (b - a);
  }
  return (a + b) / 2;
}

/** the x where a function starts/stops existing, between a and b; finiteA says which side is defined */
function edge(f: (x: number) => number, a: number, b: number, finiteA: boolean): [number, number] | null {
  let lo = a, hi = b;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (Number.isFinite(f(m)) === finiteA) lo = m; else hi = m;
  }
  const x = finiteA ? lo : hi, y = f(x);
  return Number.isFinite(y) ? [x, y] : null;
}

function dedupe(pts: KeyPoint[], eps: number): KeyPoint[] {
  const out: KeyPoint[] = [];
  for (const p of pts) {
    const near = out.find((q) => Math.abs(q.x - p.x) < eps * 4 && Math.abs(q.y - p.y) < Math.max(eps * 4, 1e-9 * (1 + Math.abs(p.y))));
    if (!near) out.push({ ...p });
    else if (!near.kind.split(" & ").includes(p.kind)) near.kind = `${near.kind} & ${p.kind}`;     // "Minimum & y-intercept"
  }
  return out;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
