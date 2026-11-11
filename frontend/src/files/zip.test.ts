import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { inflate } from "./zip";

test("built-in inflater matches zlib (fixed, dynamic and stored blocks)", () => {
  const samples = [
    new TextEncoder().encode("hello hello hello world"),
    new TextEncoder().encode("The quick brown fox jumps over the lazy dog. ".repeat(500) + "नमस्ते दुनिया ".repeat(50)),
    Uint8Array.from({ length: 70000 }, (_, i) => (i * 7919) % 251),                // incompressible-ish
    new Uint8Array(0),
  ];
  for (const s of samples) {
    for (const level of [0, 1, 9]) {
      const z = new Uint8Array(deflateRawSync(s, { level }));
      assert.deepEqual(Buffer.from(inflate(z, s.length)), Buffer.from(s), `level ${level}, ${s.length} bytes`);
    }
  }
});
