// Picture tools that run on the phone itself (canvas, no service, no key):
//   cutOut       background → transparent PNG (flood fill from the edges over the background colour, soft edges)
//   composite    a cut-out subject placed on a new background
//   fillArea     removes what's under a painted mask (multi-scale diffusion fill, then a little texture)
//   padFor       a bigger canvas for "expand the image" (outpainting), with a mask of the new area
//   drawText     exact words on an image (posters, logos, captions): the spelling is always right
//   upscale      larger image with high-quality resampling and light sharpening
// Everything takes and returns data: URLs.

export function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error("The picture couldn't be read."));
    i.src = src;
  });
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return [c, c.getContext("2d", { willReadFrequently: true })!];
}

async function pixels(src: string, maxSide = 0): Promise<{ c: HTMLCanvasElement; x: CanvasRenderingContext2D; d: ImageData }> {
  const img = await loadImg(src);
  const k = maxSide ? Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight)) : 1;
  const [c, x] = canvas(img.naturalWidth * k, img.naturalHeight * k);
  x.drawImage(img, 0, 0, c.width, c.height);
  return { c, x, d: x.getImageData(0, 0, c.width, c.height) };
}

/* ---------------- background → transparent ---------------- */
export interface CutOut { dataUrl: string; background: number; uniform: boolean }

/** Average colour and spread of the outer border: a plain backdrop has a small spread. */
export function borderStats(d: ImageData): { rgb: [number, number, number]; spread: number } {
  const { width: w, height: h, data } = d;
  const s = [0, 0, 0], s2 = [0, 0, 0];
  let n = 0;
  const add = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    for (let k = 0; k < 3; k++) { s[k] += data[i + k]; s2[k] += data[i + k] ** 2; }
    n++;
  };
  const step = Math.max(1, Math.floor(Math.min(w, h) / 200));
  for (let x = 0; x < w; x += step) { add(x, 0); add(x, h - 1); add(x, Math.min(h - 1, 2)); add(x, Math.max(0, h - 3)); }
  for (let y = 0; y < h; y += step) { add(0, y); add(w - 1, y); add(Math.min(w - 1, 2), y); add(Math.max(0, w - 3), y); }
  const rgb = s.map((v) => v / n) as [number, number, number];
  const spread = Math.sqrt(s2.reduce((a, v, k) => a + v / n - rgb[k] ** 2, 0));
  return { rgb, spread };
}

/** Removes a plain background: everything connected to the edges that looks like the border colour. */
export async function cutOut(src: string, tolerance = 42): Promise<CutOut> {
  const { c, x, d } = await pixels(src, 1600);
  const { width: w, height: h, data } = d;
  const { rgb, spread } = borderStats(d);
  const tol = tolerance + Math.min(30, spread * 0.8);
  const dist = (i: number) => Math.sqrt((data[i] - rgb[0]) ** 2 + (data[i + 1] - rgb[1]) ** 2 + (data[i + 2] - rgb[2]) ** 2);
  const bg = new Uint8Array(w * h);                 // 1 = background
  const q = new Int32Array(w * h);
  let head = 0, tail = 0;
  const seed = (p: number) => { if (!bg[p] && dist(p * 4) < tol) { bg[p] = 1; q[tail++] = p; } };
  for (let X = 0; X < w; X++) { seed(X); seed((h - 1) * w + X); }
  for (let Y = 0; Y < h; Y++) { seed(Y * w); seed(Y * w + w - 1); }
  while (head < tail) {
    const p = q[head++], px = p % w, py = (p / w) | 0;
    if (px > 0) seed(p - 1);
    if (px < w - 1) seed(p + 1);
    if (py > 0) seed(p - w);
    if (py < h - 1) seed(p + w);
  }
  // soft edge: subject pixels next to the background get partial alpha by how close they are to the backdrop colour
  let count = 0;
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    if (bg[p]) { data[i + 3] = 0; count++; continue; }
    const px = p % w, py = (p / w) | 0;
    const edge = (px > 0 && bg[p - 1]) || (px < w - 1 && bg[p + 1]) || (py > 0 && bg[p - w]) || (py < h - 1 && bg[p + w]);
    if (edge) data[i + 3] = Math.max(60, Math.min(255, Math.round(((dist(i) - tol * 0.5) / (tol * 1.2)) * 255)));
  }
  x.putImageData(d, 0, 0);
  return { dataUrl: c.toDataURL("image/png"), background: count / (w * h), uniform: spread < 28 };
}

