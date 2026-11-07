import assert from "node:assert/strict";
import { test } from "node:test";
import { Endpointer, FRAME, SR, similarity, wavFrom } from "./vad";

const tone = (secs: number, amp = 0.2) => { const out: Float32Array[] = []; for (let i = 0; i < (secs * SR) / FRAME; i++) { const f = new Float32Array(FRAME); for (let j = 0; j < FRAME; j++) f[j] = amp * Math.sin((2 * Math.PI * 300 * (i * FRAME + j)) / SR); out.push(f); } return out; };
const noise = (secs: number, amp = 0.002) => { const out: Float32Array[] = []; for (let i = 0; i < (secs * SR) / FRAME; i++) out.push(Float32Array.from({ length: FRAME }, () => (Math.random() * 2 - 1) * amp)); return out; };

function run(ep: Endpointer, frames: Float32Array[], strict = false) {
  const ev: string[] = [];
  for (const f of frames) for (const e of ep.push(f, strict)) if (e.type !== "frame") ev.push(e.type === "start" ? `start(${e.preRoll.length})` : `end:${e.reason}`);
  return ev;
}

test("speech is found in background noise, with pre-roll, and ends after the silence", () => {
  const ep = new Endpointer({ preRollMs: 300, minSpeechMs: 250, endSilenceMs: 800, maxMs: 30000, bargeInMs: 350 });
  const ev = run(ep, [...noise(1.5), ...tone(1.5), ...noise(1.2)]);
  assert.equal(ev.length, 2);
  assert.match(ev[0], /^start\(\d+\)$/);
  assert.ok(Number(ev[0].slice(6, -1)) >= 15, "pre-roll keeps ~300 ms before the speech was confirmed");
  assert.equal(ev[1], "end:silence");
});

test("clicks are ignored; a pause shorter than the end silence doesn't end the turn", () => {
  const ep = new Endpointer({ preRollMs: 300, minSpeechMs: 250, endSilenceMs: 800, maxMs: 30000, bargeInMs: 350 });
  assert.deepEqual(run(ep, [...noise(1.5), ...tone(0.1), ...noise(1)]), []);
  const ev = run(ep, [...tone(1), ...noise(0.5), ...tone(1), ...noise(1)]);
  assert.equal(ev.filter((e) => e.startsWith("start")).length, 1);
  assert.deepEqual(ev.slice(-1), ["end:silence"]);
});

test("barge-in needs longer speech than a normal turn", () => {
  const a = new Endpointer({ preRollMs: 300, minSpeechMs: 250, endSilenceMs: 800, maxMs: 30000, bargeInMs: 600 });
  const b = new Endpointer({ preRollMs: 300, minSpeechMs: 250, endSilenceMs: 800, maxMs: 30000, bargeInMs: 600 });
  const burst = [...noise(1.5), ...tone(0.4), ...noise(0.5)];
  assert.equal(run(a, burst).filter((e) => e.startsWith("start")).length, 1);
  assert.equal(run(b, burst, true).filter((e) => e.startsWith("start")).length, 0);
});

test("max length and wav encoding", () => {
  const ep = new Endpointer({ preRollMs: 300, minSpeechMs: 250, endSilenceMs: 800, maxMs: 2000, bargeInMs: 350 });
  assert.ok(run(ep, [...noise(1), ...tone(3)]).includes("end:max"));
  const w = wavFrom(tone(1));
  assert.equal(w.size, 44 + SR * 2);
});

test("echo similarity", () => {
  assert.ok(similarity("Artificial intelligence is the science", "You said: Artificial Intelligence is the science of machines.") >= 0.8);
  assert.ok(similarity("tell me a joke", "Artificial intelligence is everywhere") < 0.3);
});
