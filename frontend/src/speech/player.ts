// Speech playback. One controller for the whole app, so two replies never talk over each other.
//
// Engines:
//   server  — neural voices from the zenvqo server (/api/tts), one sentence per request, the next sentence fetched
//             while the current one plays. Audio plays through one shared <audio> element (unlocked by a tap on phones).
//   native  — the Android app's TextToSpeech engine through window.ZenvqoTTS (Android WebView has no Web Speech API).
//   browser — the browser's Web Speech API (desktop Chrome/Edge/Safari, Chrome on Android).
import { detectLang, finishedSegments, type Segment, segments, type SpeechLang } from "./text";

export type EngineId = "server" | "native" | "browser";
export interface VoiceOption { id: string; label: string; gender: "female" | "male" | "unspecified"; langs: string[]; engine: string; local?: boolean }
export interface VoiceSettings {
  engine: "auto" | EngineId;
  autoSpeak: boolean;
  lang: "auto" | SpeechLang;
  gender: "female" | "male";
  voices: Partial<Record<SpeechLang, string>>;      // chosen voice per language (empty = automatic)
  speed: number; pitch: number; volume: number;
  style: string;                                    // delivery instruction, for engines that support it
}
export const DEFAULT_VOICE: VoiceSettings = { engine: "auto", autoSpeak: false, lang: "auto", gender: "female", voices: {}, speed: 1, pitch: 1, volume: 1, style: "" };
const KEY = "zc.voice";

export function loadVoiceSettings(): VoiceSettings {
  try { return { ...DEFAULT_VOICE, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; } catch { return { ...DEFAULT_VOICE }; }
}
export function saveVoiceSettings(s: VoiceSettings) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ } }

export interface EngineCaps { pitch: boolean; speed: boolean; style: boolean; pauseResumesMidSentence: boolean; wordSync: boolean }
interface Engine {
  id: EngineId;
  caps: EngineCaps;
  voices(): Promise<VoiceOption[]>;
  /** resolves when the segment has been spoken; rejects with Error on failure; `stop()` makes it resolve early */
  speak(seg: Segment, s: VoiceSettings, onWord: (start: number, len: number) => void): Promise<void>;
  prefetch?(seg: Segment, s: VoiceSettings): void;
  pause(): void; resume(): void; stop(): void; unlock?(): void;
}

const BCP47: Record<SpeechLang, string> = { en: "en-US", hi: "hi-IN", hinglish: "en-IN", es: "es-ES", fr: "fr-FR", it: "it-IT", pt: "pt-BR" };

/* ---------------- server ---------------- */
type ServerSpeak = (body: Record<string, unknown>, signal: AbortSignal) => Promise<Blob>;
const SILENT_WAV = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";

export class ServerEngine implements Engine {
  id = "server" as const;
  caps: EngineCaps;
  private audio: HTMLAudioElement | null = null;
  private cache = new Map<string, Promise<Blob>>();
  private ctl = new AbortController();
  private finish: (() => void) | null = null;
  constructor(private fetchSpeech: ServerSpeak, private list: () => Promise<VoiceOption[]>, caps: Partial<EngineCaps>) {
    this.caps = { pitch: false, speed: true, style: false, pauseResumesMidSentence: true, wordSync: false, ...caps };
  }
  private el() {
    if (!this.audio) { this.audio = new Audio(); this.audio.preload = "auto"; }
    return this.audio;
  }
  unlock() { const a = this.el(); if (!a.src || a.ended || a.paused) { a.src = SILENT_WAV; a.play().catch(() => {}); } }
  voices() { return this.list(); }
  private body(seg: Segment, s: VoiceSettings) {
    return { text: seg.text, lang: seg.lang, voice: s.voices[seg.lang] || undefined, gender: s.gender, speed: s.speed, style: s.style || "" };
  }
  private get(seg: Segment, s: VoiceSettings) {
    const k = JSON.stringify(this.body(seg, s));
    let p = this.cache.get(k);
    if (!p) {
      p = this.fetchSpeech(this.body(seg, s), this.ctl.signal);
      p.catch(() => this.cache.delete(k));
      this.cache.set(k, p);
      if (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value as string);
    }
    return p;
  }
  prefetch(seg: Segment, s: VoiceSettings) { this.get(seg, s).catch(() => {}); }
  async speak(seg: Segment, s: VoiceSettings) {
    const blob = await this.get(seg, s);
    const a = this.el();
    const url = URL.createObjectURL(blob);
    try {
      await new Promise<void>((resolve, reject) => {
        this.finish = resolve;
        a.onended = () => resolve();
        a.onerror = () => reject(new Error("The audio couldn't be played."));
        a.src = url;
        a.volume = Math.max(0, Math.min(1, s.volume));
        a.play().catch((e: Error) => reject(e.name === "NotAllowedError" ? new Error("Tap Play to allow sound.") : e));
      });
    } finally { this.finish = null; URL.revokeObjectURL(url); }
  }
  pause() { this.audio?.pause(); }
  resume() { this.audio?.play().catch(() => {}); }
  stop() {
    this.ctl.abort(); this.ctl = new AbortController(); this.cache.clear();
    if (this.audio) { this.audio.pause(); this.audio.removeAttribute("src"); }
    this.finish?.();
  }
}

