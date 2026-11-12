import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanWrittenPrompt, FREE_PICTURES, isPictureModel, pictureEngine, pictureName, pictureWriterMessages } from "./pictureModels";

const GEMINI = "https://generativelanguage.googleapis.com/v1beta/openai";
const OPENROUTER = "https://openrouter.ai/api/v1";

test("which models make pictures", () => {
  for (const id of ["srv:gemini-3.1-flash-image", "srv:gemini-3.1-flash-lite-image", "srv:gemini-3-pro-image", "srv:gemini-2.5-flash-image",
    "srv:gemini-3.1-flash-image-preview", "srv:gpt-image-2", "srv:gpt-image-2.5-flare", "srv:gpt-image-1", "srv:google/gemini-3.1-flash-image", FREE_PICTURES])
    assert.ok(isPictureModel(id), id);
  for (const id of ["srv:gemini-3.8-flash", "srv:gemini-3.5-flash-lite", "srv:gpt-5.4-mini", "srv:openai/gpt-oss-120b", "echo", "srv:llava-image-reader"])
    assert.ok(!isPictureModel(id), id);
  // OpenRouter tells by the model's outputs (flagged in the list)
  assert.ok(isPictureModel({ id: "srv:x-ai/grok-imagine-image-quality:free", label: "", vision: false, description: "", pictures: true }));
});

test("names for people", () => {
  assert.equal(pictureName("srv:gemini-3.1-flash-image"), "Nano Banana 2");
  assert.equal(pictureName("srv:gemini-3.1-flash-lite-image"), "Nano Banana 2 Lite");
  assert.equal(pictureName("srv:gemini-3-pro-image"), "Nano Banana Pro");
  assert.equal(pictureName("srv:gemini-2.5-flash-image"), "Nano Banana");
  assert.equal(pictureName("srv:gpt-image-2"), "GPT Image 2");
  assert.equal(pictureName("srv:gpt-image-2.5-flare"), "GPT Image 2.5 Flare");
  assert.equal(pictureName("srv:x-ai/grok-imagine-image-quality:free", "xAI: Grok Imagine Image Quality"), "Grok Imagine Image Quality");
  assert.equal(pictureName(FREE_PICTURES), "Picture AI — free");
});

test("who makes the picture", () => {
  assert.deepEqual(pictureEngine(FREE_PICTURES, GEMINI), { kind: "free" });
  assert.deepEqual(pictureEngine("srv:gemini-3.1-flash-image", GEMINI), { kind: "gemini", model: "gemini-3.1-flash-image", name: "Nano Banana 2" });
  assert.deepEqual(pictureEngine("srv:gpt-image-2", "https://api.openai.com/v1"), { kind: "openai", model: "gpt-image-2", name: "GPT Image 2" });
  assert.deepEqual(pictureEngine("srv:google/gemini-3.1-flash-image", OPENROUTER, "Nano Banana 2 (Gemini 3.1 Flash Image)"),
    { kind: "openrouter", model: "google/gemini-3.1-flash-image", name: "Nano Banana 2 (Gemini 3.1 Flash Image)" });
  assert.equal(pictureEngine("srv:some-chat-model", "http://192.168.1.20:8080"), null);
});

test("the free picture AI: what the chat's AI is asked, and its answer cleaned", () => {
  const m = pictureWriterMessages([{ role: "user", text: "draw my cat Momo, a fluffy orange cat" }, { role: "assistant", text: "Here is your image of Momo." },
    { role: "user", text: "" }], "same cat, now in space");
  assert.equal(m.length, 2);
  assert.match(m[0].content, /prompts for an image generator/);
  assert.match(m[1].content, /User: draw my cat Momo[\s\S]*Assistant: Here is your image[\s\S]*The picture to make now: same cat, now in space$/);
  assert.equal(pictureWriterMessages([], "a red fox")[1].content, "The picture to make now: a red fox");
  assert.equal(cleanWrittenPrompt('**Prompt:** "A fluffy orange cat floating in space, stars behind, cinematic lighting."'),
    "A fluffy orange cat floating in space, stars behind, cinematic lighting.");
  assert.equal(cleanWrittenPrompt("```\nA red fox in deep snow at dawn, soft golden light, photo\n```"), "A red fox in deep snow at dawn, soft golden light, photo");
  assert.equal(cleanWrittenPrompt("ok"), "");
});
