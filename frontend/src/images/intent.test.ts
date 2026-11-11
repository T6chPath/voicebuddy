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

test("text in pictures, references, same character", () => {
  const p = detect("Make a poster that says 'Summer Sale 50% Off' with beach vibes", none)!;
  assert.deepEqual([p.op, p.text, p.textLayout], ["generate", "Summer Sale 50% Off", "poster"]);
  const l = detect("Design a logo for a chai shop called Garam Chai", none)!;
  assert.deepEqual([l.style, l.text, l.textLayout], ["logo", "Garam Chai", "logo"]);
  assert.equal(detect("create a birthday card with the text Happy Birthday Riya", none)?.text, "Happy Birthday Riya");
  assert.equal(detect("generate an image of a red car", none)?.text, undefined);
  const ref = detect("generate an image of a dragon in the style of this image", photo)!;
  assert.deepEqual([ref.op, ref.references, ref.refMode], ["generate", ["attached"], "style"]);
  const same = detect("create an image of the same girl riding a bicycle", after)!;
  assert.deepEqual([same.op, same.references, same.refMode], ["generate", ["last-made"], "subject"]);
  const cont = detect("now show her reading a book in a library", after)!;
  assert.deepEqual([cont.op, cont.prompt, cont.references], ["generate", "reading a book in a library", ["last-made"]]);
});

test("expand, replace, upscale, more styles and sizes", () => {
  const o = detect("extend the image to the left", after)!;
  assert.deepEqual([o.op, o.side], ["outpaint", "left"]);
  assert.equal(detect("make it 16:9", after)?.op, "outpaint");
  assert.equal(detect("zoom out and show more of the city", after)?.op, "outpaint");
  const r = detect("replace the dog with a cat", after)!;
  assert.deepEqual([r.op, r.target, r.prompt], ["replace_object", "dog", "cat"]);
  assert.equal(detect("change the red car into a blue bicycle", after)?.op, "replace_object");
  assert.equal(detect("replace the background with a beach", after)?.op, "replace_background");
  assert.deepEqual([detect("upscale it to 4k", after)?.op, detect("upscale it to 4k", after)?.resolution], ["upscale", 2048]);
  assert.equal(detect("generate a watercolor painting of a village", none)?.style, "watercolor");
  assert.equal(detect("make a pixel art image of a knight", none)?.style, "pixel-art");
  assert.equal(detect("create a 2D illustration of a fox", none)?.style, "flat-2d");
  assert.equal(detect("make an app icon for a weather app", none)?.style, "icon");
  assert.equal(detect("generate an isometric picture of a tiny office", none)?.style, "isometric");
  assert.equal(detect("make a vector logo for Tech Hub", none)?.style, "logo");
  assert.equal(detect("generate an image of mountains in 4k", none)?.resolution, 2048);
  assert.equal(detect("make it night time", after)?.op, "edit");
});

test("words go on the picture, references from an attached photo", () => {
  const none = { attachedImage: false, hasImages: false, lastReplyHasImage: false };
  const att = { attachedImage: true, hasImages: true, lastReplyHasImage: false };
  const p = detect('Create a poster with the text "Grand Opening"', none)!;
  assert.equal(p.text, "Grand Opening"); assert.equal(p.prompt, "poster design");
  const l = detect("design a logo for a coffee shop called Bean There", none)!;
  assert.equal(l.style, "logo"); assert.equal(l.text, "Bean There"); assert.equal(l.prompt, "logo for a coffee shop");
  assert.equal(detect("create a birthday card with the text Happy Birthday Riya", none)!.prompt, "birthday card");
  const r = detect("use this as a reference and draw the same character as an astronaut", att)!;
  assert.equal(r.op, "generate"); assert.deepEqual(r.references, ["attached"]); assert.equal(r.refMode, "subject");
  const st = detect("make a poster in the style of this image about a jazz night", att)!;
  assert.equal(st.refMode, "style"); assert.equal(st.prompt, "poster about a jazz night");
});
