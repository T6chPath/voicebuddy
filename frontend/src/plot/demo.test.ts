import assert from "node:assert/strict";
import { test } from "node:test";
import { demoPlot } from "../api/local";

const block = (r: string | null) => r?.match(/```plot\n([\s\S]*?)\n```/)?.[1];

test("demo turns plot requests into plot blocks", () => {
  assert.equal(block(demoPlot("plot y = x^2 and sin x")), "y = x^2\nsin x");
  assert.equal(block(demoPlot("Draw the graph of x^2 + y^2 = 25")), "x^2 + y^2 = 25");
  assert.equal(block(demoPlot("3d plot of sin(x) cos(y)")), "z = sin(x) cos(y)");
  assert.equal(block(demoPlot("graph x = cos(3t), y = sin(2t)")), "x = cos(3t), y = sin(2t)");
  assert.equal(block(demoPlot("plot y = x^2, y = 2x + 1")), "y = x^2\ny = 2x + 1");
  assert.match(block(demoPlot("can you plot something?"))!, /y = sin\(x\)/);
  assert.equal(demoPlot("what is a graph in maths"), null);
  assert.equal(demoPlot("make a pdf of a graph"), null);
});
