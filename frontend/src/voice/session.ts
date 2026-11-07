// Voice conversation: microphone → speech recognition → the chat → spoken reply → listening again.
//
// Turn-taking: our VAD (server recognizer) or the recognizer itself (phone/browser) decides when the user has finished
// speaking. Interruptions: while the assistant thinks or speaks, the mic stays open (server recognizer, with the browser's
// echo cancellation) and needs louder, longer speech to count as the user cutting in; that stops the voice and the reply
// and starts a new turn. Text that matches what the assistant just said is dropped as its own voice picked up by the mic.
// Phone/browser recognizers can't listen while the phone speaks, so there you tap the orb to interrupt.
import { api, ApiError, LOCAL_MODE } from "../api/client";
import { speech, type SpeechState } from "../speech/player";
import { Mic, MicError } from "./mic";
import { BrowserRecognizer, browserRecognitionAvailable, type FinalResult, NativeRecognizer, type RecLang, type Recognizer, ServerRecognizer } from "./recognizers";
import { DEFAULT_ENDPOINT, Endpointer, similarity } from "./vad";

export type Phase = "off" | "starting" | "listening" | "hearing" | "transcribing" | "thinking" | "speaking" | "ptt" | "error";
export interface TurnMetrics { heardMs: number | null; firstTokenMs: number | null; firstAudioMs: number | null; decodeMs: number | null; transport: string; engine: string }
export interface VoiceState {
  phase: Phase; muted: boolean; handsFree: boolean; micOn: boolean; level: number;      // level 0..1
  partial: string; lastHeard: string; error: string | null; notice: string | null;
  recognizer: Recognizer["id"] | null; live: boolean; transport: string;
  turns: TurnMetrics[];
}
export interface VoiceInputSettings {
  engine: "auto" | "server" | "native" | "browser"; lang: RecLang; endSilenceMs: number; bargeIn: boolean;
  handsFree: boolean; noiseSuppression: boolean;
}
export const DEFAULT_VOICE_INPUT: VoiceInputSettings = { engine: "auto", lang: "auto", endSilenceMs: 800, bargeIn: true, handsFree: true, noiseSuppression: true };
const KEY = "zc.voicein";
export interface VoiceHost { send(text: string): Promise<boolean>; stopReply(): void; busy(): boolean }

const OFF: VoiceState = { phase: "off", muted: false, handsFree: true, micOn: false, level: 0, partial: "", lastHeard: "", error: null, notice: null,
  recognizer: null, live: false, transport: "", turns: [] };

export class VoiceSession {
  state: VoiceState = { ...OFF };
  settings: VoiceInputSettings;
  serverAvailable: boolean | null = null;
  serverReason: string | null = null;
  private subs = new Set<(s: VoiceState) => void>();
  private host: VoiceHost | null = null;
  private rec: Recognizer | null = null;
  private mic: Mic | null = null;
  private ep = new Endpointer();
  private pttHeld = false;
  private recent: { text: string; t: number }[] = [];
  private turn: { tEnd: number; tFinal?: number; tToken?: number; tAudio?: number; decode?: number; transport: string; engine: string } | null = null;
  private replyDone = true;
  private lastLevelAt = 0;
  private unsubSpeech: (() => void) | null = null;
  private gen = 0;
  private speechEndedAt = 0;          // when the assistant last stopped talking
  private echoRisk = false;            // current utterance began while (or just after) the assistant spoke

