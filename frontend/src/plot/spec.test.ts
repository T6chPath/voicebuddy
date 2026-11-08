import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSpec } from "./spec";

const kinds = (src: string) => { const s = parseSpec(src); assert.deepEqual(s.errors, []); return s.items.map((i) => i.kind); };

test("2D kinds of equation", () => {
  assert.deepEqual(kinds("y = sin(x)\nf(x) = x^2\nsin(x)/x\nx = y^2\nx^2 + y^2 = 25\ny > x^2\nr = 1 + cos(theta)\nx = cos(3t), y = sin(2t)\n(2, 3)\ny = 3\nx = -1"),
    ["fx", "fx", "fx", "fy", "implicit", "region", "polar", "param2", "point", "fx", "fy"]);
  const s = parseSpec("x^2 + y^2 = 25");
  assert.equal(s.items[0].kind === "implicit" && s.items[0].f({ x: 3, y: 4 }), 0);
});

test("3D kinds", () => {
  const s = parseSpec("z = sin(x) cos(y)\nx^2 + y^2 + z^2 = 9\nx = cos t, y = sin t, z = t/5\nx = (2 + cos v) cos u, y = (2 + cos v) sin u, z = sin v");
  assert.deepEqual(s.errors, []);
  assert.equal(s.dim, 3);
  assert.deepEqual(s.items.map((i) => i.kind), ["surface", "implicit3", "curve3", "param3"]);
  assert.equal(parseSpec("x^2 + y^2").dim, 3);                                   // bare f(x, y) is a surface
});

test("ranges, parameters, title, domains", () => {
  const s = parseSpec("title: Waves\nx: -2pi..2pi\n-3 <= y <= 3\nt from 0 to 4pi\na = 2 [0..5]\ny = a sin(x)\ny = sqrt(x) {0 <= x <= 4}");
  assert.deepEqual(s.errors, []);
  assert.equal(s.title, "Waves");
  assert.ok(Math.abs(s.ranges.x![1] - 2 * Math.PI) < 1e-12);
  assert.deepEqual(s.ranges.y, [-3, 3]);
  assert.ok(Math.abs(s.ranges.t![1] - 4 * Math.PI) < 1e-12);
  assert.deepEqual(s.params.map((p) => [p.name, p.value, p.min, p.max]), [["a", 2, 0, 5]]);
  const f = s.items[0];
  assert.ok(f.kind === "fx" && Math.abs(f.f({ x: Math.PI / 2, a: 3 }) - 3) < 1e-12);
  assert.ok(s.items[1].kind === "fx" && s.items[1].domain![1] === 4);
});

test("polar in x, y and mistakes are reported", () => {
  assert.deepEqual(kinds("r = 2"), ["polar"]);
  assert.deepEqual(kinds("r < 2 + sin(3theta)"), ["region"]);
  const bad = parseSpec("y = foo(x)\ny = x^2");
  assert.equal(bad.items.length, 1);
  assert.match(bad.errors[0], /foo/);
});