/** A cut-out subject on a new background (both data: URLs); the subject is fitted inside, bottom-centred. */
export async function composite(subject: string, background: string, w: number, h: number): Promise<string> {
  const [c, x] = canvas(w, h);
  const bg = await loadImg(background), sub = await loadImg(subject);
  const kb = Math.max(w / bg.naturalWidth, h / bg.naturalHeight);         // cover
  x.drawImage(bg, (w - bg.naturalWidth * kb) / 2, (h - bg.naturalHeight * kb) / 2, bg.naturalWidth * kb, bg.naturalHeight * kb);
  const ks = Math.min(w / sub.naturalWidth, h / sub.naturalHeight);       // contain
  const sw = sub.naturalWidth * ks, sh = sub.naturalHeight * ks;
  x.save();
  x.shadowColor = "rgba(0,0,0,0.28)";
  x.shadowBlur = Math.round(Math.min(w, h) * 0.02);
  x.shadowOffsetY = Math.round(Math.min(w, h) * 0.008);
  x.drawImage(sub, (w - sw) / 2, h - sh, sw, sh);
  x.restore();
  return c.toDataURL("image/jpeg", 0.92);
}

/* ---------------- remove what's under a mask ---------------- */
/** Content-aware-ish fill: the painted area is filled from its surroundings, coarse to fine, then given a little
 * grain so it doesn't look smeared. Good for small objects on fairly even backgrounds (sky, wall, sand, grass). */
export async function fillArea(src: string, maskSrc: string): Promise<string> {
  const { c, x, d } = await pixels(src, 1600);
  const W = c.width, H = c.height;
  const m = await loadImg(maskSrc);
  const [mc, mx] = canvas(W, H);
  mx.drawImage(m, 0, 0, W, H);
  const md = mx.getImageData(0, 0, W, H).data;
  const hole = new Uint8Array(W * H);
  let holes = 0;
  for (let p = 0; p < W * H; p++) if (md[p * 4] + md[p * 4 + 1] + md[p * 4 + 2] > 380 && md[p * 4 + 3] > 100) { hole[p] = 1; holes++; }
  void mc;
  if (!holes) return src;
  // grow the hole a little so the object's edge goes too
  const grow = Math.max(2, Math.round(Math.min(W, H) * 0.006));
  for (let g = 0; g < grow; g++) {
    const prev = hole.slice();
    for (let p = 0; p < W * H; p++) {
      if (prev[p]) continue;
      const px = p % W, py = (p / W) | 0;
      if ((px > 0 && prev[p - 1]) || (px < W - 1 && prev[p + 1]) || (py > 0 && prev[p - W]) || (py < H - 1 && prev[p + W])) hole[p] = 1;
    }
  }
  const img = new Float32Array(W * H * 3);
  for (let p = 0; p < W * H; p++) for (let k = 0; k < 3; k++) img[p * 3 + k] = d.data[p * 4 + k];
  const filled = pyramidFill(img, hole, W, H);
  // grain: copy the local texture strength from just outside the hole
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
  for (let p = 0; p < W * H; p++) {
    if (!hole[p]) continue;
    const n = rnd() * 7;
    for (let k = 0; k < 3; k++) d.data[p * 4 + k] = Math.max(0, Math.min(255, filled[p * 3 + k] + n));
  }
  x.putImageData(d, 0, 0);
  return c.toDataURL("image/jpeg", 0.93);
}

function pyramidFill(img: Float32Array, hole: Uint8Array, W: number, H: number): Float32Array {
  if (W <= 8 || H <= 8) return diffuse(img, hole, W, H, null, 200);
  // half-size level: average of known pixels; a 2×2 block is unknown only if all 4 are unknown
  const w = Math.ceil(W / 2), h = Math.ceil(H / 2);
  const small = new Float32Array(w * h * 3), sh = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let n = 0;
    const acc = [0, 0, 0];
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const X = Math.min(W - 1, x * 2 + dx), Y = Math.min(H - 1, y * 2 + dy), q = Y * W + X;
      if (!hole[q]) { n++; for (let k = 0; k < 3; k++) acc[k] += img[q * 3 + k]; }
    }
    const p = y * w + x;
    if (n) for (let k = 0; k < 3; k++) small[p * 3 + k] = acc[k] / n; else sh[p] = 1;
  }
  const coarse = pyramidFill(small, sh, w, h);
  return diffuse(img, hole, W, H, (p) => { const x = p % W, y = (p / W) | 0; const q = ((y >> 1) * w + (x >> 1)) * 3; return [coarse[q], coarse[q + 1], coarse[q + 2]]; }, 30);
}

