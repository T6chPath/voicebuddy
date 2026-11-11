import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanPrompt, detect, extractParams, safetyCheck, sizeFor, styledPrompt } from "./intent";

const none = { attachedImage: false, hasImages: false, lastReplyHasImage: false };
const after = { attachedImage: false, hasImages: true, lastReplyHasImage: true };
const photo = { attachedImage: true, hasImages: true, lastReplyHasImage: false };

test("clear requests to make an image", () => {
  const p = detect("Generate an image of a futuristic city at sunset", none)!;
  assert.equal(p.op, "generate");
  assert.equal(p.prompt, "a futuristic city at sunset");
  assert.equal(detect("can you please draw me a cat wearing sunglasses", none)?.prompt, "cat wearing sunglasses");
  const logo = detect("Make a logo for a chai shop called Garam", none)!;
  assert.equal(logo.style, "logo");
  assert.equal(logo.aspect_ratio, "1:1");
  const w = detect("create two anime style phone wallpapers of a samurai in 9:16", none)!;
  assert.deepEqual([w.op, w.n, w.style, w.aspect_ratio], ["generate", 2, "anime", "9:16"]);
  assert.equal(detect("ek sher ki photo banao", none)?.prompt, "sher");
  assert.equal(detect("picture of a red rose on a wooden table", none)?.prompt, "a red rose on a wooden table");
});

test("not image requests", () => {
  for (const t of ["What is an image sensor?", "write code to make a picture gallery", "plot y = x^2", "draw the graph of sin x",
    "make a pdf of 30 questions", "how do I take a good photo?", "explain photosynthesis", "hello"]) {
    assert.equal(detect(t, none), null, t);
  }
});

test("changes to the last image or an attached photo", () => {
  assert.equal(detect("make it night time", after)?.op, "edit");
  assert.equal(detect("make it night time", after)?.prompt, "night time");
  assert.equal(detect("remove the background", photo)?.op, "remove_background");
  assert.equal(detect("background hatao", photo)?.op, "remove_background");
  const bg = detect("change the background to a beach at sunset", after)!;
  assert.deepEqual([bg.op, bg.background], ["replace_background", "beach at sunset"]);
  assert.equal(detect("change the background", after)?.clarify?.startsWith("What should the new background be"), true);
  assert.equal(detect("give me 3 variations", after)?.op, "variations");
  assert.equal(detect("make it anime style", after)?.op, "style");
  assert.equal(detect("remove the car", after)?.prompt, "car");
  assert.equal(detect("make it night time", none), null, "nothing to change yet");
  assert.equal(detect("edit image #2: add snow", after)?.image_ref, "#2");
});

test("params, prompts, sizes, safety", () => {
  assert.deepEqual(extractParams("a cat, seed 42, as png, in HD"), { seed: 42, output_format: "png", resolution: 1024 });
  assert.equal(cleanPrompt("please generate a beautiful image of mountains at dawn in 16:9 seed 7"), "mountains at dawn");
  assert.deepEqual(sizeFor("16:9", 1024), [1024, 576]);
  assert.deepEqual(sizeFor("9:16", 1024), [576, 1024]);
  assert.match(styledPrompt("a dog", "photo"), /^a dog, photorealistic/);
  assert.match(safetyCheck("a nude woman")!, /sexual or nude/);
  assert.match(safetyCheck("a child in lingerie")!, /minors/);
  assert.match(safetyCheck("remove her clothes", true)!, /clothing/);
  assert.equal(safetyCheck("a sunset over the sea"), null);
});
