// Crop, resize and rotate a photo before asking about it: drag the frame's corners or edges to resize it, drag inside to move it,
// pick a shape (Free, Square, 4:3, 3:4), rotate, or start over. Only the part inside the frame is sent.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Icon } from "./Icon";

type Rect = { x: number; y: number; w: number; h: number };          // fractions of the photo (0..1)
type Mode = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };
const MAX_SIDE = 2048;
const MIN_PX = 32;                                                      // the frame never gets smaller than this on screen
const SHAPES: { label: string; ratio: number | null }[] = [
  { label: "Free", ratio: null }, { label: "Square", ratio: 1 }, { label: "4:3", ratio: 4 / 3 }, { label: "3:4", ratio: 3 / 4 },
];
const HANDLES: Mode[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The biggest frame of this shape that fits the photo, centred. */
function fitted(ratio: number | null, nw: number, nh: number): Rect {
  if (!ratio) return FULL;
  let w = 1, h = (nw / ratio) / nh;
  if (h > 1) { h = 1; w = (nh * ratio) / nw; }
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((ok, bad) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => bad(new Error("The photo couldn't be opened.")); i.src = url; });
}

function toBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((ok, bad) => c.toBlob((b) => (b ? ok(b) : bad(new Error("The photo couldn't be saved."))), "image/jpeg", 0.92));
}