/* ---------------- Android native ---------------- */
interface NativeTTS { speak(id: string, text: string, lang: string, rate: number, pitch: number, volume: number, voice: string): void; stop(): void; voices(): string; status(): string }
declare global { interface Window { ZenvqoTTS?: NativeTTS; __ztts?: (id: string, ev: string, a?: number, b?: number) => void } }

export class NativeEngine implements Engine {
  id = "native" as const;
  caps: EngineCaps = { pitch: true, speed: true, style: false, pauseResumesMidSentence: false, wordSync: true };
  private seq = 0;
  private pending = new Map<string, { resolve: () => void; reject: (e: Error) => void; word: (s: number, l: number) => void }>();
  constructor(private bridge: NativeTTS) {
    window.__ztts = (id, ev, a = 0, b = 0) => {
      const p = this.pending.get(id);
      if (!p) return;
      if (ev === "range") p.word(a, b - a);
      else if (ev === "done" || ev === "stop") { this.pending.delete(id); p.resolve(); }
      else if (ev === "error") { this.pending.delete(id); p.reject(new Error(a === -2 ? "This language isn't installed in your phone's speech engine." : "The phone's speech engine failed.")); }
    };
  }
  async voices(): Promise<VoiceOption[]> {
    try {
      const list = JSON.parse(this.bridge.voices() || "[]") as { name: string; locale: string; local: boolean }[];
      return list.map((v) => ({ id: v.name, label: `${v.name}${v.local ? "" : " (online)"}`, gender: "unspecified" as const,
        langs: [v.locale.toLowerCase().startsWith("hi") ? "hi" : v.locale.toLowerCase().replace("_", "-")], engine: "native", local: v.local }));
    } catch { return []; }
  }
  speak(seg: Segment, s: VoiceSettings, onWord: (a: number, b: number) => void) {
    const id = "u" + ++this.seq;
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, word: onWord });
      this.bridge.speak(id, seg.text, BCP47[seg.lang], s.speed, s.pitch, s.volume, s.voices[seg.lang] || "");
    });
  }
  // Android's TextToSpeech has no pause: pausing stops, and resuming starts the current sentence again.
  pause() { this.bridge.stop(); }
  resume() { /* the controller re-speaks the current sentence */ }
  stop() { this.bridge.stop(); for (const [, p] of this.pending) p.resolve(); this.pending.clear(); }
}

