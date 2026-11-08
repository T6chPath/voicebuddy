import assert from "node:assert/strict";
import { test } from "node:test";
import { fixIndic, looksGarbled, pageText } from "./text";

test("Hindi from PDFs is put back in reading order", () => {
  const pre = String.fromCharCode(0x93f);                        // ि stored before its consonant
  const da = String.fromCharCode(0x926), la = String.fromCharCode(0x932), virama = String.fromCharCode(0x94d), ii = String.fromCharCode(0x940);
  const broken = pre + da + la + virama + " " + la + ii;          // "िदल् ली"
  assert.equal(fixIndic(broken), da + pre + la + virama + la + ii); // "दिल्ली"
  assert.equal(fixIndic("plain English text"), "plain English text");
});

test("lines follow the PDF's line breaks and baselines", () => {
  const t = pageText([
    { str: "Hello", transform: [1, 0, 0, 1, 72, 700], height: 12 }, { str: " " , transform: [1, 0, 0, 1, 100, 700] },
    { str: "world", transform: [1, 0, 0, 1, 110, 700], height: 12, hasEOL: true },
    { str: "Second", transform: [1, 0, 0, 1, 72, 680], height: 12 },
    { str: "Third", transform: [1, 0, 0, 1, 72, 660], height: 12 },
  ]);
  assert.equal(t, "Hello world\nSecond\nThird");
});

test("old non-Unicode fonts are recognised as unreadable text", () => {
  assert.equal(looksGarbled("Hkkjr dh jkt/kkuh ubZ fnYyh gS gekjk ns'k egku gS fo|ky; esa i<+kbZ"), true);
  assert.equal(looksGarbled("The capital of India is New Delhi. The Ganga is the longest river in the country."), false);
  assert.equal(looksGarbled("short"), false);
  assert.equal(looksGarbled(String.fromCharCode(0xe001).repeat(30)), true);
});