function diffuse(img: Float32Array, hole: Uint8Array, W: number, H: number, init: ((p: number) => number[]) | null, iters: number): Float32Array {
  const out = img.slice();
  const idx: number[] = [];
  for (let p = 0; p < W * H; p++) if (hole[p]) { idx.push(p); if (init) { const v = init(p); for (let k = 0; k < 3; k++) out[p * 3 + k] = v[k]; } }
  if (!init) {                                       // smallest level: start from the mean of the known pixels
    const m = [0, 0, 0];
    let n = 0;
    for (let p = 0; p < W * H; p++) if (!hole[p]) { n++; for (let k = 0; k < 3; k++) m[k] += img[p * 3 + k]; }
    for (const p of idx) for (let k = 0; k < 3; k++) out[p * 3 + k] = n ? m[k] / n : 128;
  }
  for (let it = 0; it < iters; it++) {
    for (const p of idx) {
      const x = p % W, y = (p / W) | 0;
      let n = 0;
      const acc = [0, 0, 0];
      for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1]) {
        if (q < 0) continue;
        n++;
        for (let k = 0; k < 3; k++) acc[k] += out[q * 3 + k];
      }
      if (n) for (let k = 0; k < 3; k++) out[p * 3 + k] = acc[k] / n;
    }
  }
  return out;
}

/* ---------------- expand the canvas (outpainting) ---------------- */
export type Side = "center" | "left" | "right" | "top" | "bottom";

/** The image placed in a canvas of the new aspect ratio (or `grow` × bigger); new areas are filled with a blurred
 * stretch of the edges (context for the model) and marked white in the mask. */
export async function padFor(src: string, aspect: string | null, side: Side = "center", grow = 1.5): Promise<{ padded: string; mask: string; w: number; h: number }> {
  const img = await loadImg(src);
  const iw = img.naturalWidth, ih = img.naturalHeight;
  let W: number, H: number;
  if (aspect) {
    const [a, b] = aspect.split(":").map(Number);
    if (a / b >= iw / ih) { H = ih; W = Math.round((ih * a) / b); } else { W = iw; H = Math.round((iw * b) / a); }
    if (W === iw && H === ih) { W = Math.round(iw * grow); H = Math.round(ih * grow); }
  } else {
    W = side === "top" || side === "bottom" ? iw : Math.round(iw * grow);
    H = side === "left" || side === "right" ? ih : Math.round(ih * grow);
  }
  const k = Math.min(1, 2048 / Math.max(W, H));
  W = Math.round(W * k); H = Math.round(H * k);
  const sw = Math.round(iw * k), sh = Math.round(ih * k);
  const ox = side === "left" ? W - sw : side === "right" ? 0 : Math.round((W - sw) / 2);
  const oy = side === "top" ? H - sh : side === "bottom" ? 0 : Math.round((H - sh) / 2);
  const [c, x] = canvas(W, H);
  x.filter = "blur(24px)";
  x.drawImage(img, 0, 0, W, H);                      // stretched and blurred: colours that continue the picture
  x.filter = "none";
  x.drawImage(img, ox, oy, sw, sh);
  const [mc, mx] = canvas(W, H);
  mx.fillStyle = "#fff";
  mx.fillRect(0, 0, W, H);
  mx.fillStyle = "#000";
  mx.fillRect(ox, oy, sw, sh);
  return { padded: c.toDataURL("image/png"), mask: mc.toDataURL("image/png"), w: W, h: H };
}

/* ---------------- exact text ---------------- */
export type TextLayout = "poster" | "logo" | "caption" | "banner";

