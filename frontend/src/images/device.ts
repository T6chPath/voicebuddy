// Pictures made on the phone itself: the Android app ships stable-diffusion.cpp (window.ZenvqoImageGen) and the
// user downloads a small image model once (SD-Turbo). No service, no key, no internet after the download.
import { normStyle, sizeFor, styledPrompt } from "./intent";
import { ImageEngineError, measure, type ImageJob, type MadeImage } from "./engines";

export interface DeviceBridge {
  info(): string;
  download(name: string, url: string, expected: number): boolean;
  cancelDownload(): void;
  remove(name: string): boolean;
  generate(id: string, json: string): boolean;
  cancel(id: string): void;
}

export interface DeviceInfo {
  engine: boolean; abi: string; cores: number; ramMB: number; availMB: number; freeMB: number;
  files: Record<string, number>; downloading: string | null; busy: boolean;
}

const RELEASE = "https://github.com/T6chPath/voicebuddy/releases/download/zenvqo-image-engine/";
export interface DeviceModel { id: string; file: string; label: string; url: string; mb: number; minRamMB: number; note: string }
export const DEVICE_MODELS: DeviceModel[] = [
  { id: "sd-turbo-small", file: "sd_turbo-q4_0.gguf", label: "SD-Turbo — small", url: RELEASE + "sd_turbo-q4_0.gguf", mb: 1700, minRamMB: 3500,
    note: "For phones with 4 GB of memory or more." },
  { id: "sd-turbo", file: "sd_turbo-f16-q8_0.gguf", label: "SD-Turbo — better detail", url: "https://huggingface.co/Green-Sky/SD-Turbo-GGUF/resolve/main/sd_turbo-f16-q8_0.gguf",
    mb: 2020, minRamMB: 5500, note: "Sharper details. Needs a phone with 6 GB of memory or more." },
];
/** the tiny decoder: turns the model's result into a picture about 10× faster */
export const TAESD = { file: "taesd.safetensors", url: RELEASE + "taesd.safetensors", mb: 10 };

export const QUALITY: Record<string, { steps: number; label: string }> = {
  fast: { steps: 1, label: "Fast (1 step)" },
  balanced: { steps: 2, label: "Balanced (2 steps)" },
  best: { steps: 4, label: "Best (4 steps)" },
};

export function deviceBridge(): DeviceBridge | undefined {
  return typeof window !== "undefined" ? (window as unknown as { ZenvqoImageGen?: DeviceBridge }).ZenvqoImageGen : undefined;
}

export function deviceInfo(): DeviceInfo | null {
  const b = deviceBridge();
  if (!b) return null;
  try { return JSON.parse(b.info()) as DeviceInfo; } catch { return null; }
}

/** The model to use: the chosen one if it's downloaded, else any downloaded one. */
export function deviceModel(chosen?: string): DeviceModel | null {
  const i = deviceInfo();
  if (!i?.engine) return null;
  const have = (m: DeviceModel) => (i.files[m.file] || 0) > m.mb * 0.5 * 1048576;
  return DEVICE_MODELS.find((m) => m.id === chosen && have(m)) || DEVICE_MODELS.find(have) || null;
}

/* ---------- events from the app: window.__zig(kind, data) ---------- */
type Listener = (kind: string, d: Record<string, unknown>) => void;
const listeners = new Set<Listener>();
function hub() {
  const w = window as unknown as { __zig?: (k: string, d: Record<string, unknown>) => void };
  if (!w.__zig) w.__zig = (k, d) => listeners.forEach((l) => { try { l(k, d); } catch (e) { console.error(e); } });
}
export function onDeviceEvent(l: Listener): () => void { hub(); listeners.add(l); return () => listeners.delete(l); }

/** Download a model (and the tiny decoder). Resolves when both are on the phone. */
export function downloadModel(m: DeviceModel, progress: (done: number, total: number, what: string) => void): Promise<void> {
  const b = deviceBridge();
  if (!b) return Promise.reject(new Error("Only the Android app can make pictures on the phone."));
  const one = (name: string, url: string, mb: number) => new Promise<void>((resolve, reject) => {
    const off = onDeviceEvent((k, d) => {
      if (d.name !== name) return;
      if (k === "dl") progress(Number(d.done), Number(d.total) || mb * 1048576, name);
      else if (k === "dlend") { off(); resolve(); }
      else if (k === "dlerr") { off(); reject(new Error(String(d.error))); }
    });
    if (!b.download(name, url, mb * 1048576)) { off(); reject(new Error("Another download is already running.")); }
  });
  const i = deviceInfo();
  const needTae = !(i && (i.files[TAESD.file] || 0) > 1e6);
  return one(m.file, m.url, m.mb).then(() => (needTae ? one(TAESD.file, TAESD.url, TAESD.mb).catch(() => undefined) : undefined));
}