/* ---------------- browser Web Speech ---------------- */
export class BrowserEngine implements Engine {
  id = "browser" as const;
  caps: EngineCaps = { pitch: true, speed: true, style: false, pauseResumesMidSentence: true, wordSync: true };
  private done: (() => void) | null = null;
  private synth = window.speechSynthesis;
  async voices(): Promise<VoiceOption[]> {
    let v = this.synth.getVoices();
    if (!v.length) await new Promise<void>((r) => { const t = setTimeout(r, 1200); this.synth.addEventListener?.("voiceschanged", () => { clearTimeout(t); r(); }, { once: true }); });
    v = this.synth.getVoices();
    return v.map((x) => ({ id: x.voiceURI, label: `${x.name}${x.localService ? "" : " (online)"}`, gender: "unspecified" as const,
      langs: [x.lang.toLowerCase().startsWith("hi") ? "hi" : x.lang.toLowerCase()], engine: "browser", local: x.localService }));
  }
  unlock() { try { const u = new SpeechSynthesisUtterance(""); u.volume = 0; this.synth.speak(u); } catch { /* ignore */ } }
  speak(seg: Segment, s: VoiceSettings, onWord: (a: number, b: number) => void) {
    return new Promise<void>((resolve, reject) => {
      const u = new SpeechSynthesisUtterance(seg.text);
      const all = this.synth.getVoices();
      const want = BCP47[seg.lang].toLowerCase();
      u.voice = all.find((v) => v.voiceURI === s.voices[seg.lang]) || all.find((v) => v.lang.toLowerCase().replace("_", "-") === want)
        || all.find((v) => v.lang.toLowerCase().startsWith(want.slice(0, 2))) || null;
      u.lang = u.voice?.lang || BCP47[seg.lang];
      u.rate = s.speed; u.pitch = s.pitch; u.volume = s.volume;
      u.onboundary = (e) => { if (e.name === "word" || e.name === undefined) onWord(e.charIndex, e.charLength || 0); };
      this.done = resolve;
      u.onend = () => resolve();
      u.onerror = (e) => (e.error === "interrupted" || e.error === "canceled" ? resolve() : reject(new Error(e.error === "language-unavailable" || e.error === "voice-unavailable"
        ? "Your browser has no voice for this language." : "The browser couldn't speak this.")));
      this.synth.speak(u);
    });
  }
  pause() { this.synth.pause(); }
  resume() { this.synth.resume(); }
  stop() { this.synth.cancel(); this.done?.(); this.done = null; }
}

/* ---------------- controller ---------------- */
export interface SpeechState {
  messageId: string | null;
  status: "idle" | "loading" | "playing" | "paused" | "error";
  index: number; total: number;
  current: Segment | null;
  word: { start: number; len: number } | null;
  error: string | null;
  engine: EngineId | null;
  streaming: boolean;        // more sentences may still arrive (auto-speak during a streaming reply)
}
const IDLE: SpeechState = { messageId: null, status: "idle", index: 0, total: 0, current: null, word: null, error: null, engine: null, streaming: false };

export class SpeechController {
  state: SpeechState = IDLE;
  private subs = new Set<(s: SpeechState) => void>();
  private engines: Partial<Record<EngineId, Engine>> = {};
  private queue: Segment[] = [];
  private run = 0;
  private resumeWait: (() => void) | null = null;
  settings: VoiceSettings = loadVoiceSettings();
  serverReason: string | null = null;

