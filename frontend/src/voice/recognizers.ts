// Speech recognizers.
//   server  — our mic + VAD stream 16 kHz PCM to /api/voice/ws (wss:// under HTTPS); live captions from the server.
//             If the WebSocket can't be opened (proxy, old server), each utterance is uploaded as a WAV instead.
//   native  — Android's SpeechRecognizer via window.ZenvqoASR (does its own capture and endpointing; live captions).
//   browser — the Web Speech API's SpeechRecognition (Chrome/Edge; audio goes to the browser vendor's service).
import { toPcm16, wavFrom } from "./vad";

export type RecLang = "auto" | "en" | "hi" | "hinglish";
export interface FinalResult { text: string; lang?: string; engine?: string; confidence?: string; ms?: { decode: number; after_end: number }; transport?: string }

export interface StreamRecognizer {
  kind: "stream"; id: "server"; live: boolean; transport: "websocket" | "http";
  onPartial: (t: string) => void;
  connect(): Promise<void>;
  begin(lang: RecLang, preRoll: Float32Array[]): void;
  push(f: Float32Array): void;
  end(): Promise<FinalResult>;
  cancel(): void;
  close(): void;
}

export interface SelfCallbacks { begin(): void; partial(t: string): void; level(db: number): void; final(r: FinalResult): void; error(msg: string, code: string): void; end(): void }
export interface SelfRecognizer { kind: "self"; id: "native" | "browser"; live: boolean; listen(lang: RecLang, cb: SelfCallbacks): void; stop(): void; abort(): void }
export type Recognizer = StreamRecognizer | SelfRecognizer;

/* ---------------- server ---------------- */
export class ServerRecognizer implements StreamRecognizer {
  kind = "stream" as const; id = "server" as const;
  live = false; transport: "websocket" | "http" = "websocket";
  onPartial: (t: string) => void = () => {};
  private ws: WebSocket | null = null;
  private frames: Float32Array[] = [];
  private lang: RecLang = "auto";
  private waiting: { resolve: (r: FinalResult) => void; reject: (e: Error) => void } | null = null;
  private failures = 0;
  private opening: Promise<void> | null = null;
  constructor(private postWav: (wav: Blob, lang: RecLang) => Promise<FinalResult>, private url = "") {}

  connect(): Promise<void> {
    if (this.transport === "http" || (this.ws && this.ws.readyState === WebSocket.OPEN)) return Promise.resolve();
    if (this.opening) return this.opening;
    const url = this.url || `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/voice/ws`;
    this.opening = new Promise<void>((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; this.opening = null; resolve(); } };
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch { this.fail(); done(); return; }
      ws.binaryType = "arraybuffer";
      const t = setTimeout(() => { ws.close(); this.fail(); done(); }, 5000);
      ws.onmessage = (ev) => {
        const m = JSON.parse(typeof ev.data === "string" ? ev.data : "{}");
        if (m.type === "ready") { clearTimeout(t); this.ws = ws; this.failures = 0; this.live = !!m.partials; done(); }
        else if (m.type === "partial") this.onPartial(m.text);
        else if (m.type === "final") { this.waiting?.resolve({ ...m, transport: "websocket" }); this.waiting = null; }
        else if (m.type === "error") {
          if (!settled) { clearTimeout(t); this.fail(true); ws.close(); done(); return; }
          this.waiting?.reject(new Error(m.message)); this.waiting = null;
        }
      };
      ws.onclose = () => {
        clearTimeout(t);
        if (this.ws === ws) this.ws = null;
        if (!settled) { this.fail(); done(); }
        // an utterance in flight when the socket dropped: the session falls back to uploading it
        if (this.waiting) { const w = this.waiting; this.waiting = null; this.uploadNow().then(w.resolve, w.reject); }
      };
      ws.onerror = () => { /* onclose follows */ };
    });
    return this.opening;
  }

  private fail(permanent = false) {
    this.failures++;
    if (permanent || this.failures >= 2) this.transport = "http";      // e.g. a proxy without WebSocket support
  }

  begin(lang: RecLang, preRoll: Float32Array[]) {
    this.lang = lang;
    this.frames = [...preRoll];
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "start", lang }));
      for (const f of preRoll) this.ws.send(toPcm16(f));
    }
  }
  push(f: Float32Array) {
    this.frames.push(f);                                  // kept in memory for this utterance only (fallback upload)
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(toPcm16(f));
  }
  end(): Promise<FinalResult> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return new Promise<FinalResult>((resolve, reject) => {
        this.waiting = { resolve, reject };
        this.ws!.send(JSON.stringify({ type: "end" }));
        setTimeout(() => { if (this.waiting) { this.waiting = null; this.uploadNow().then(resolve, reject); } }, 30000);
      }).finally(() => { this.frames = []; });
    }
    return this.uploadNow().finally(() => { this.frames = []; void this.connect(); });   // retry the socket for next time
  }
  private async uploadNow(): Promise<FinalResult> {
    const frames = this.frames;
    this.frames = [];
    const r = await this.postWav(wavFrom(frames), this.lang);
    return { ...r, transport: "http" };
  }
  cancel() {
    this.frames = [];
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: "cancel" }));
  }
  close() { this.ws?.close(); this.ws = null; this.frames = []; }
}

