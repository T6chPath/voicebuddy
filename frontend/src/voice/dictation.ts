/** Dictation for the message box (like ChatGPT's mic): tap → record, with a live waveform and the words so far →
 * ✓ puts the text into the box (the user checks it and sends) · ✕ throws it away.
 *
 * Engines, best first (the same choice as voice mode): the server's Whisper (records, then transcribes), the Android
 * app's speech recognizer, or the browser's. The phone/browser recognizers stop at a pause, so they are restarted
 * until the user taps ✓ — long dictation works. */
import { api, LOCAL_MODE } from "../api/client";
import { Mic, MicError } from "./mic";
import { BrowserRecognizer, NativeRecognizer, type RecLang, type SelfRecognizer } from "./recognizers";
import { voice } from "./session";
import { wavFrom } from "./vad";

export type DictPhase = "idle" | "starting" | "recording" | "finishing" | "error";
export interface DictState { phase: DictPhase; text: string; partial: string; levels: number[]; startedAt: number; error: string | null; engine: string }
const IDLE: DictState = { phase: "idle", text: "", partial: "", levels: [], startedAt: 0, error: null, engine: "" };
const BARS = 48;

export class Dictation {
  state: DictState = IDLE;
  private subs = new Set<(s: DictState) => void>();
  private rec: SelfRecognizer | null = null;
  private mic: Mic | null = null;
  private frames: Float32Array[] = [];
  private gen = 0;
  private wantMore = false;
  private lastLevelAt = 0;
  private fake: number | undefined;
  private done: ((text: string) => void) | null = null;

  subscribe(fn: (s: DictState) => void) { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  private set(p: Partial<DictState>) { this.state = { ...this.state, ...p }; this.subs.forEach((f) => f(this.state)); }
  private level(v: number) {
    const now = performance.now();
    if (now - this.lastLevelAt < 70) return;
    this.lastLevelAt = now;
    this.set({ levels: [...this.state.levels.slice(-(BARS - 1)), Math.max(0, Math.min(1, v))] });
  }

  get active() { return this.state.phase === "starting" || this.state.phase === "recording" || this.state.phase === "finishing"; }

  /** which engine dictation will use here (null: none) */
  async engine(): Promise<"server" | "native" | "browser" | null> {
    if (!LOCAL_MODE && voice.serverAvailable === null) await voice.loadServer();
    const opts = voice.options();
    const want = voice.settings.engine;
    return (want !== "auto" && opts.includes(want) ? want : opts[0]) || null;
  }

  async start() {
    if (this.active) return;
    const my = ++this.gen;
    this.set({ ...IDLE, phase: "starting", startedAt: Date.now(), levels: Array(BARS).fill(0) });
    const pick = await this.engine();
    if (my !== this.gen) return;
    if (!pick) { this.set({ phase: "error", error: "Speech input isn't available on this device." }); return; }
    this.set({ engine: pick });
    const lang = voice.settings.lang as RecLang;
    if (pick === "server") {
      this.frames = [];
      this.mic = new Mic((f, db) => { this.frames.push(f); this.level((db + 60) / 45); }, { noiseSuppression: voice.settings.noiseSuppression });
      try { await this.mic.start(); } catch (e) {
        this.mic = null;
        this.set({ phase: "error", error: e instanceof MicError ? e.message : "The microphone couldn't be started." });
        return;
      }
      if (my !== this.gen) { this.mic.stop(); return; }
      this.set({ phase: "recording", startedAt: Date.now() });
      return;
    }
    this.rec = pick === "native" ? new NativeRecognizer(window.ZenvqoASR!) : new BrowserRecognizer();
    this.wantMore = true;
    if (pick === "browser") {                              // the browser reports no loudness: a gentle "listening" wave
      this.fake = window.setInterval(() => this.level(0.15 + Math.random() * (this.state.partial ? 0.6 : 0.15)), 90);
    }
    this.set({ phase: "recording", startedAt: Date.now() });
    this.listen(lang, my);
  }

  private listen(lang: RecLang, my: number) {
    const rec = this.rec;
    if (!rec) return;
    let finalised = false;
    rec.listen(lang, {
      begin: () => {},
      partial: (t) => { if (my === this.gen) this.set({ partial: t }); },
      level: (db) => { if (my === this.gen) this.level((db + 2) / 12); },
      final: (r) => {
        if (my !== this.gen || finalised) return;
        finalised = true;
        const t = (r.text || this.state.partial).trim();
        this.set({ text: joinWords(this.state.text, t), partial: "" });
      },
      error: (msg, code) => {
        if (my !== this.gen) return;
        // silence is not an error while dictating: just listen again (unless the user is finishing)
        if (code === "6" || code === "7" || code === "no-speech" || code === "no-match") return;
        this.cleanup();
        this.set({ phase: "error", error: msg, partial: "" });
        this.done?.(this.state.text); this.done = null;
      },
      end: () => {
        if (my !== this.gen) return;
        if (!finalised && this.state.partial) this.set({ text: joinWords(this.state.text, this.state.partial), partial: "" });
        if (this.wantMore && this.state.phase === "recording") { window.setTimeout(() => { if (my === this.gen && this.wantMore) this.listen(lang, my); }, 120); return; }
        this.finishWith(this.state.text);
      },
    });
  }

  /** ✓ — stop and get the words (transcribed now for the server engine). */
  finish(): Promise<string> {
    if (this.state.phase !== "recording" && this.state.phase !== "starting") return Promise.resolve(this.state.text);
    const my = this.gen;
    this.set({ phase: "finishing" });
    return new Promise<string>((resolve) => {
      this.done = resolve;
      if (this.mic) {                                       // server: send the recording to Whisper
        const frames = this.frames;
        this.mic.stop(); this.mic = null; this.frames = [];
        if (!frames.length) { this.finishWith(""); return; }
        void api.transcribe(wavFrom(frames), voice.settings.lang).then(
          (r) => { if (my === this.gen) this.finishWith(r.text.trim()); },
          (e) => { if (my === this.gen) { this.cleanup(); this.set({ phase: "error", error: (e as Error).message || "Couldn't transcribe." }); resolve(""); } });
        return;
      }
      this.wantMore = false;
      this.rec?.stop();
      // if the recognizer never answers, keep what we have
      window.setTimeout(() => { if (my === this.gen && this.state.phase === "finishing") this.finishWith(joinWords(this.state.text, this.state.partial)); }, 4000);
    });
  }

  /** ✕ — stop and throw the recording away. */
  cancel() {
    this.gen++;
    this.cleanup();
    this.done?.(""); this.done = null;
    this.set(IDLE);
  }

  /** after an error, back to idle */
  dismiss() { if (this.state.phase === "error") this.set(IDLE); }

  private finishWith(text: string) {
    this.cleanup();
    const t = text.trim();
    this.set({ ...IDLE, text: t });
    this.done?.(t); this.done = null;
  }

  private cleanup() {
    this.wantMore = false;
    window.clearInterval(this.fake); this.fake = undefined;
    try { this.rec?.abort(); } catch { /* already stopped */ }
    this.rec = null;
    this.mic?.stop(); this.mic = null; this.frames = [];
  }
}

function joinWords(a: string, b: string): string {
  if (!b) return a;
  if (!a) return b;
  return /\s$/.test(a) ? a + b : a + " " + b;
}

export const dictation = new Dictation();
