import assert from "node:assert/strict";
import { test } from "node:test";
import { calloutKind } from "./callout";

test("labels that make a highlight box", () => {
  assert.equal(calloutKind("Tip"), "tip");
  assert.equal(calloutKind("In short"), "summary");
  assert.equal(calloutKind("Important"), "warn");
  assert.equal(calloutKind("Example"), "example");
  assert.equal(calloutKind("Note."), "note");
  assert.equal(calloutKind("Shakespeare"), "");
});