/* ---------------- Android ---------------- */
interface NativeASR { start(lang: string, partial: boolean): void; stop(): void; cancel(): void; status(): string }
declare global { interface Window { ZenvqoASR?: NativeASR; __zasr?: (ev: string, data: string) => void } }

const ANDROID_LANG: Record<RecLang, string> = { auto: "auto", en: "en-IN", hi: "hi-IN", hinglish: "hi-IN" };
const NATIVE_ERR: Record<string, string> = {
  "9": "Microphone permission was denied. Allow it in Android Settings → Apps → zenvqo → Permissions.",
  "7": "", "6": "",                                          // no match / speech timeout: just nothing heard
  "2": "Speech recognition needs the internet on this phone (or offline speech data for this language).",
  "1": "Speech recognition needs the internet on this phone.", "4": "The phone's speech service is busy. Try again.",
  "8": "The phone's speech service is busy. Try again.", "3": "The microphone couldn't record.", "5": "Speech recognition failed.",
  "12": "This language isn't supported by the phone's speech service.", "13": "This language isn't downloaded on the phone.",
  "unavailable": "This phone has no speech recognition service (install or enable the Google app).",
};

export class NativeRecognizer implements SelfRecognizer {
  kind = "self" as const; id = "native" as const; live = true;
  private cb: SelfCallbacks | null = null;
  constructor(private bridge: NativeASR) {
    window.__zasr = (ev, data) => {
      const cb = this.cb;
      if (!cb) return;
      if (ev === "begin") cb.begin();
      else if (ev === "level") cb.level(Number(data));
      else if (ev === "partial") cb.partial(data);
      else if (ev === "final") cb.final({ text: data, engine: "android", transport: "on-device" });
      else if (ev === "error") { const msg = NATIVE_ERR[data] ?? "Speech recognition failed."; if (msg) cb.error(msg, data); else cb.final({ text: "", engine: "android" }); }
      else if (ev === "end") cb.end();
    };
  }
  listen(lang: RecLang, cb: SelfCallbacks) { this.cb = cb; this.bridge.start(ANDROID_LANG[lang], true); }
  stop() { this.bridge.stop(); }
  abort() { this.cb = null; this.bridge.cancel(); }
}

/* ---------------- browser Web Speech ---------------- */
type SR = { lang: string; interimResults: boolean; continuous: boolean; maxAlternatives: number; start(): void; stop(): void; abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null; onend: (() => void) | null; onspeechstart: (() => void) | null };
const WEB_LANG: Record<RecLang, string> = { auto: "en-IN", en: "en-IN", hi: "hi-IN", hinglish: "en-IN" };

export function browserRecognitionAvailable() {
  const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return !!(w.SpeechRecognition || w.webkitSpeechRecognition);
}

export class BrowserRecognizer implements SelfRecognizer {
  kind = "self" as const; id = "browser" as const; live = true;
  private rec: SR | null = null;
  listen(lang: RecLang, cb: SelfCallbacks) {
    const w = window as unknown as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR };
    const C = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!C) { cb.error("This browser has no speech recognition.", "unsupported"); return; }
    const r = new C();
    this.rec = r;
    r.lang = WEB_LANG[lang]; r.interimResults = true; r.continuous = false; r.maxAlternatives = 1;
    let finalText = "", gotFinal = false;
    r.onspeechstart = () => cb.begin();
    r.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) finalText += res[0].transcript; else interim += res[0].transcript;
      }
      if (interim) cb.partial(finalText + interim);
    };
    r.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") return;
      gotFinal = true;
      cb.error(e.error === "not-allowed" ? "Microphone permission was denied." : e.error === "network" ? "The browser's speech service needs the internet." : `Speech recognition failed (${e.error}).`, e.error);
    };
    r.onend = () => { if (!gotFinal) { gotFinal = true; cb.final({ text: finalText.trim(), engine: "browser", transport: "browser" }); } cb.end(); };
    try { r.start(); } catch { cb.error("Speech recognition couldn't start.", "start"); }
  }
  stop() { this.rec?.stop(); }
  abort() { const r = this.rec; this.rec = null; if (r) { r.onend = null; r.onerror = null; r.onresult = null; r.abort(); } }
}
