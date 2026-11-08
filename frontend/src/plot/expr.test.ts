import assert from "node:assert/strict";
import { test } from "node:test";
import { parseExpr } from "./expr";

const V = ["x", "y", "z", "t", "theta", "a"];
const ev = (src: string, s: Record<string, number> = {}) => parseExpr(src, V).fn({ x: 2, y: 3, t: 0.5, theta: 1, a: 4, ...s });
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

test("ordinary arithmetic and precedence", () => {
  close(ev("1 + 2*3"), 7);
  close(ev("-x^2"), -4);
  close(ev("2^3^2"), 512);
  close(ev("x^-1"), 0.5);
  close(ev("(x+1)(x-1)"), 3);
  close(ev("10 % 4"), 2);
  close(ev("5!"), 120);
});

test("implicit multiplication and functions without brackets", () => {
  close(ev("2x"), 4);
  close(ev("3sin(x)"), 3 * Math.sin(2));
  close(ev("sin x"), Math.sin(2));
  close(ev("sin 2x"), Math.sin(4));
  close(ev("sin^2 x + cos^2 x"), 1);
  close(ev("sin x cos x"), Math.sin(2) * Math.cos(2));
  close(ev("xy"), 6);
  close(ev("x sin x"), 2 * Math.sin(2));
  close(ev("2pi"), 2 * Math.PI);
  close(ev("e^x"), Math.exp(2));
  close(ev("x2 + y2"), 13);
});

test("unicode and LaTeX", () => {
  close(ev("x² + √x"), 4 + Math.sqrt(2));
  close(ev("π·x"), 2 * Math.PI);
  close(ev("−x × 3 ÷ 2"), -3);
  close(ev("\\frac{1}{x} + \\sqrt{y}"), 0.5 + Math.sqrt(3));
  close(ev("e^{-x^2}"), Math.exp(-4));
  close(ev("\\sin\\left(\\theta\\right)"), Math.sin(1));
  close(ev("\\sqrt[3]{-8}"), -2);
  close(ev("|x - 5|"), 3);
  close(ev("|x| + |y|"), 5);
});

test("library functions", () => {
  close(ev("log(100)"), 2);
  close(ev("ln(e)"), 1);
  close(ev("log(8, 2)"), 3);
  close(ev("max(x, y, 1)"), 3);
  close(ev("x^(1/3)", { x: -8 }), -2);
  close(ev("arcsin(1)"), Math.PI / 2);
  close(ev("sin^-1(1)"), Math.PI / 2);
  close(ev("a x"), 8);
});

test("errors are clear", () => {
  assert.throws(() => parseExpr("x +", V), /ends too early/);
  assert.throws(() => parseExpr("foo(x)", V), /Unknown name/);
  assert.throws(() => parseExpr("(x", V), /Expected/);
  assert.throws(() => parseExpr("w + 1", V), /Unknown name/);
});
