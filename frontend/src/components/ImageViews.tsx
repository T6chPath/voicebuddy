import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import type { Attachment, ImageCaps, ImageOp, ImageOptions, ToolState } from "../api/types";
import { Icon } from "./Icon";
import { saveDataUrl } from "../lib/save";

/** Download button: in the Android app a data: link can't be downloaded, so the picture is saved through the app. */
function onDownload(e: { preventDefault(): void }, src: string, name: string) {
  if (!src.startsWith("data:") || !(window as unknown as { ZenvqoPDF?: { saveBytes?: unknown } }).ZenvqoPDF?.saveBytes) return;
  e.preventDefault();
  saveDataUrl(src, name).then((m) => window.dispatchEvent(new CustomEvent("zc-toast", { detail: { kind: "info", text: m } })),
    (err: Error) => window.dispatchEvent(new CustomEvent("zc-toast", { detail: { kind: "error", text: err.message } })));
}

export type ImageAction = "edit" | "mask" | "variations" | "remove_background" | "outpaint" | "upscale" | "open";
export const OP_LABEL: Record<ImageOp, string> = {
  generate: "Generating image", edit: "Editing image", variations: "Making variations", style: "Restyling image",
  inpaint: "Changing the painted area", remove_object: "Removing object", remove_background: "Removing background",
  replace_background: "Replacing background", outpaint: "Expanding the image", replace_object: "Replacing an object",
  upscale: "Upscaling",
};

/* ---------------- images inside a message ---------------- */

