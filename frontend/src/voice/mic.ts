// Microphone capture: getUserMedia with the browser's echo cancellation, noise suppression and gain control, turned
// into 20 ms frames of 16 kHz float audio. Nothing is recorded or kept: frames are handed on and dropped.
import { downsample, FRAME, frameDb } from "./vad";

export class MicError extends Error {
  constructor(message: string, public code: "denied" | "missing" | "busy" | "insecure" | "unsupported" | "failed") { super(message); }
}

export function micError(e: unknown): MicError {
  const n = (e as Error)?.name;
  if (n === "NotAllowedError" || n === "SecurityError") return new MicError("Microphone permission was denied. Allow it in the browser's site settings (the lock icon) and try again.", "denied");
  if (n === "NotFoundError" || n === "OverconstrainedError") return new MicError("No microphone was found. Plug one in or check your system sound settings.", "missing");
  if (n === "NotSupportedError" || n === "TypeError") return new MicError("This browser can't ask for microphone access on this page.", "unsupported");
  if (n === "NotReadableError" || n === "AbortError") return new MicError("The microphone is busy or blocked by another app. Close other apps using it and try again.", "busy");
  return new MicError("The microphone couldn't be started.", "failed");
}

export class Mic {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private node: ScriptProcessorNode | null = null;
  private rest = new Float32Array(0);
  muted = false;
  constructor(private onFrame: (f: Float32Array, db: number) => void, private opts: { noiseSuppression: boolean } = { noiseSuppression: true }) {}

  get active() { return !!this.stream; }

  async start() {
    if (this.stream) return;
    if (!window.isSecureContext) throw new MicError("The microphone only works on https:// pages or http://localhost. Open zenvqo over HTTPS (see README → Voice input).", "insecure");
    if (!navigator.mediaDevices?.getUserMedia) throw new MicError("This browser can't use the microphone.", "unsupported");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation: true, noiseSuppression: this.opts.noiseSuppression, autoGainControl: true, channelCount: 1 } });
    } catch (e) { throw micError(e); }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new AC();
    await this.ctx.resume().catch(() => {});
    const src = this.ctx.createMediaStreamSource(this.stream);
    // ScriptProcessor rather than AudioWorklet: a worklet needs a separate script file, which the single-file app and the
    // page's Content-Security-Policy don't allow. 4096 samples ≈ 85 ms at 48 kHz.
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    const rate = this.ctx.sampleRate;
    this.node.onaudioprocess = (ev) => {
      if (this.muted) return;
      const x = downsample(ev.inputBuffer.getChannelData(0), rate);
      const all = new Float32Array(this.rest.length + x.length);
      all.set(this.rest); all.set(x, this.rest.length);
      let i = 0;
      for (; i + FRAME <= all.length; i += FRAME) {
        const f = all.slice(i, i + FRAME);
        this.onFrame(f, frameDb(f));
      }
      this.rest = all.slice(i);
    };
    src.connect(this.node);
    const sink = this.ctx.createGain();
    sink.gain.value = 0;                                   // keep the node running without playing the mic back
    this.node.connect(sink).connect(this.ctx.destination);
    this.stream.getAudioTracks()[0]?.addEventListener("ended", () => this.stop());
  }

  setMuted(m: boolean) {
    this.muted = m;
    this.stream?.getAudioTracks().forEach((t) => { t.enabled = !m; });
  }

  stop() {
    this.node?.disconnect();
    this.ctx?.close().catch(() => {});
    this.stream?.getTracks().forEach((t) => t.stop());     // turns off the browser's recording indicator
    this.stream = null; this.ctx = null; this.node = null; this.rest = new Float32Array(0);
  }
}
