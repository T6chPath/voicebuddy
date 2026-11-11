/** Pictures and videos the AI can look at: any picture format becomes a JPEG (iPhone HEIC, TIFF, BMP, AVIF, SVG… —
 * the Android app decodes what the WebView can't), and a video becomes a few evenly spaced snapshots. */

interface NativeImages { toJpeg?(base64: string, maxSide: number): string }
const native = () => (typeof window !== "undefined" ? (window as unknown as { ZenvqoAssets?: NativeImages }).ZenvqoAssets : undefined);

function canvasJpeg(src: CanvasImageSource, w: number, h: number, maxSide: number, quality = 0.86): string {
  const k = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  const x = c.getContext("2d")!;
  x.fillStyle = "#fff";                                    // transparent pictures (SVG, PNG logos) on white
  x.fillRect(0, 0, c.width, c.height);
  x.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", quality);
}

function viaImg(url: string, maxSide: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try { resolve(canvasJpeg(img, img.naturalWidth || 1024, img.naturalHeight || 1024, maxSide)); } catch (e) { reject(e); }
    };
    img.onerror = () => reject(new Error("decode"));
    img.src = url;
  });
}

async function toBase64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Any picture → JPEG data URL (max side `maxSide`), or null if this device can't open the format. */
export async function pictureToJpeg(file: Blob, maxSide = 2048): Promise<string | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(file);
      const out = canvasJpeg(bmp, bmp.width, bmp.height, maxSide);
      bmp.close();
      return out;
    } catch { /* not decodable this way */ }
  }
  const url = URL.createObjectURL(file);
  try { return await viaImg(url, maxSide); } catch { /* try the phone */ } finally { URL.revokeObjectURL(url); }
  const n = native();
  if (n?.toJpeg) {
    try {
      const b64 = n.toJpeg(await toBase64(file), maxSide);
      if (b64) return "data:image/jpeg;base64," + b64;
    } catch { /* not decodable */ }
  }
  return null;
}

/** Picture bytes found inside a document → small JPEGs for the AI. */
export async function bytesToJpeg(bytes: Uint8Array, mime: string, maxSide = 1600): Promise<string | null> {
  return pictureToJpeg(new Blob([bytes], { type: mime }), maxSide);
}

export interface VideoInfo { frames: string[]; duration: number; width: number; height: number }

/** A few evenly spaced snapshots of a video (and its length), or no frames if this device can't play the format. */
export async function videoFrames(file: Blob, count = 6, maxSide = 768): Promise<VideoInfo> {
  const url = URL.createObjectURL(file);
  const v = document.createElement("video");
  v.muted = true; v.preload = "auto"; v.playsInline = true; v.crossOrigin = "anonymous";
  const once = (ev: string, ms: number) => new Promise<boolean>((res) => {
    const t = window.setTimeout(() => res(false), ms);
    v.addEventListener(ev, () => { window.clearTimeout(t); res(true); }, { once: true });
    v.addEventListener("error", () => { window.clearTimeout(t); res(false); }, { once: true });
  });
  try {
    v.src = url;
    if (!(await once("loadeddata", 15000))) return { frames: [], duration: Number.isFinite(v.duration) ? v.duration : 0, width: 0, height: 0 };
    const d = Number.isFinite(v.duration) ? v.duration : 0;
    const n = d > 0 ? Math.max(1, Math.min(count, Math.ceil(d / 2))) : 1;
    const frames: string[] = [];
    for (let i = 0; i < n; i++) {
      const at = d > 0 ? (d * (i + 0.5)) / n : 0;
      if (Math.abs(v.currentTime - at) > 0.05) { v.currentTime = at; if (!(await once("seeked", 8000))) break; }
      frames.push(canvasJpeg(v, v.videoWidth, v.videoHeight, maxSide, 0.8));
    }
    return { frames, duration: d, width: v.videoWidth, height: v.videoHeight };
  } finally {
    v.removeAttribute("src"); v.load();
    URL.revokeObjectURL(url);
  }
}

/** How long an audio file is (seconds), or 0. */
export async function audioLength(file: Blob): Promise<number> {
  const url = URL.createObjectURL(file);
  const a = document.createElement("audio");
  a.preload = "metadata";
  try {
    return await new Promise<number>((res) => {
      const t = window.setTimeout(() => res(0), 8000);
      a.onloadedmetadata = () => { window.clearTimeout(t); res(Number.isFinite(a.duration) ? a.duration : 0); };
      a.onerror = () => { window.clearTimeout(t); res(0); };
      a.src = url;
    });
  } finally { URL.revokeObjectURL(url); }
}

export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