function wrap(x: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (x.measureText(t).width <= maxW || !cur) cur = t; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Brightness of a region (0 = black, 255 = white), to pick a readable text colour. */
function regionLight(x: CanvasRenderingContext2D, rx: number, ry: number, rw: number, rh: number): number {
  const d = x.getImageData(Math.max(0, rx), Math.max(0, ry), Math.max(1, rw), Math.max(1, rh)).data;
  let s = 0, n = 0;
  for (let i = 0; i < d.length; i += 16) { s += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; n++; }
  return n ? s / n : 128;
}

/** Writes `text` on the picture, sized to fit, in a readable colour: poster = big title at the top, logo = name
 * under the mark, caption/banner = a band at the bottom. Hindi and other scripts use the phone's fonts. */
export async function drawText(src: string, text: string, layout: TextLayout = "poster"): Promise<string> {
  const img = await loadImg(src);
  const W = img.naturalWidth, H = img.naturalHeight;
  const [c, x] = canvas(W, H);
  x.drawImage(img, 0, 0);
  const family = "'Noto Sans', 'Noto Sans Devanagari', Roboto, 'Segoe UI', system-ui, sans-serif";
  const maxW = W * (layout === "logo" ? 0.86 : 0.88);
  let size = Math.round(Math.min(W, H) * (layout === "poster" ? 0.13 : layout === "logo" ? 0.11 : 0.075));
  let lines: string[] = [];
  const weight = layout === "caption" ? 600 : 800;
  for (; size > 10; size = Math.round(size * 0.9)) {
    x.font = `${weight} ${size}px ${family}`;
    lines = wrap(x, text, maxW);
    if (lines.length <= (layout === "poster" ? 3 : 2) && lines.every((l) => x.measureText(l).width <= maxW)) break;
  }
  const lh = size * 1.18, blockH = lines.length * lh;
  let top: number;
  if (layout === "poster") top = H * 0.06;
  else if (layout === "logo") top = H * 0.94 - blockH;
  else top = H - blockH - H * 0.05;
  if (layout === "caption" || layout === "banner") {
    const pad = size * 0.5;
    const grad = x.createLinearGradient(0, top - pad * 2, 0, H);
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(0.35, "rgba(0,0,0,0.55)");
    grad.addColorStop(1, "rgba(0,0,0,0.7)");
    x.fillStyle = grad;
    x.fillRect(0, top - pad * 2, W, H - top + pad * 2);
  }
  const light = layout === "caption" || layout === "banner" ? 0 : regionLight(x, W * 0.06, top, W * 0.88, blockH);
  const fill = light > 140 ? "#111111" : "#ffffff", stroke = light > 140 ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.65)";
  x.font = `${weight} ${size}px ${family}`;
  x.textAlign = "center";
  x.textBaseline = "top";
  x.lineJoin = "round";
  lines.forEach((l, i) => {
    const y = top + i * lh;
    x.lineWidth = Math.max(2, size * 0.12);
    x.strokeStyle = stroke;
    x.strokeText(l, W / 2, y);
    x.fillStyle = fill;
    x.fillText(l, W / 2, y);
  });
  return c.toDataURL("image/png");
}

/** Makes room for words: a logo mark is shrunk upward onto a plain background, leaving a band for the name. */
export async function roomForName(src: string): Promise<string> {
  const img = await loadImg(src);
  const W = img.naturalWidth, H = img.naturalHeight;
  const { d } = await pixels(src, 400);
  const { rgb } = borderStats(d);
  const [c, x] = canvas(W, H);
  x.fillStyle = `rgb(${rgb.map(Math.round).join(",")})`;
  x.fillRect(0, 0, W, H);
  const k = 0.72;
  x.drawImage(img, (W - W * k) / 2, H * 0.04, W * k, H * k);
  return c.toDataURL("image/png");
}

/* ---------------- bigger ---------------- */
/** High-quality upscaling in 2× steps with a light unsharp mask (it can't invent detail; it makes edges crisp). */
export async function upscale(src: string, longest: number): Promise<{ dataUrl: string; w: number; h: number }> {
  const img = await loadImg(src);
  let cw = img.naturalWidth, ch = img.naturalHeight;
  const target = Math.min(longest, 4096) / Math.max(cw, ch);
  if (target <= 1.01) return { dataUrl: src, w: cw, h: ch };
  let cur: CanvasImageSource = img;
  while (Math.max(cw, ch) < Math.max(img.naturalWidth, img.naturalHeight) * target - 1) {
    const step = Math.min(2, (Math.max(img.naturalWidth, img.naturalHeight) * target) / Math.max(cw, ch));
    const [c, x] = canvas(cw * step, ch * step);
    x.imageSmoothingEnabled = true;
    x.imageSmoothingQuality = "high";
    x.drawImage(cur, 0, 0, c.width, c.height);
    cur = c; cw = c.width; ch = c.height;
  }
  const [c, x] = canvas(cw, ch);
  x.drawImage(cur, 0, 0);
  // unsharp mask: original + 0.5 × (original − blurred)
  const [, bx] = canvas(cw, ch);
  bx.filter = "blur(1.2px)";
  bx.drawImage(c, 0, 0);
  const o = x.getImageData(0, 0, cw, ch), bl = bx.getImageData(0, 0, cw, ch).data;
  for (let i = 0; i < o.data.length; i += 4) for (let k = 0; k < 3; k++) o.data[i + k] = Math.max(0, Math.min(255, o.data[i + k] * 1.5 - bl[i + k] * 0.5));
  x.putImageData(o, 0, 0);
  return { dataUrl: c.toDataURL("image/jpeg", 0.92), w: cw, h: ch };
}

