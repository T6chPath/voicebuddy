import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeEdit } from "./local";

test("image-to-image description puts the change first and drops colours it replaces", () => {
  assert.equal(mergeEdit("a red apple on a wooden table", "the apple green"), "the apple green, a apple on a wooden table");
  assert.equal(mergeEdit("a cat on a sofa", "at night"), "at night, a cat on a sofa");
  assert.equal(mergeEdit("", "anime style"), "anime style");
});