/* ---------- making a picture ---------- */
let seq = 0;

/** A picture as a PNG data URL of exactly w×h (cover-fit), for the engine's init image or mask. */
async function fitTo(src: string, w: number, h: number, mask = false): Promise<string> {
  const img = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("The picture couldn't be read.")); i.src = src; });
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const x = c.getContext("2d")!;
  if (mask) { x.fillStyle = "#000"; x.fillRect(0, 0, w, h); }
  x.drawImage(img, 0, 0, w, h);
  return c.toDataURL("image/png");
}

export interface DeviceOptions { model: DeviceModel; quality?: string; threads?: number; strength?: number }

/** Size the phone engine works at: SD-Turbo is made for 512×512; other shapes keep about the same area. */
export function deviceSize(aspect: string): [number, number] {
  return aspect === "1:1" ? [512, 512] : sizeFor(aspect, 640, 64);
}

export async function device(job: ImageJob, o: DeviceOptions, signal: AbortSignal, progress: (f: number, t: string) => void): Promise<MadeImage> {
  const b = deviceBridge();
  if (!b) throw new ImageEngineError("Only the Android app can make pictures on the phone.", "config");
  const src = job.op === "generate" ? undefined : job.source;
  let w: number, h: number;
  if (src) {                                   // keep the picture's own shape
    const s = await measure(src);
    const k = Math.sqrt((512 * 512) / (s.width * s.height));
    w = Math.max(256, Math.round((s.width * k) / 64) * 64); h = Math.max(256, Math.round((s.height * k) / 64) * 64);
  } else [w, h] = deviceSize(job.aspect);
  let prompt = styledPrompt(job.prompt, job.style);
  if (job.noText) prompt += normStyle(job.style) === "logo" ? ", icon mark only, no text, no letters" : ", empty space for a title, no text, no letters, no watermark";
  else if (job.text) prompt += `, with the text "${job.text}"`;
  const base = QUALITY[o.quality || "balanced"]?.steps ?? 2;
  const args: Record<string, unknown> = { model: o.model.file, prompt: prompt.slice(0, 900), width: w, height: h, steps: base, cfg: 1, sampler: "euler_a",
    seed: job.seed % 2147483647, taesd: TAESD.file };
  if (o.threads) args.threads = o.threads;
  if (src) {
    const strength = o.strength ?? (job.mask ? 0.92 : job.op === "style" ? 0.7 : job.op === "variations" ? 0.55 : 0.6);
    args.init = await fitTo(src, w, h);
    args.strength = strength;
    args.steps = Math.max(2, Math.ceil(base / strength));            // the engine only runs steps × strength of them
    if (job.mask) args.mask = await fitTo(job.mask, w, h, true);
  }
  const id = `g${++seq}_${Date.now()}`;
  const t0 = Date.now();
  const png = await new Promise<string>((resolve, reject) => {
    const parts: string[] = [];
    const off = onDeviceEvent((k, d) => {
      if (d.id !== id) return;
      if (k === "gen") {
        const step = Number(d.step), steps = Number(d.steps);
        const phase = String(d.phase);
        const secs = Math.round((Date.now() - t0) / 1000);
        if (phase === "load") progress(0.05, `Getting the picture maker ready on your phone… ${secs} s`);
        else if (phase === "text") progress(0.15, `Reading your description… ${secs} s`);
        else if (phase === "sample") progress(0.2 + 0.65 * (steps ? step / steps : 0), `Drawing on your phone${steps ? ` — step ${step} of ${steps}` : "…"} ${secs} s`);
        else if (phase === "decode") progress(0.9, `Finishing the picture… ${secs} s`);
      } else if (k === "img") parts.push(String(d.chunk));
      else if (k === "genend") { off(); resolve(parts.join("")); }
      else if (k === "generr") {
        off();
        const err = String(d.error);
        if (err === "cancelled") reject(new DOMException("aborted", "AbortError"));
        else { console.warn("on-phone picture failed:", err, d.log); reject(new ImageEngineError(`Making the picture on your phone failed: ${err}`, "failed")); }
      }
    });
    signal.addEventListener("abort", () => b.cancel(id), { once: true });
    if (!b.generate(id, JSON.stringify(args))) { off(); reject(new ImageEngineError("The phone is still making another picture. Try again when it's done.", "rate_limited")); }
  });
  const dataUrl = "data:image/png;base64," + png;
  const size = await measure(dataUrl);
  return { dataUrl, mime: "image/png", width: size.width, height: size.height, engine: "on-device", model: o.model.label, notes: [] };
}