/** Image size of a data: URL. */
export async function sizeOf(src: string): Promise<{ w: number; h: number }> {
  const i = await loadImg(src);
  return { w: i.naturalWidth, h: i.naturalHeight };
}

/* ---------------- free inpainting / outpainting helpers ---------------- */
/** `patch` shown only where the mask is white (soft edge), `src` everywhere else. */
export async function blendUnder(src: string, patch: string, maskSrc: string, feather = 10): Promise<string> {
  const [img, p, m] = await Promise.all([loadImg(src), loadImg(patch), loadImg(maskSrc)]);
  const W = img.naturalWidth, H = img.naturalHeight;
  const [c, x] = canvas(W, H);
  x.drawImage(img, 0, 0);
  const [pc, px] = canvas(W, H);
  px.drawImage(p, 0, 0, W, H);
  const [, mx] = canvas(W, H);
  mx.filter = `blur(${feather}px)`;
  mx.drawImage(m, 0, 0, W, H);
  mx.filter = "none";
  const md = mx.getImageData(0, 0, W, H).data;
  const pd = px.getImageData(0, 0, W, H);
  for (let i = 0; i < md.length; i += 4) pd.data[i + 3] = Math.round((md[i] + md[i + 1] + md[i + 2]) / 3);
  px.putImageData(pd, 0, 0);
  x.drawImage(pc, 0, 0);
  return c.toDataURL("image/png");
}

/** The original placed on a larger generated scene (`bg`, any size), at `side`, with a soft seam. */
export async function placeOn(bg: string, src: string, side: Side = "center", W?: number, H?: number): Promise<string> {
  const [b, img] = await Promise.all([loadImg(bg), loadImg(src)]);
  W = W || b.naturalWidth; H = H || b.naturalHeight;
  const k = Math.min(W / img.naturalWidth, H / img.naturalHeight, 1);
  const sw = Math.round(img.naturalWidth * k), sh = Math.round(img.naturalHeight * k);
  const ox = side === "left" ? W - sw : side === "right" ? 0 : Math.round((W - sw) / 2);
  const oy = side === "top" ? H - sh : side === "bottom" ? 0 : Math.round((H - sh) / 2);
  const [c, x] = canvas(W, H);
  x.drawImage(b, 0, 0, W, H);
  const [oc, ox2] = canvas(sw, sh);
  ox2.drawImage(img, 0, 0, sw, sh);
  // fade the inner edges that meet the new scene
  const f = Math.round(Math.min(sw, sh) * 0.06);
  ox2.globalCompositeOperation = "destination-in";
  const edges: [boolean, boolean, boolean, boolean] = [ox > 0, ox + sw < W, oy > 0, oy + sh < H];   // left, right, top, bottom
  const g = (x0: number, y0: number, x1: number, y1: number) => { const gr = ox2.createLinearGradient(x0, y0, x1, y1); gr.addColorStop(0, "rgba(0,0,0,0)"); gr.addColorStop(1, "rgba(0,0,0,1)"); return gr; };
  if (edges[0]) { ox2.fillStyle = g(0, 0, f, 0); ox2.fillRect(0, 0, sw, sh); }
  if (edges[1]) { ox2.fillStyle = g(sw, 0, sw - f, 0); ox2.fillRect(0, 0, sw, sh); }
  if (edges[2]) { ox2.fillStyle = g(0, 0, 0, f); ox2.fillRect(0, 0, sw, sh); }
  if (edges[3]) { ox2.fillStyle = g(0, sh, 0, sh - f); ox2.fillRect(0, 0, sw, sh); }
  x.drawImage(oc, ox, oy);
  return c.toDataURL("image/png");
}