export function ImageGallery({ images, href, numberOf, onAction, actions, ops }: {
  images: Attachment[];
  href: (a: Attachment, download?: boolean) => string | null;
  numberOf: (id: string) => number | undefined;
  onAction?: (action: ImageAction, a: Attachment) => void;
  actions: boolean;
  /** what the image engines can do (hides e.g. "paint an area" where nothing can do it) */
  ops?: ImageOp[];
}) {
  const can = (op: ImageOp) => !ops || ops.includes(op);
  return (
    <ul className={`img-grid n${Math.min(images.length, 4)}`} aria-label="Images">
      {images.map((a) => {
        const src = href(a);
        const n = numberOf(a.id);
        const alt = a.meta?.prompt ? `${a.generated ? "Generated image" : "Image"}: ${a.meta.prompt}` : a.name;
        return (
          <li key={a.id} className="img-card">
            {src ? (
              <button type="button" className="img-open" onClick={() => onAction?.("open", a)} aria-label={`Open ${n ? "image #" + n : a.name} full size`}>
                <img src={src} alt={alt} loading="lazy" decoding="async" width={a.width} height={a.height}
                     style={a.width && a.height ? { aspectRatio: `${a.width} / ${a.height}` } : undefined} />
                {n && <span className="img-num" aria-hidden="true">#{n}</span>}
              </button>
            ) : <span className="chip"><Icon name="image" size={14} /> {a.name}</span>}
            {src && (
              <div className="img-actions" role="group" aria-label={`Actions for ${n ? "image #" + n : a.name}`}>
                <a className="icon-btn small" href={href(a, true) || src} download={a.name} title="Download" aria-label="Download"
                   onClick={(e) => onDownload(e, href(a, true) || src, a.name)}><Icon name="download" size={16} /></a>
                {actions && onAction && <>
                  <button type="button" className="icon-btn small" title="Edit with a message" aria-label="Edit with a message" onClick={() => onAction("edit", a)}><Icon name="wand" size={16} /></button>
                  {can("inpaint") && <button type="button" className="icon-btn small" title="Paint an area to change" aria-label="Paint an area to change" onClick={() => onAction("mask", a)}><Icon name="brush" size={16} /></button>}
                  <button type="button" className="icon-btn small" title="Variations" aria-label="Make variations" onClick={() => onAction("variations", a)}><Icon name="layers" size={16} /></button>
                  <button type="button" className="icon-btn small" title="Remove background" aria-label="Remove background" onClick={() => onAction("remove_background", a)}><Icon name="scissors" size={16} /></button>
                  {can("outpaint") && <button type="button" className="icon-btn small" title="Expand (show more around it)" aria-label="Expand the image" onClick={() => onAction("outpaint", a)}><Icon name="outpaint" size={16} /></button>}
                  {can("upscale") && <button type="button" className="icon-btn small" title="Make larger (upscale)" aria-label="Make larger" onClick={() => onAction("upscale", a)}><Icon name="upscale" size={16} /></button>}
                </>}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function ToolProgress({ t }: { t: ToolState }) {
  const pct = Math.round(t.fraction * 100);
  return (
    <div className={`tool-card ${t.status}`} role="status" aria-live="polite">
      <div className="tool-art" aria-hidden="true"><Icon name="image" size={28} /></div>
      <div className="tool-body">
        <strong>{OP_LABEL[t.op] || "Working on the image"}{t.status === "running" ? "…" : t.status === "failed" ? " — failed" : ""}</strong>
        <span className="muted">{t.text || (t.status === "running" ? "Starting…" : "")}</span>
        {t.status === "running" && <progress max={100} value={pct || undefined} aria-label={`${OP_LABEL[t.op]}: ${pct}%`} />}
      </div>
    </div>
  );
}

/* ---------------- full-size viewer ---------------- */

export function Lightbox({ a, src, download, onClose, onAction, canPaint = true }: {
  a: Attachment; src: string; download: string; onClose: () => void; onAction: (x: ImageAction, a: Attachment) => void; canPaint?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const d = ref.current; if (d && !d.open) d.showModal?.(); }, []);
  const m = a.meta;
  return (
    <dialog ref={ref} className="lightbox" aria-label="Image viewer" onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <img src={src} alt={m?.prompt || a.name} />
      <div className="lightbox-bar">
        <div className="lightbox-info">
          {m?.prompt && <p>{m.prompt}</p>}
          <p className="muted small-text">
            {a.width && a.height ? `${a.width}×${a.height}` : ""}{m ? ` · ${m.provider} · ${m.model.split("/").pop()}` : ""}
            {m?.seed != null ? ` · seed ${m.seed}` : ""}{m?.style && m.style !== "none" ? ` · ${m.style}` : ""}
          </p>
        </div>
        <a className="btn" href={download || src} download={a.name} onClick={(e) => onDownload(e, download || src, a.name)}><Icon name="download" size={16} /> Download</a>
        {canPaint && <button type="button" className="btn" onClick={() => { onClose(); onAction("mask", a); }}><Icon name="brush" size={16} /> Paint to edit</button>}
        <button type="button" className="btn primary" onClick={onClose} autoFocus>Close</button>
      </div>
    </dialog>
  );
}

/* ---------------- mask painter (inpainting / object removal) ---------------- */

export function MaskEditor({ a, src, onCancel, onApply }: {
  a: Attachment; src: string; onCancel: () => void;
  onApply: (mask: Blob, instruction: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const [size, setSize] = useState(36);
  const [erase, setErase] = useState(false);
  const [painted, setPainted] = useState(false);
  const [instruction, setInstruction] = useState("");
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => { const d = ref.current; if (d && !d.open) d.showModal?.(); }, []);

  function fit() {
    const c = canvas.current, i = img.current;
    if (!c || !i || !i.naturalWidth) return;
    c.width = i.naturalWidth;
    c.height = i.naturalHeight;
  }
  function pos(e: RPointerEvent<HTMLCanvasElement>) {
    const c = canvas.current!, r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height, scale: c.width / r.width };
  }
  function stroke(e: RPointerEvent<HTMLCanvasElement>) {
    const c = canvas.current!, ctx = c.getContext("2d")!;
    const p = pos(e);
    ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
    ctx.strokeStyle = ctx.fillStyle = "rgba(255, 64, 129, 0.55)";
    ctx.lineWidth = size * p.scale;
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.beginPath();
    const from = last.current || p;
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    if (!erase) setPainted(true);
  }
  function clear() {
    const c = canvas.current;
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    setPainted(false);
  }
  function apply() {
    const c = canvas.current!;
    const out = document.createElement("canvas");
    out.width = c.width;
    out.height = c.height;
    const o = out.getContext("2d")!;
    o.fillStyle = "#000";
    o.fillRect(0, 0, out.width, out.height);
    const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
    const m = o.getImageData(0, 0, out.width, out.height);
    for (let k = 3; k < data.data.length; k += 4) {
      if (data.data[k] > 20) { m.data[k - 3] = m.data[k - 2] = m.data[k - 1] = 255; }
    }
    o.putImageData(m, 0, 0);
    out.toBlob((b) => b && onApply(b, instruction.trim()), "image/png");
  }

  return (
    <dialog ref={ref} className="mask-editor" aria-labelledby="mask-title" onClose={onCancel}>
      <h2 id="mask-title">Paint the area to change</h2>
      <p className="muted small-text">Paint over what you want to remove or replace. Everything you don't paint stays the same.</p>
      <div className="mask-stage">
        <img ref={img} src={src} alt={a.meta?.prompt || a.name} onLoad={fit} draggable={false} />
        <canvas ref={canvas} aria-label="Mask painting area" role="img"
                onPointerDown={(e) => { drawing.current = true; last.current = null; (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId); stroke(e); }}
                onPointerMove={(e) => drawing.current && stroke(e)}
                onPointerUp={() => { drawing.current = false; last.current = null; }}
                onPointerCancel={() => { drawing.current = false; last.current = null; }} />
      </div>
      <div className="mask-tools">
        <label className="field inline"><span>Brush</span>
          <input type="range" min={6} max={120} value={size} onChange={(e) => setSize(Number(e.target.value))} aria-valuetext={`${size} pixels`} />
        </label>
        <button type="button" className={`btn small${erase ? " on" : ""}`} aria-pressed={erase} onClick={() => setErase((x) => !x)}><Icon name="eraser" size={14} /> Eraser</button>
        <button type="button" className="btn small" onClick={clear}>Clear</button>
      </div>
      <label className="field">
        <span>What should go there? <span className="muted">(leave empty to remove it)</span></span>
        <input type="text" value={instruction} maxLength={500} placeholder="e.g. a vase of sunflowers" onChange={(e) => setInstruction(e.target.value)}
               onKeyDown={(e) => { if (e.key === "Enter" && painted) { e.preventDefault(); apply(); } }} />
      </label>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn primary" disabled={!painted} onClick={apply}>{instruction ? "Replace painted area" : "Remove painted area"}</button>
      </div>
    </dialog>
  );
}

/* ---------------- image settings (composer) ---------------- */

export const DEFAULT_IMAGE_OPTS: ImageOptions = { style: "none", aspect_ratio: "1:1", resolution: 512, n: 1, output_format: "png" };
const STYLE_LABEL: Record<string, string> = { none: "Any", photorealistic: "Photorealistic", anime: "Anime", "3d": "3D render", cinematic: "Cinematic",
  cartoon: "Cartoon", "digital-art": "Digital art", illustration: "Illustration", logo: "Logo", "flat-2d": "2D flat / vector", isometric: "Isometric 3D",
  icon: "App icon", branding: "Branding / mockup", sticker: "Sticker", watercolor: "Watercolor", "oil-painting": "Oil painting", "pixel-art": "Pixel art",
  sketch: "Pencil sketch", comic: "Comic", "low-poly": "Low poly" };

export function changedOpts(o: ImageOptions): ImageOptions {
  const out: ImageOptions = {};
  (Object.keys(o) as (keyof ImageOptions)[]).forEach((k) => {
    const v = o[k];
    if (v !== undefined && v !== "" && v !== DEFAULT_IMAGE_OPTS[k]) (out as Record<string, unknown>)[k] = v;
  });
  return out;
}

export function ImageSettings({ caps, opts, setOpts, onClose }: {
  caps: ImageCaps; opts: ImageOptions; setOpts: (o: ImageOptions) => void; onClose: () => void;
}) {
  const set = <K extends keyof ImageOptions>(k: K, v: ImageOptions[K]) => setOpts({ ...opts, [k]: v });
  const seedOk = caps.providers.some((p) => p.ready && p.seed);
  const negOk = caps.providers.some((p) => p.ready && p.negative_prompt);
  const res = [512, 768, 1024, 1536, 2048].filter((r) => r <= caps.max_resolution);
  return (
    <div className="img-settings" role="dialog" aria-label="Image settings" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="img-settings-head">
        <strong>Image settings</strong>
        <button type="button" className="icon-btn small" aria-label="Close image settings" onClick={onClose}><Icon name="close" size={14} /></button>
      </div>
      <label className="check"><input type="checkbox" checked={opts.op === "generate"} onChange={(e) => set("op", e.target.checked ? "generate" : undefined)} />
        Make an image from my next message</label>
      <div className="img-settings-grid">
        <label className="field"><span>Style</span>
          <select value={opts.style || "none"} onChange={(e) => set("style", e.target.value)}>
            {(caps.styles.length ? caps.styles : Object.keys(STYLE_LABEL)).map((s) => <option key={s} value={s}>{STYLE_LABEL[s] || s}</option>)}
          </select>
        </label>
        <label className="field"><span>Aspect ratio</span>
          <select value={opts.aspect_ratio || "1:1"} onChange={(e) => set("aspect_ratio", e.target.value)}>
            {caps.aspect_ratios.map((r) => <option key={r} value={r}>{r}{r === "1:1" ? " square" : r === "16:9" ? " wide" : r === "9:16" ? " phone" : ""}</option>)}
          </select>
        </label>
        <label className="field"><span>Size</span>
          <select value={opts.resolution || 512} onChange={(e) => set("resolution", Number(e.target.value))}>
            {res.map((r) => <option key={r} value={r}>{r}px{r === 512 ? " (fast)" : r === 1536 ? " (Full HD)" : r === 2048 ? " (2K)" : ""}</option>)}
          </select>
        </label>
        <label className="field"><span>Images</span>
          <select value={opts.n || 1} onChange={(e) => set("n", Number(e.target.value))}>
            {Array.from({ length: caps.max_n }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <label className="field"><span>Format</span>
          <select value={opts.output_format || "png"} onChange={(e) => set("output_format", e.target.value as ImageOptions["output_format"])}>
            {caps.formats.map((f) => <option key={f} value={f}>{f.toUpperCase()}</option>)}
          </select>
        </label>
        <label className="field"><span>Seed {seedOk ? "" : <span className="muted">(not supported)</span>}</span>
          <input type="number" inputMode="numeric" min={0} placeholder="random" disabled={!seedOk} value={opts.seed ?? ""}
                 onChange={(e) => set("seed", e.target.value === "" ? undefined : Math.max(0, Math.floor(Number(e.target.value))))} />
        </label>
      </div>
      <label className="field"><span>Leave out (negative prompt){negOk ? "" : <span className="muted"> — added as “avoid …” for this model</span>}</span>
        <input type="text" maxLength={300} placeholder="e.g. text, watermark, blurry" value={opts.negative_prompt || ""}
               onChange={(e) => set("negative_prompt", e.target.value)} />
      </label>
      <div className="img-settings-foot">
        <span className="muted small-text">Using {caps.providers.filter((p) => p.ready).map((p) => `${p.name} (${p.model.split("/").pop()})`).join(", ")}</span>
        <button type="button" className="btn small" onClick={() => setOpts({ ...DEFAULT_IMAGE_OPTS })}>Reset</button>
      </div>
    </div>
  );
}
