import assert from "node:assert/strict";
import { test } from "node:test";
import { detectLang, finishedSegments, segments, speakable } from "./text";

test("markdown becomes speakable text", () => {
  const s = speakable("## What is AI?\n**Artificial Intelligence** is `smart` software.\n```py\nprint(1)\n```\n- point one\n[link](http://x.y)");
  assert.ok(!s.includes("**") && !s.includes("##") && !s.includes("print(1)") && s.includes("code omitted") && s.includes("link"));
});

test("languages per sentence: English, Hindi, mixed, Hinglish", () => {
  assert.equal(detectLang("What is Artificial Intelligence?"), "en");
  assert.equal(detectLang("कृत्रिम बुद्धिमत्ता एक तकनीक है।"), "hi");
  assert.equal(detectLang("AI यानी Artificial Intelligence एक technology है।"), "hi");
  assert.equal(detectLang("AI ek technology hai jo machines ko smart banati hai"), "hinglish");
  const segs = segments("Artificial Intelligence means machines that can learn. यह आज हर जगह इस्तेमाल होती है। Kya aap jaante hain ye kaise kaam karta hai?");
  assert.deepEqual(segs.map((x) => x.lang), ["en", "hi", "hinglish"]);
});

test("same splitting as the server", () => {
  assert.deepEqual(segments("AI means machines that learn. It is everywhere today! क्या यह अच्छा है? हाँ।").map((s) => s.text),
    ["AI means machines that learn. It is everywhere today!", "क्या यह अच्छा है? हाँ।"]);
});

test("streaming: only finished sentences, nothing inside an open code block", () => {
  assert.deepEqual(finishedSegments("Artificial Intelligence is a branch of computer science. It lets machi").map((s) => s.text),
    ["Artificial Intelligence is a branch of computer science."]);
  assert.equal(finishedSegments("Hello").length, 0);
  assert.deepEqual(finishedSegments("Here is code that prints a greeting for you.\n```py\nprint('a. b. c. d')").map((s) => s.text),
    ["Here is code that prints a greeting for you."]);
});