  constructor() {
    let s = DEFAULT_VOICE_INPUT;
    try { s = { ...DEFAULT_VOICE_INPUT, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { /* default */ }
    this.settings = s;
  }
  subscribe(fn: (s: VoiceState) => void) { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  private set(p: Partial<VoiceState>) { this.state = { ...this.state, ...p }; this.subs.forEach((f) => f(this.state)); }
  updateSettings(s: VoiceInputSettings) {
    this.settings = s;
    try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ }
    this.ep.o = { ...DEFAULT_ENDPOINT, endSilenceMs: s.endSilenceMs };
    this.set({});
  }

  async loadServer() {
    if (LOCAL_MODE) { this.serverAvailable = false; this.serverReason = "this app has no server"; return; }
    try { const c = await api.voiceConfig(); this.serverAvailable = c.available; this.serverReason = c.reason; }
    catch { this.serverAvailable = false; this.serverReason = "the server's voice settings couldn't be loaded"; }
  }
  /** which recognizers can work here, best first */
  options(): Recognizer["id"][] {
    const o: Recognizer["id"][] = [];
    if (this.serverAvailable) o.push("server");
    if (window.ZenvqoASR) o.push("native");
    if (browserRecognitionAvailable()) o.push("browser");
    return o;
  }
  whyUnavailable(): string {
    return `Voice input isn't available here: no server speech recognition (${this.serverReason || "not set up"}), and this browser has no built-in speech recognition.`;
  }

  /* ---------------- start / stop ---------------- */
  async start(host: VoiceHost) {
    if (this.state.phase !== "off" && this.state.phase !== "error") return;
    this.host = host;
    const my = ++this.gen;
    if (this.serverAvailable === null) await this.loadServer();
    const opts = this.options();
    const pick = this.settings.engine !== "auto" && opts.includes(this.settings.engine) ? this.settings.engine : opts[0];
    if (!pick) { this.set({ ...OFF, phase: "error", error: this.whyUnavailable() }); return; }
    this.ep = new Endpointer({ ...DEFAULT_ENDPOINT, endSilenceMs: this.settings.endSilenceMs });
    this.set({ ...OFF, phase: "starting", handsFree: this.settings.handsFree, recognizer: pick, turns: this.state.turns });
    this.replyDone = true;
    this.unsubSpeech = speech.subscribe((s) => this.onSpeech(s));
    try {
      if (pick === "server") {
        const rec = new ServerRecognizer(async (wav, lang) => {
          const r = await api.transcribe(wav, lang);
          return { ...r, ms: { decode: r.ms, after_end: r.ms } };
        });
        rec.onPartial = (t) => { if (this.state.phase === "hearing") this.set({ partial: t }); };
        this.rec = rec;
        this.mic = new Mic((f, db) => this.onFrame(f, db), { noiseSuppression: this.settings.noiseSuppression });
        await this.mic.start();                                           // permission prompt happens here
        if (my !== this.gen) return;
        await rec.connect();
        this.set({ live: rec.live, transport: rec.transport, micOn: true });
      } else {
        this.rec = pick === "native" ? new NativeRecognizer(window.ZenvqoASR!) : new BrowserRecognizer();
        this.set({ live: true, transport: pick === "native" ? "on-device" : "browser" });
      }
      if (my !== this.gen) return;
      this.toIdle();
    } catch (e) {
      const msg = e instanceof MicError ? e.message : (e as Error).message || "Voice mode couldn't start.";
      this.teardown();
      this.set({ phase: "error", error: msg, micOn: false });
    }
  }

  end() {
    this.gen++;
    this.teardown();
    speech.stop();
    this.set({ ...OFF, turns: this.state.turns });
  }

  private teardown() {
    this.mic?.stop(); this.mic = null;
    if (this.rec?.kind === "stream") this.rec.close(); else this.rec?.abort();
    this.rec = null;
    this.unsubSpeech?.(); this.unsubSpeech = null;
    this.ep.reset();
  }

  setMuted(m: boolean) {
    this.mic?.setMuted(m);
    if (m) {
      if (this.rec?.kind === "stream" && this.ep.speaking) { this.rec.cancel(); this.ep.reset(); }
      if (this.rec?.kind === "self") this.rec.abort();
    }
    this.set({ muted: m, level: 0, micOn: !m && !!this.mic?.active, partial: m ? "" : this.state.partial });
    if (!m) this.toIdle();
  }

  setHandsFree(h: boolean) {
    this.updateSettings({ ...this.settings, handsFree: h });
    this.set({ handsFree: h });
    if (this.rec?.kind === "self" && !h) this.rec.abort();
    this.toIdle();
  }

  /** tap on the orb: interrupt the assistant, or (push-to-talk off) start listening */
  tap() {
    const p = this.state.phase;
    if (p === "speaking" || p === "thinking") { this.interrupt(true); return; }
    if (this.rec?.kind === "self" && (p === "ptt" || p === "listening")) this.listenSelf();
  }

  /* ---------------- push-to-talk ---------------- */
  pttDown() {
    if (!this.rec || this.state.muted) return;
    if (this.state.phase === "speaking" || this.state.phase === "thinking") this.interrupt(false);
    this.pttHeld = true;
    if (this.rec.kind === "stream") {
      this.echoRisk = false;
      const ev = this.ep.force();
      this.rec.begin(this.settings.lang, ev.type === "start" ? ev.preRoll : []);
      this.set({ phase: "hearing", partial: "" });
    } else this.listenSelf();
  }
  pttUp() {
    if (!this.pttHeld) return;
    this.pttHeld = false;
    if (this.rec?.kind === "stream" && this.state.phase === "hearing") { this.ep.finish(); this.finishUtterance(); }
    else if (this.rec?.kind === "self") this.rec.stop();
  }

  /* ---------------- audio path (server recognizer) ---------------- */
  private onFrame(f: Float32Array, db: number) {
    const now = performance.now();
    if (now - this.lastLevelAt > 90) { this.lastLevelAt = now; this.set({ level: Math.max(0, Math.min(1, (db + 60) / 45)) }); }
    const rec = this.rec;
    if (!rec || rec.kind !== "stream" || this.state.muted) return;
    const p = this.state.phase;
    if (p === "transcribing" || p === "starting" || p === "off" || p === "error") return;
    if (!this.state.handsFree) { if (this.pttHeld && p === "hearing") rec.push(f); return; }
    const strict = p === "speaking" || p === "thinking";
    for (const ev of this.ep.push(f, strict)) {
      if (ev.type === "start") {
        this.echoRisk = strict || performance.now() - this.speechEndedAt < 1500;
        if (strict) {
          if (!this.settings.bargeIn) { this.ep.reset(); return; }
          this.interrupt(false);
        }
        rec.begin(this.settings.lang, ev.preRoll);
        this.set({ phase: "hearing", partial: "" });
      } else if (ev.type === "frame") rec.push(ev.frame);
      else this.finishUtterance();
    }
  }

  private finishUtterance() {
    const rec = this.rec;
    if (!rec || rec.kind !== "stream") return;
    const my = this.gen;
    this.turn = { tEnd: performance.now(), transport: rec.transport, engine: "server" };
    this.set({ phase: "transcribing" });
    rec.end().then((r) => my === this.gen && this.onFinal(r)).catch((e: Error) => {
      if (my !== this.gen) return;
      this.set({ notice: e instanceof ApiError || e.message ? e.message : "Couldn't transcribe that." });
      this.toIdle();
    });
  }

  /* ---------------- self-contained recognizers ---------------- */
  private listenSelf() {
    const rec = this.rec;
    if (!rec || rec.kind !== "self" || this.state.muted) return;
    const my = this.gen;
    let heard = false;
    rec.listen(this.settings.lang, {
      begin: () => { if (my === this.gen) this.set({ phase: "hearing", partial: "" }); },
      partial: (t) => { if (my === this.gen) this.set({ phase: "hearing", partial: t }); },
      level: (db) => { if (my === this.gen) this.set({ level: Math.max(0, Math.min(1, (db + 2) / 12)) }); },
      final: (r) => { if (my !== this.gen) return; heard = true; this.turn = { tEnd: performance.now(), transport: this.state.transport, engine: rec.id }; this.onFinal(r); },
      error: (msg, code) => {
        if (my !== this.gen) return;
        heard = true;
        if (code === "9" || code === "not-allowed") { this.teardown(); this.set({ phase: "error", error: msg, micOn: false }); return; }
        this.set({ notice: msg });
        setTimeout(() => my === this.gen && this.toIdle(), 1200);
      },
      end: () => {
        if (my !== this.gen) return;
        this.set({ micOn: false, level: 0 });
        if (!heard) this.toIdle();                         // silence: keep listening (hands-free) or wait for a tap
      },
    });
    this.set({ phase: "listening", micOn: true, partial: "" });
  }

  /* ---------------- turn handling ---------------- */
  private onFinal(r: FinalResult) {
    const text = (r.text || "").trim();
    if (this.turn) { this.turn.tFinal = performance.now(); this.turn.decode = r.ms?.decode; this.turn.transport = r.transport || this.turn.transport; }
    const cutoff = Date.now() - 20000;
    this.recent = this.recent.filter((x) => x.t > cutoff);
    if (!text || r.confidence === "empty") { this.set({ partial: "", notice: "Didn't catch that." }); this.toIdle(); return; }
    if (this.echoRisk && this.recent.some((x) => similarity(text, x.text) >= 0.6)) {   // the assistant's own voice
      this.set({ partial: "", notice: "Ignored the assistant's own voice." });
      this.toIdle();
      return;
    }
    this.set({ phase: "thinking", partial: "", lastHeard: text, notice: r.confidence === "low" ? "Low confidence — check what was heard." : null });
    this.replyDone = false;
    void this.host?.send(text).then((ok) => {
      if (!ok) { this.replyDone = true; this.set({ notice: "Couldn't send — the previous reply is still running." }); this.toIdle(); }
    });
  }

  /** called by the chat while a reply streams */
  replyToken() { if (this.turn && !this.turn.tToken) this.turn.tToken = performance.now(); }
  replyFinished() {
    this.replyDone = true;
    if (this.state.phase === "thinking" && speech.state.status === "idle") this.finishTurn();
  }

  private onSpeech(s: SpeechState) {
    if (this.state.phase === "off") return;
    if (s.current && !this.recent.some((x) => x.text === s.current!.text)) this.recent.push({ text: s.current.text, t: Date.now() });
    if (s.status === "playing" && this.turn && !this.turn.tAudio) this.turn.tAudio = performance.now();
    if (s.status === "idle" || s.status === "error") this.speechEndedAt = performance.now();
    if ((s.status === "playing" || s.status === "loading" || s.status === "paused") && (this.state.phase === "thinking" || this.state.phase === "speaking")) {
      if (this.state.phase !== "speaking") this.set({ phase: "speaking" });
      if (this.rec?.kind === "self") this.rec.abort();      // phone/browser recognizers would hear the speaker
    } else if ((s.status === "idle" || s.status === "error") && this.state.phase === "speaking" && this.replyDone) this.finishTurn();
  }

  private finishTurn() {
    const t = this.turn;
    if (t) {
      const m: TurnMetrics = { heardMs: t.tFinal ? Math.round(t.tFinal - t.tEnd) : null, firstTokenMs: t.tToken && t.tFinal ? Math.round(t.tToken - t.tFinal) : null,
        firstAudioMs: t.tAudio ? Math.round(t.tAudio - t.tEnd) : null, decodeMs: t.decode ?? null, transport: t.transport, engine: t.engine };
      this.set({ turns: [...this.state.turns.slice(-19), m] });
      this.turn = null;
    }
    this.toIdle();
  }

  /** stop the assistant (voice and reply). `thenListen`: go back to listening; otherwise a new utterance follows at once */
  private interrupt(thenListen: boolean) {
    this.replyDone = true;
    this.turn = null;
    this.set({ notice: null, phase: thenListen ? "listening" : "hearing" });
    speech.stop();
    if (this.host?.busy()) this.host.stopReply();
    if (thenListen) this.toIdle();
  }

  private toIdle() {
    if (this.state.phase === "off" || this.state.phase === "error" || !this.rec) return;
    if (this.state.muted) { this.set({ phase: this.state.handsFree ? "listening" : "ptt" }); return; }
    if (!this.state.handsFree) { this.set({ phase: "ptt", partial: "" }); return; }
    if (this.rec.kind === "self") { this.listenSelf(); return; }
    this.ep.reset();
    this.set({ phase: "listening", partial: "" });
  }
}

export const voice = new VoiceSession();
