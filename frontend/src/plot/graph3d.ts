// The 3D graph, drawn on a 2D canvas (no WebGL needed, so it works on every phone): surfaces z = f(x, y), any
// equation in x, y, z (marching tetrahedra), parametric surfaces and 3D curves. Shaded and coloured by height, inside
// a labelled box; drag to rotate, pinch / wheel to zoom.
import type { Compiled, Scope } from "./expr";
import { fmt, heat, hexRgb, niceStep, robustRange, type Theme, ticks } from "./common";
import type { Item, Range, Spec } from "./spec";

type V3 = [number, number, number];
interface Tri { p: V3[]; color: [number, number, number] | null; z: number; stroke: boolean }   // p in data coords
interface Seg { a: V3; b: V3; color: string }

const TAU = 2 * Math.PI;

export class Graph3D {
  readonly ctx: CanvasRenderingContext2D;
  W = 0;
  H = 0;
  private dpr = 1;
  yaw = -0.85;
  pitch = 0.5;
  zoomK = 1;
  private scope: Scope;
  private box!: { x: Range; y: Range; z: Range };
  private tris: Tri[] = [];
  private segs: Seg[] = [];
  private half: V3 = [1, 1, 0.75];
  private coloured = false;
  private zc: Range = [0, 1];

  constructor(readonly canvas: HTMLCanvasElement, readonly spec: Spec, scope: Scope, public theme: Theme, size: { w: number; h: number }) {
    this.ctx = canvas.getContext("2d")!;
    this.scope = scope;
    this.setSize(size.w, size.h);
    this.build(false);
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

  setScope(s: Scope, fast = false) { this.scope = s; this.build(fast); }

  resetView() { this.yaw = -0.85; this.pitch = 0.5; this.zoomK = 1; }

  private ev(f: Compiled, vars: Scope): number {
    try { return f({ ...this.scope, ...vars }); } catch { return NaN; }
  }

  /* ---------- geometry (rebuilt only when the equations or parameters change) ---------- */
  build(fast: boolean) {
    const r = this.spec.ranges;
    const items = this.spec.items;
    const tris: Tri[] = [], segs: Seg[] = [];
    // the box: x, y from the ranges (default −5..5 for surfaces); implicit shapes and curves size it themselves
    let bx: Range | null = r.x || null, by: Range | null = r.y || null, bz: Range | null = r.z || null;
    const ext = { x: [Infinity, -Infinity], y: [Infinity, -Infinity], z: [Infinity, -Infinity] };
    const grow = (p: V3) => {
      for (let k = 0; k < 3; k++) {
        const e = ext[(["x", "y", "z"] as const)[k]];
        if (Number.isFinite(p[k])) { e[0] = Math.min(e[0], p[k]); e[1] = Math.max(e[1], p[k]); }
      }
    };
    const pending: (() => void)[] = [];
    const hasSurface = items.some((i) => i.kind === "surface");
    let equal = !hasSurface;
    for (const it of items) {
      if (it.kind === "implicit3") {
        const b = (bx && by && bz) ? { x: bx, y: by, z: bz } : this.implicitBox(it.f);
        pending.push(() => this.marchingTets(it.f, b, fast ? 22 : 34, tris));
        grow([b.x[0], b.y[0], b.z[0]]); grow([b.x[1], b.y[1], b.z[1]]);
      } else if (it.kind === "param3") {
        const [u0, u1] = r.u || [0, TAU], [v0, v1] = r.v || [0, TAU];
        const n = fast ? 30 : 56;
        const P: V3[][] = [];
        for (let i = 0; i <= n; i++) {
          const row: V3[] = [];
          for (let j = 0; j <= n; j++) {
            const u = u0 + ((u1 - u0) * i) / n, v = v0 + ((v1 - v0) * j) / n;
            const p: V3 = [this.ev(it.fx, { u, v }), this.ev(it.fy, { u, v }), this.ev(it.fz, { u, v })];
            row.push(p);
            grow(p);
          }
          P.push(row);
        }
        pending.push(() => quads(P, tris, null));
      } else if (it.kind === "curve3") {
        const [a, b] = it.domain || r.t || [0, TAU];
        const n = fast ? 300 : 900;
        let prev: V3 | null = null;
        for (let i = 0; i <= n; i++) {
          const t = a + ((b - a) * i) / n;
          const p: V3 = [this.ev(it.fx, { t }), this.ev(it.fy, { t }), this.ev(it.fz, { t })];
          if (p.every(Number.isFinite)) {
            grow(p);
            if (prev) segs.push({ a: prev, b: p, color: it.color });
            prev = p;
          } else prev = null;
        }
      }
    }
    if (hasSurface) {
      bx = bx || (ext.x[0] < Infinity ? [Math.min(-5, ext.x[0]), Math.max(5, ext.x[1])] : [-5, 5]);
      by = by || (ext.y[0] < Infinity ? [Math.min(-5, ext.y[0]), Math.max(5, ext.y[1])] : [-5, 5]);
      const n = fast ? 34 : 64;
      const vals: number[] = [];
      const grids: { it: Item; P: V3[][] }[] = [];
      for (const it of items) {
        if (it.kind !== "surface") continue;
        const P: V3[][] = [];
        for (let i = 0; i <= n; i++) {
          const row: V3[] = [];
          for (let j = 0; j <= n; j++) {
            const x = bx[0] + ((bx[1] - bx[0]) * i) / n, y = by[0] + ((by[1] - by[0]) * j) / n;
            const z = this.ev(it.f, { x, y });
            row.push([x, y, z]);
            vals.push(z);
          }
          P.push(row);
        }
        grids.push({ it, P });
      }
      if (!bz) {
        const rr = robustRange(vals, 0.01, 0.99);
        const ez = ext.z[0] < Infinity ? ext.z : null;
        let lo = Math.min(rr ? rr[0] : -1, ez ? ez[0] : Infinity), hi = Math.max(rr ? rr[1] : 1, ez ? ez[1] : -Infinity);
        if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
        const pad = (hi - lo) * 0.05;
        bz = [lo - pad, hi + pad];
      }
      for (const g of grids) {
        const zb = bz;
        quads(g.P.map((row) => row.map((p) => (p[2] >= zb[0] - 1e-9 && p[2] <= zb[1] + 1e-9 ? p : [p[0], p[1], NaN] as V3))), tris, null);
      }
    } else {
      const span = (e: number[]) => (e[0] < Infinity ? (e as Range) : ([-1, 1] as Range));
      bx = bx || padR(span(ext.x)); by = by || padR(span(ext.y)); bz = bz || padR(span(ext.z));
    }
    for (const f of pending) f();
    this.box = { x: bx, y: by, z: bz };
    // shape of the drawn box: surfaces get a flatter box; shapes keep true proportions
    if (equal) {
      const s = Math.max(bx[1] - bx[0], by[1] - by[0], bz[1] - bz[0]);
      this.half = [(bx[1] - bx[0]) / s, (by[1] - by[0]) / s, (bz[1] - bz[0]) / s];
    } else this.half = [1, 1, 0.72];
    // colour by height (over the shape's own heights, not the whole box)
    let z0 = Infinity, z1 = -Infinity;
    for (const t of tris) for (const p of t.p) if (Number.isFinite(p[2])) { z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]); }
    if (z0 === Infinity) [z0, z1] = bz;
    this.zc = [z0, z1];
    this.coloured = tris.length > 0;
    for (const t of tris) {
      const zc = (t.p[0][2] + t.p[1][2] + t.p[2][2]) / 3;
      t.color = heat((zc - z0) / (z1 - z0 || 1));
    }
    this.tris = tris;
    this.segs = segs;
  }

  /** where an implicit surface actually is, from a coarse look over −10..10 */
  private implicitBox(f: Compiled): { x: Range; y: Range; z: Range } {
    const n = 18, L = 10;
    const g = (i: number) => -L + (2 * L * i) / n;
    const v: number[] = [];
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) for (let k = 0; k <= n; k++) v.push(this.ev(f, { x: g(i), y: g(j), z: g(k) }));
    const at = (i: number, j: number, k: number) => v[(i * (n + 1) + j) * (n + 1) + k];
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
      const s = at(i, j, k) > 0;
      if (s !== at(i + 1, j, k) > 0 || s !== at(i, j + 1, k) > 0 || s !== at(i, j, k + 1) > 0) {
        [i, j, k].forEach((q, d) => { lo[d] = Math.min(lo[d], g(q)); hi[d] = Math.max(hi[d], g(q + 1)); });
      }
    }
    if (lo[0] === Infinity) return { x: [-5, 5], y: [-5, 5], z: [-5, 5] };
    const c = (2 * L) / n;
    const first = { x: [lo[0] - c, hi[0] + c] as Range, y: [lo[1] - c, hi[1] + c] as Range, z: [lo[2] - c, hi[2] + c] as Range };
    return this.refineBox(f, first);
  }

  /** a second, finer look inside the first box, so a sphere of radius 3 gets a box of about ±3.3, not ±5 */
  private refineBox(f: Compiled, b: { x: Range; y: Range; z: Range }): { x: Range; y: Range; z: Range } {
    const n = 24;
    const at = (r: Range, i: number) => r[0] + ((r[1] - r[0]) * i) / n;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const v = new Float64Array((n + 1) ** 3);
    const idx = (i: number, j: number, k: number) => (i * (n + 1) + j) * (n + 1) + k;
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) for (let k = 0; k <= n; k++) v[idx(i, j, k)] = this.ev(f, { x: at(b.x, i), y: at(b.y, j), z: at(b.z, k) });
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
      const s = v[idx(i, j, k)] > 0;
      if (s !== v[idx(i + 1, j, k)] > 0 || s !== v[idx(i, j + 1, k)] > 0 || s !== v[idx(i, j, k + 1)] > 0) {
        lo[0] = Math.min(lo[0], at(b.x, i)); hi[0] = Math.max(hi[0], at(b.x, i + 1));
        lo[1] = Math.min(lo[1], at(b.y, j)); hi[1] = Math.max(hi[1], at(b.y, j + 1));
        lo[2] = Math.min(lo[2], at(b.z, k)); hi[2] = Math.max(hi[2], at(b.z, k + 1));
      }
    }
    if (lo[0] === Infinity) return b;
    const pad = (a: number, z: number): Range => { const p = (z - a) * 0.06; return [a - p, z + p]; };
    return { x: pad(lo[0], hi[0]), y: pad(lo[1], hi[1]), z: pad(lo[2], hi[2]) };
  }

  private marchingTets(f: Compiled, b: { x: Range; y: Range; z: Range }, n: number, out: Tri[]) {
    const px = (i: number) => b.x[0] + ((b.x[1] - b.x[0]) * i) / n, py = (j: number) => b.y[0] + ((b.y[1] - b.y[0]) * j) / n;
    const pz = (k: number) => b.z[0] + ((b.z[1] - b.z[0]) * k) / n;
    const N = n + 1;
    const val = new Float64Array(N * N * N);
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) for (let k = 0; k < N; k++) val[(i * N + j) * N + k] = this.ev(f, { x: px(i), y: py(j), z: pz(k) });
    const C: V3[] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
    const TETS = [[0, 5, 1, 6], [0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6]];
    const P: V3[] = new Array(8), F: number[] = new Array(8);
    const lerp = (a: number, c: number): V3 => {
      const t = F[a] / (F[a] - F[c]);
      return [P[a][0] + (P[c][0] - P[a][0]) * t, P[a][1] + (P[c][1] - P[a][1]) * t, P[a][2] + (P[c][2] - P[a][2]) * t];
    };
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
      let pos = 0, fin = true;
      for (let c = 0; c < 8; c++) {
        const [di, dj, dk] = C[c];
        F[c] = val[((i + di) * N + j + dj) * N + k + dk];
        if (!Number.isFinite(F[c])) fin = false;
        if (F[c] > 0) pos++;
        P[c] = [px(i + di), py(j + dj), pz(k + dk)];
      }
      if (!fin || pos === 0 || pos === 8) continue;
      for (const t of TETS) {
        const inside = t.filter((c) => F[c] > 0), outside = t.filter((c) => !(F[c] > 0));
        if (inside.length === 0 || inside.length === 4) continue;
        if (inside.length === 1 || inside.length === 3) {
          const [a] = inside.length === 1 ? inside : outside;
          const o = inside.length === 1 ? outside : inside;
          out.push({ p: [lerp(a, o[0]), lerp(a, o[1]), lerp(a, o[2])], color: null, z: 0, stroke: false });
        } else {
          const [a, b2] = inside, [c, d] = outside;
          const p1 = lerp(a, c), p2 = lerp(a, d), p3 = lerp(b2, d), p4 = lerp(b2, c);
          out.push({ p: [p1, p2, p3], color: null, z: 0, stroke: false }, { p: [p1, p3, p4], color: null, z: 0, stroke: false });
        }
      }
    }
  }

  /* ---------- projection ---------- */
  private norm(p: V3): V3 {
    const { x, y, z } = this.box;
    return [((p[0] - x[0]) / (x[1] - x[0]) * 2 - 1) * this.half[0], ((p[1] - y[0]) / (y[1] - y[0]) * 2 - 1) * this.half[1],
      ((p[2] - z[0]) / (z[1] - z[0]) * 2 - 1) * this.half[2]];
  }

  /** normalised point → [screen x, screen y, depth (bigger = farther)] */
  private proj(q: V3): V3 {
    const c = Math.cos(this.yaw), s = Math.sin(this.yaw), ce = Math.cos(this.pitch), se = Math.sin(this.pitch);
    const x1 = q[0] * c - q[1] * s, y1 = q[0] * s + q[1] * c;
    const up = q[2] * ce + y1 * se, depth = y1 * ce - q[2] * se;
    const persp = 5 / (5 + depth);
    const scale = Math.min(this.W * 0.94, this.H) * 0.32 * this.zoomK;
    return [this.W / 2 - 6 + x1 * scale * persp, this.H / 2 - 4 - up * scale * persp, depth];
  }

  draw() {
    const { ctx, W, H, theme } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, W, H);
    const corners: V3[] = [];
    for (const z of [-1, 1]) for (const y of [-1, 1]) for (const x of [-1, 1]) corners.push([x * this.half[0], y * this.half[1], z * this.half[2]]);
    const edges: [number, number][] = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    const pc = corners.map((q) => this.proj(q));
    const drawEdges = (back: boolean) => {
      ctx.strokeStyle = back ? theme.grid : theme.axis;
      ctx.lineWidth = back ? 1 : 1.1;
      ctx.globalAlpha = back ? 1 : 0.35;
      ctx.beginPath();
      for (const [a, b] of edges) {
        if ((pc[a][2] + pc[b][2]) / 2 > 0 === back) { ctx.moveTo(pc[a][0], pc[a][1]); ctx.lineTo(pc[b][0], pc[b][1]); }
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    };
    this.drawFloorGrid();
    drawEdges(true);
    // everything that can hide something else, far to near
    type Prim = { d: number; draw: () => void };
    const prims: Prim[] = [];
    const light: V3 = normalize([-0.35, 0.55, -0.75]);
    for (const t of this.tris) {
      const q = t.p.map((p) => this.norm(p));
      const s = q.map((p) => this.proj(p));
      if (s.some((p) => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) continue;
      const d = (s[0][2] + s[1][2] + s[2][2]) / 3;
      // normal in view space (x, up, depth)
      const v = s.map((p) => [p[0], -p[1], p[2] * Math.min(W * 0.94, H) * 0.32 * this.zoomK] as V3);
      const n = normalize(cross(sub(v[1], v[0]), sub(v[2], v[0])));
      const lit = 0.38 + 0.62 * Math.abs(dot(n, light));
      const [r, g, b] = t.color || [120, 140, 200];
      const fill = `rgb(${(r * lit) | 0},${(g * lit) | 0},${(b * lit) | 0})`;
      const stroke = t.stroke;
      prims.push({ d, draw: () => {
        ctx.beginPath();
        ctx.moveTo(s[0][0], s[0][1]); ctx.lineTo(s[1][0], s[1][1]); ctx.lineTo(s[2][0], s[2][1]);
        if (s.length === 4) ctx.lineTo(s[3][0], s[3][1]);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.strokeStyle = stroke ? "rgba(0,0,0,0.16)" : fill;      // fill hairline gaps between triangles
        ctx.lineWidth = stroke ? 0.6 : 0.5;
        ctx.stroke();
      } });
    }
    for (const sg of this.segs) {
      const a = this.proj(this.norm(sg.a)), b = this.proj(this.norm(sg.b));
      prims.push({ d: (a[2] + b[2]) / 2 - 0.01, draw: () => {
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
        ctx.strokeStyle = sg.color;
        ctx.lineWidth = 2.6;
        ctx.lineCap = "round";
        ctx.stroke();
      } });
    }
    prims.sort((p, q) => q.d - p.d);
    for (const p of prims) p.draw();
    drawEdges(false);
    this.drawTicks(pc);
    if (this.coloured) this.drawColourBar();
  }

  private drawFloorGrid() {
    const { ctx } = this;
    const { x, y } = this.box;
    const sx = niceStep(x[1] - x[0], 5), sy = niceStep(y[1] - y[0], 5);
    ctx.strokeStyle = this.theme.minor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const zb = this.box.z[0];
    for (const v of ticks(x[0], x[1], sx)) {
      const a = this.proj(this.norm([v, y[0], zb])), b = this.proj(this.norm([v, y[1], zb]));
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    }
    for (const v of ticks(y[0], y[1], sy)) {
      const a = this.proj(this.norm([x[0], v, zb])), b = this.proj(this.norm([x[1], v, zb]));
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    }
    ctx.stroke();
  }

  private drawTicks(pc: V3[]) {
    const { ctx, theme } = this;
    const { x, y, z } = this.box;
    ctx.font = "10.5px system-ui, sans-serif";
    ctx.fillStyle = theme.muted;
    const centre = [this.W / 2, this.H / 2];
    // pick the nearest bottom edge parallel to each axis, label along it, pushed away from the box centre
    const along = (axis: 0 | 1 | 2, range: Range, name: string) => {
      const cand: [V3, V3][] = [];
      const hx = this.half[0], hy = this.half[1], hz = this.half[2];
      if (axis === 0) for (const yy of [-hy, hy]) cand.push([[-hx, yy, -hz], [hx, yy, -hz]]);
      if (axis === 1) for (const xx of [-hx, hx]) cand.push([[xx, -hy, -hz], [xx, hy, -hz]]);
      if (axis === 2) for (const xx of [-hx, hx]) for (const yy of [-hy, hy]) cand.push([[xx, yy, -hz], [xx, yy, hz]]);
      let best = cand[0], bestScore = Infinity;
      for (const c of cand) {
        const a = this.proj(c[0]), b = this.proj(c[1]);
        const score = axis === 2 ? (a[0] + b[0]) / 2 : (a[2] + b[2]) / 2;      // z: leftmost edge; x/y: nearest edge
        if (score < bestScore) { bestScore = score; best = c; }
      }
      const step = niceStep(range[1] - range[0], 4);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const v of ticks(range[0], range[1], step)) {
        const t = (v - range[0]) / (range[1] - range[0]);
        const q: V3 = [best[0][0] + (best[1][0] - best[0][0]) * t, best[0][1] + (best[1][1] - best[0][1]) * t, best[0][2] + (best[1][2] - best[0][2]) * t];
        const s = this.proj(q);
        const dx = s[0] - centre[0], dy = s[1] - centre[1], L = Math.hypot(dx, dy) || 1;
        const off = axis === 2 ? 20 : 14;
        ctx.fillText(fmt(v, step), s[0] + (axis === 2 ? -off : (dx / L) * off), s[1] + (axis === 2 ? 0 : (dy / L) * off));
      }
      const mid = this.proj([(best[0][0] + best[1][0]) / 2, (best[0][1] + best[1][1]) / 2, (best[0][2] + best[1][2]) / 2]);
      const dx = mid[0] - centre[0], dy = mid[1] - centre[1], L = Math.hypot(dx, dy) || 1;
      ctx.save();
      ctx.fillStyle = theme.text;
      ctx.font = "italic 13px Georgia, 'Times New Roman', serif";
      ctx.fillText(name, mid[0] + (axis === 2 ? -40 : (dx / L) * 34), mid[1] + (axis === 2 ? 0 : (dy / L) * 34));
      ctx.restore();
    };
    void pc;
    along(0, x, "x");
    along(1, y, "y");
    along(2, z, "z");
  }

  private drawColourBar() {
    const { ctx, W, H, theme } = this;
    const h = Math.min(140, H * 0.45), w = 10, x = W - 24, y = (H - h) / 2;
    const g = ctx.createLinearGradient(0, y + h, 0, y);
    for (let i = 0; i <= 10; i++) { const [r, gg, b] = heat(i / 10); g.addColorStop(i / 10, `rgb(${r | 0},${gg | 0},${b | 0})`); }
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = theme.grid;
    ctx.strokeRect(x + 0.5, y + 0.5, w, h);
    ctx.fillStyle = theme.muted;
    ctx.font = "10px system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const step = niceStep(this.zc[1] - this.zc[0], 4) / 10;
    ctx.fillText(fmt(this.zc[1], step), x - 3, y);
    ctx.fillText(fmt(this.zc[0], step), x - 3, y + h);
    ctx.fillText("z", x + w / 2 + 3, y - 10);
  }

  rotate(dx: number, dy: number) {
    this.yaw -= dx * 0.01;
    this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + dy * 0.01));
  }

  zoom(f: number) { this.zoomK = Math.max(0.3, Math.min(6, this.zoomK / f)); }

  describe(): string {
    const b = this.box;
    return `3D graph of ${this.spec.items.map((i) => i.label).join("; ")}. x from ${fmt(b.x[0])} to ${fmt(b.x[1])}, y from ${fmt(b.y[0])} to ${fmt(b.y[1])}, z from ${fmt(b.z[0])} to ${fmt(b.z[1])}.`;
  }
}

/* ---------- small vector helpers ---------- */
function sub(a: V3, b: V3): V3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a: V3, b: V3): V3 { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot(a: V3, b: V3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function normalize(a: V3): V3 { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
function padR(r: Range): Range {
  let [a, b] = r;
  if (b - a < 1e-9) { a -= 1; b += 1; }
  const p = (b - a) * 0.08;
  return [a - p, b + p];
}

/** grid of points → quads (as 2 triangles each, with a faint mesh line), skipping holes */
function quads(P: V3[][], out: Tri[], color: [number, number, number] | null) {
  for (let i = 0; i + 1 < P.length; i++) {
    for (let j = 0; j + 1 < P[i].length; j++) {
      const a = P[i][j], b = P[i + 1][j], c = P[i + 1][j + 1], d = P[i][j + 1];
      if (![a, b, c, d].every((p) => p.every(Number.isFinite))) continue;
      out.push({ p: [a, b, c, d] as unknown as V3[], color, z: 0, stroke: true });
    }
  }
}

export { hexRgb };
