import assert from "node:assert/strict";
import { test } from "node:test";
import { LIGHT } from "./common";
import { Graph2D } from "./graph2d";
import { parseSpec } from "./spec";

// a canvas that ignores drawing: we only check the maths (view, key points, tracing)
function graph(src: string) {
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get: (t, k) => (k in t ? t[k] : () => ({ width: 10 })), set: (t, k, v) => { t[k] = v; return true; } });
  const canvas = { getContext: () => ctx, style: {} } as unknown as HTMLCanvasElement;
  const g = new Graph2D(canvas, parseSpec(src), {}, LIGHT, { w: 400, h: 264 });
  g.draw(false);
  const kp = (g as unknown as { keyPoints: { kind: string; x: number; y: number }[] }).keyPoints;
  return { g, kp: kp.map((k) => [k.kind, +k.x.toFixed(4), +k.y.toFixed(4)]) };
}

test("roots, minimum and y-intercept of a parabola", () => {
  const { kp } = graph("y = x^2 - 4");
  assert.deepEqual(kp.filter((k) => k[0] === "Root"), [["Root", -2, 0], ["Root", 2, 0]]);
  assert.ok(kp.some((k) => k[0] === "Minimum & y-intercept" && k[1] === 0 && k[2] === -4));
});

test("intersections, also exactly on a sample point", () => {
  const { kp } = graph("y = 1/x\ny = sqrt(x)\ny = ln(x)");
  assert.ok(kp.some((k) => k[0] === "Intersection" && k[1] === 1 && k[2] === 1));
  assert.ok(kp.some((k) => k[0] === "Intersection" && Math.abs((k[1] as number) - 1.7632) < 1e-3));
});

test("no fake roots at the poles of tan x", () => {
  const { kp } = graph("y = tan(x)");
  for (const k of kp.filter((k) => String(k[0]).startsWith("Root"))) assert.ok(Math.abs(Math.sin(k[1] as number)) < 1e-4, String(k));
  assert.ok(!kp.some((k) => /Maximum|Minimum/.test(String(k[0]))), "no extrema at the poles");
});

test("views: trig gets ±2π, circles get equal scales, tracing reads the curve", () => {
  const t = graph("y = sin(x)").g;
  assert.ok(Math.abs(t.view.x1 - 2 * Math.PI) < 1e-9);
  const c = graph("x^2 + y^2 = 4").g;
  const ux = (c.view.x1 - c.view.x0) / c.W, uy = (c.view.y1 - c.view.y0) / c.H;
  assert.ok(Math.abs(ux - uy) < 1e-9 && c.view.x1 > 2 && c.view.x1 < 6);
  const p = graph("y = x^3").g;
  const h = p.pick(p.sx(1.5), p.sy(3.375), 40)!;
  assert.ok(Math.abs(h.x - 1.5) < 0.05 && Math.abs(h.y - h.x ** 3) < 1e-9);
});