  register(e: Engine) { this.engines[e.id] = e; }
  setServerReason(r: string | null) { this.serverReason = r; }
  hasEngine(id: EngineId) { return !!this.engines[id]; }
  available(): EngineId[] { return (["server", "native", "browser"] as EngineId[]).filter((id) => this.engines[id]); }
  engine(): Engine | null {
    const want = this.settings.engine;
    if (want !== "auto" && this.engines[want]) return this.engines[want]!;
    return this.engines.server || this.engines.native || this.engines.browser || null;
  }
  whyUnavailable(): string {
    return this.serverReason ? `No voice available: ${this.serverReason}` : "This browser can't speak (no Web Speech API) and no server voice is set up.";
  }
  subscribe(fn: (s: SpeechState) => void) { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  private set(p: Partial<SpeechState>) { this.state = { ...this.state, ...p }; this.subs.forEach((f) => f(this.state)); }
  updateSettings(s: VoiceSettings) { this.settings = s; saveVoiceSettings(s); this.set({}); }
  /** call inside a tap/click so phones allow sound later (auto-speak) */
  unlock() { this.engine()?.unlock?.(); }

  private forced(): SpeechLang | undefined { return this.settings.lang === "auto" ? undefined : this.settings.lang; }

  play(messageId: string, text: string) {
    this.start(messageId, segments(text, this.forced()), false);
  }
  private handled = new Set<string>();       // replies already spoken (or stopped) — never restarted by auto-speak

  /** auto-speak: call with the reply so far; `done` once it is complete */
  feed(messageId: string, partial: string, done: boolean) {
    const segs = done ? segments(partial, this.forced()) : finishedSegments(partial, this.forced());
    const st = this.state.status;
    const active = this.state.messageId === messageId && (st === "loading" || st === "playing" || st === "paused");
    if (!active) {
      if (this.handled.has(messageId) || !segs.length) return;
      this.start(messageId, segs, !done);
      return;
    }
    for (let i = this.queue.length; i < segs.length; i++) this.queue.push(segs[i]);
    this.set({ total: this.queue.length, streaming: !done });
    this.resumeWait?.();
  }

  private start(messageId: string, segs: Segment[], streaming: boolean) {
    const eng = this.engine();
    this.stop();
    if (!eng) { this.set({ ...IDLE, messageId, status: "error", error: this.whyUnavailable() }); return; }
    if (!segs.length && !streaming) { this.set({ ...IDLE, messageId, status: "error", error: "There's nothing to read aloud in this reply." }); return; }
    this.queue = [...segs];
    this.handled.add(messageId);
    const my = ++this.run;
    this.set({ ...IDLE, messageId, status: "loading", total: segs.length, engine: eng.id, streaming });
    void this.loop(my, eng);
  }

  private async loop(my: number, eng: Engine) {
    let i = 0;
    while (my === this.run) {
      if (i >= this.queue.length) {
        if (!this.state.streaming) break;
        await new Promise<void>((r) => { this.resumeWait = r; });       // wait for more sentences
        this.resumeWait = null;
        continue;
      }
      const seg = this.queue[i];
      if (this.queue[i + 1]) eng.prefetch?.(this.queue[i + 1], this.settings);
      this.set({ index: i, current: seg, word: null, status: this.state.status === "paused" ? "paused" : "loading" });
      if (this.state.status === "paused") await this.waitResume(my);
      if (my !== this.run) return;
      try {
        const p = eng.speak(seg, this.settings, (start, len) => my === this.run && this.set({ word: { start, len } }));
        if (my === this.run && this.state.status !== "paused") this.set({ status: "playing" });
        await p;
      } catch (e) {
        if (my !== this.run) return;
        this.set({ status: "error", error: (e as Error).message || "Speech failed." });
        return;
      }
      if (my !== this.run) return;
      if (this.state.status === "paused" && !eng.caps.pauseResumesMidSentence) continue;   // native: say it again on resume
      i++;
    }
    if (my === this.run) this.set({ ...IDLE, messageId: this.state.messageId, total: this.state.total, index: this.state.total });
  }

  private waitResume(my: number) {
    return new Promise<void>((r) => { const t = setInterval(() => { if (my !== this.run || this.state.status !== "paused") { clearInterval(t); r(); } }, 120); });
  }

  pause() { if (this.state.status === "playing" || this.state.status === "loading") { this.engine()?.pause(); this.set({ status: "paused" }); } }
  resume() { if (this.state.status === "paused") { this.set({ status: "playing" }); this.engine()?.resume(); } }
  stop() {
    this.run++;
    this.resumeWait?.();
    for (const e of Object.values(this.engines)) e?.stop();
    this.queue = [];
    if (this.state.status !== "idle") this.set({ ...IDLE });
  }
  replay(messageId: string, text: string) { this.play(messageId, text); }
  async voices(): Promise<VoiceOption[]> { return (await this.engine()?.voices()) || []; }
  async test(lang: SpeechLang) {
    const sample: Record<SpeechLang, string> = {
      en: "Hello! This is how I sound when I read my answers aloud.",
      hi: "नमस्ते! मैं अपने जवाब इस आवाज़ में पढ़कर सुनाऊँगी।",
      hinglish: "Namaste! Main aapke answers is tarah padhkar sunaungi.",
      es: "¡Hola! Así sueno cuando leo mis respuestas.", fr: "Bonjour ! Voici ma voix quand je lis mes réponses.",
      it: "Ciao! Ecco come suono quando leggo le mie risposte.", pt: "Olá! É assim que eu soo lendo minhas respostas.",
    };
    this.start("__test", [{ text: sample[lang], lang }], false);
  }
}

export const speech = new SpeechController();
export { detectLang };