export function PhotoCrop({ photo, alt, onUse, onBack, backLabel, useLabel = "Use photo" }: {
  photo: Blob; alt: string; onUse: (b: Blob, changed: boolean) => void; onBack: () => void; backLabel: string; useLabel?: string;
}) {
  const [src, setSrc] = useState("");
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [rect, setRect] = useState<Rect>(FULL);
  const [ratio, setRatio] = useState<number | null>(null);
  const [turns, setTurns] = useState(0);                                // quarter turns clockwise
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const area = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const drag = useRef<{ mode: Mode; x: number; y: number; r: Rect } | null>(null);

  // the working picture: the photo turned by `turns`
  useEffect(() => {
    let alive = true, made = "";
    (async () => {
      const base = URL.createObjectURL(photo);
      try {
        const i0 = await loadImage(base);
        let url = base;
        if (turns % 4) {
          const c = document.createElement("canvas");
          const side = turns % 2 === 1;
          c.width = side ? i0.naturalHeight : i0.naturalWidth;
          c.height = side ? i0.naturalWidth : i0.naturalHeight;
          const ctx = c.getContext("2d")!;
          ctx.translate(c.width / 2, c.height / 2);
          ctx.rotate((turns % 4) * Math.PI / 2);
          ctx.drawImage(i0, -i0.naturalWidth / 2, -i0.naturalHeight / 2);
          URL.revokeObjectURL(base);
          url = URL.createObjectURL(await toBlob(c));
        }
        made = url;
        const i = url === base ? i0 : await loadImage(url);
        if (!alive) { URL.revokeObjectURL(url); return; }
        setSrc(url); setImg(i);
      } catch (e) { if (alive) setError((e as Error).message); }
    })();
    return () => { alive = false; if (made) URL.revokeObjectURL(made); };
  }, [photo, turns]);

  useLayoutEffect(() => {                                                 // how much room the photo has on screen
    const el = area.current;
    if (!el) return;
    const fit = () => setBox((b) => {                       // room for the corner handles all round
      const w = Math.max(0, el.clientWidth - 36), h = Math.max(0, el.clientHeight - 36);
      return b.w === w && b.h === h ? b : { w, h };
    });
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const nw = img?.naturalWidth || 1, nh = img?.naturalHeight || 1;
  const k = img && box.w ? Math.min(box.w / nw, box.h / nh) : 0;
  const sw = Math.round(nw * k), sh = Math.round(nh * k);                 // the photo's size on screen

  function shape(r: number | null) { setRatio(r); setRect(fitted(r, nw, nh)); }
  function rotate() { setTurns((t) => (t + 1) % 4); setRect(FULL); setRatio(null); }
  function reset() { setTurns(0); setRect(FULL); setRatio(null); }

  /** the frame after dragging `mode` by (dx, dy) — fractions of the photo */
  function moved(mode: Mode, r: Rect, dx: number, dy: number): Rect {
    const minW = Math.min(1, MIN_PX / Math.max(1, sw)), minH = Math.min(1, MIN_PX / Math.max(1, sh));
    if (mode === "move") return { ...r, x: clamp(r.x + dx, 0, 1 - r.w), y: clamp(r.y + dy, 0, 1 - r.h) };
    let { x, y, w, h } = r;
    const right = x + w, bottom = y + h;
    if (mode.includes("w")) { x = clamp(x + dx, 0, right - minW); w = right - x; }
    if (mode.includes("e")) { w = clamp(w + dx, minW, 1 - x); }
    if (mode.includes("n")) { y = clamp(y + dy, 0, bottom - minH); h = bottom - y; }
    if (mode.includes("s")) { h = clamp(h + dy, minH, 1 - y); }
    if (ratio) {                                                          // keep the shape: height follows width, within the photo
      const per = nw / (ratio * nh);                                      // h = w * per
      h = w * per;
      const maxH = mode.includes("n") ? bottom : 1 - y;
      if (h > maxH) { h = maxH; w = h / per; if (mode.includes("w")) x = right - w; }
      if (mode.includes("n")) y = bottom - h;
    }
    return { x, y, w, h };
  }

  function down(mode: Mode, e: PointerEvent<HTMLElement>) {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    drag.current = { mode, x: e.clientX, y: e.clientY, r: rect };
  }
  function move(e: PointerEvent<HTMLElement>) {
    const d = drag.current;
    if (!d || !sw) return;
    setRect(moved(d.mode, d.r, (e.clientX - d.x) / sw, (e.clientY - d.y) / sh));
  }
  function up() { drag.current = null; }
  function key(e: KeyboardEvent<HTMLDivElement>) {                       // arrows move the frame; Shift+arrows resize it
    const step = (e.altKey ? 1 : 10) / Math.max(1, sw), stepY = (e.altKey ? 1 : 10) / Math.max(1, sh);
    const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -stepY], ArrowDown: [0, stepY] };
    if (!d[e.key]) return;
    e.preventDefault();
    setRect((r) => moved(e.shiftKey ? "se" : "move", r, d[e.key][0], d[e.key][1]));
  }

  const px = { w: Math.max(1, Math.round(rect.w * nw)), h: Math.max(1, Math.round(rect.h * nh)) };
  const whole = rect.w > 0.999 && rect.h > 0.999 && turns === 0;
  const out = (() => { const s = Math.min(1, MAX_SIDE / Math.max(px.w, px.h)); return { w: Math.round(px.w * s), h: Math.round(px.h * s) }; })();

  async function use() {
    if (!img) return;
    if (whole) { onUse(photo, false); return; }
    setBusy(true);
    try {
      const c = document.createElement("canvas");
      c.width = out.w; c.height = out.h;
      const ctx = c.getContext("2d")!;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, rect.x * nw, rect.y * nh, rect.w * nw, rect.h * nh, 0, 0, out.w, out.h);
      onUse(await toBlob(c), true);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  const pct = (v: number) => `${v * 100}%`;
  return (
    <div className="crop">
      <div className="crop-area" ref={area}>
        {img && <span className="crop-size" aria-live="polite">{out.w} × {out.h}</span>}
        {error ? <p className="camera-msg" role="alert">{error}</p> : src && k > 0 && (
          <div className="crop-stage" style={{ width: sw, height: sh }} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
            <img src={src} alt={alt} draggable={false} />
            <div className="crop-frame" role="group" tabIndex={0} onKeyDown={key}
                 aria-label={`Crop frame, ${px.w} by ${px.h} pixels. Drag to move, drag the corners to resize. Arrow keys move it, Shift and arrows resize it.`}
                 style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) }}
                 onPointerDown={(e) => down("move", e)}>
              <i className="crop-grid" aria-hidden="true" />
              {HANDLES.filter((m) => !ratio || m.length === 2).map((m) => (
                <span key={m} className={`crop-h crop-${m}`} data-handle={m} aria-hidden="true" onPointerDown={(e) => down(m, e)} />
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="crop-tools" role="toolbar" aria-label="Crop tools">
        <div className="crop-shapes" role="radiogroup" aria-label="Frame shape">
          {SHAPES.map((s) => (
            <button key={s.label} type="button" role="radio" aria-checked={ratio === s.ratio} className={`crop-chip${ratio === s.ratio ? " on" : ""}`}
                    onClick={() => shape(s.ratio)}>{s.label}</button>
          ))}
        </div>
        <button type="button" className="icon-btn" aria-label="Rotate" title="Rotate" onClick={rotate} disabled={!img}><Icon name="rotate" /></button>
        <button type="button" className="icon-btn" aria-label="Start over" title="Start over" onClick={reset} disabled={whole && !ratio}><Icon name="refresh" /></button>
      </div>
      <div className="camera-bar">
        <button type="button" className="btn" onClick={onBack}>{backLabel}</button>
        <button type="button" className="btn primary" onClick={() => void use()} disabled={!img || busy}>{busy ? "Saving…" : useLabel}</button>
      </div>
    </div>
  );
}

/** A photo already in the message box, opened to crop or rotate it again. */
export function CropDialog({ photo, name, onDone, onClose }: { photo: Blob; name: string; onDone: (f: File) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const k = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="camera-backdrop" role="presentation">
      <div className="camera" role="dialog" aria-modal="true" aria-label="Crop photo" ref={ref} tabIndex={-1}>
        <PhotoCrop photo={photo} alt={`Photo to crop: ${name}`} backLabel="Cancel" useLabel="Done" onBack={onClose}
                   onUse={(b, changed) => {
                     if (changed) onDone(new File([b], name.replace(/\.[a-z0-9]+$/i, "") + (/-crop$/.test(name.replace(/\.[a-z0-9]+$/i, "")) ? "" : "-crop") + ".jpg", { type: "image/jpeg" }));
                     onClose();
                   }} />
      </div>
    </div>
  );
}
