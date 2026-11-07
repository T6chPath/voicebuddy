// Voice activity detection + endpointing on 20 ms frames of 16 kHz audio.
//
// EnergyVAD: the noise floor is the 10th percentile of recent frame energy (speech always has gaps, so the low
// percentile tracks the room even while someone talks); a frame is speech when it is `margin` dB above that floor.
// Endpointer: turns frame decisions into utterances — pre-roll so the first syllable isn't lost, a minimum speech
// length so clicks and coughs are ignored, an end-of-turn silence, and a hard cap.

export const SR = 16000;
export const FRAME = 320;                       // 20 ms

export function frameDb(f: Float32Array): number {
  let s = 0;
  for (let i = 0; i < f.length; i++) s += f[i] * f[i];
  return 10 * Math.log10(s / Math.max(1, f.length) + 1e-12);
}

export class EnergyVAD {
  private hist: number[] = [];
  active = false;
  noise = -70;
  constructor(public margin = 10, public absFloor = -55, private window = 150) {}
  push(db: number, extraMargin = 0): boolean {
    this.hist.push(db);
    if (this.hist.length > this.window) this.hist.shift();
    const sorted = [...this.hist].sort((a, b) => a - b);
    this.noise = sorted[Math.floor(sorted.length * 0.1)] ?? db;
    const th = Math.max(this.noise + this.margin + extraMargin, this.absFloor);
    const on = db > th, off = db < th - 3;
    this.active = on || (this.active && !off);
    return this.active;
  }
}

export interface EndpointOptions { preRollMs: number; minSpeechMs: number; endSilenceMs: number; maxMs: number; bargeInMs: number }
export const DEFAULT_ENDPOINT: EndpointOptions = { preRollMs: 300, minSpeechMs: 250, endSilenceMs: 800, maxMs: 30000, bargeInMs: 350 };

export type EndpointEvent =
  | { type: "start"; preRoll: Float32Array[] }   // speech confirmed: send these buffered frames first
  | { type: "frame"; frame: Float32Array }       // during an utterance
  | { type: "end"; reason: "silence" | "max" };

/** Feed every frame; get events back. `strict` (assistant is speaking) needs louder, longer speech — barge-in. */
export class Endpointer {
  private vad = new EnergyVAD();
  private pre: Float32Array[] = [];
  private speechRun = 0;
  private silenceRun = 0;
  private inUtt = false;
  private uttFrames = 0;
  constructor(public o: EndpointOptions = DEFAULT_ENDPOINT) {}
  get noiseDb() { return this.vad.noise; }
  get speaking() { return this.inUtt; }

  push(frame: Float32Array, strict = false): EndpointEvent[] {
    const out: EndpointEvent[] = [];
    const ms = (frame.length / SR) * 1000;
    const voiced = this.vad.push(frameDb(frame), strict ? 8 : 0);
    if (!this.inUtt) {
      this.pre.push(frame);
      const keep = Math.ceil(this.o.preRollMs / ms) + Math.ceil((strict ? this.o.bargeInMs : this.o.minSpeechMs) / ms);
      while (this.pre.length > keep) this.pre.shift();
      this.speechRun = voiced ? this.speechRun + ms : Math.max(0, this.speechRun - ms * 2);
      if (this.speechRun >= (strict ? this.o.bargeInMs : this.o.minSpeechMs)) {
        this.inUtt = true; this.silenceRun = 0; this.uttFrames = this.pre.length;
        out.push({ type: "start", preRoll: this.pre });
        this.pre = [];
      }
      return out;
    }
    out.push({ type: "frame", frame });
    this.uttFrames++;
    this.silenceRun = voiced ? 0 : this.silenceRun + ms;
    if (this.silenceRun >= this.o.endSilenceMs) out.push(this.finish("silence"));
    else if (this.uttFrames * ms >= this.o.maxMs) out.push(this.finish("max"));
    return out;
  }
  /** push-to-talk: start an utterance now, whatever the level */
  force(): EndpointEvent { this.inUtt = true; this.silenceRun = 0; this.uttFrames = 0; const ev = { type: "start" as const, preRoll: this.pre }; this.pre = []; return ev; }
  finish(reason: "silence" | "max" = "silence"): EndpointEvent { this.inUtt = false; this.speechRun = 0; this.silenceRun = 0; return { type: "end", reason }; }
  reset() { this.inUtt = false; this.speechRun = 0; this.silenceRun = 0; this.pre = []; }
}

/** Float [-1,1] at `from` Hz → 16 kHz, linear interpolation (good enough for speech recognition). */
export function downsample(x: Float32Array, from: number): Float32Array {
  if (from === SR) return x;
  const n = Math.floor((x.length * SR) / from);
  const out = new Float32Array(n);
  const r = from / SR;
  for (let i = 0; i < n; i++) {
    const p = i * r, j = Math.floor(p), f = p - j;
    out[i] = (x[j] ?? 0) * (1 - f) + (x[j + 1] ?? x[j] ?? 0) * f;
  }
  return out;
}

export function toPcm16(x: Float32Array): ArrayBuffer {
  const b = new Int16Array(x.length);
  for (let i = 0; i < x.length; i++) b[i] = Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767)));
  return b.buffer;
}

export function wavFrom(frames: Float32Array[]): Blob {
  const n = frames.reduce((a, f) => a + f.length, 0);
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, 1, true); v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * 2, true);
  let o = 44;
  for (const f of frames) for (let i = 0; i < f.length; i++, o += 2) v.setInt16(o, Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767))), true);
  return new Blob([buf], { type: "audio/wav" });
}

/** Rough similarity of two transcripts (word overlap), to drop the assistant's own voice picked up by the mic. */
export function similarity(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const A = norm(a), B = new Set(norm(b));
  if (!A.length) return 0;
  return A.filter((w) => B.has(w)).length / A.length;
}
