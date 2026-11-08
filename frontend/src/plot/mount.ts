// Turns a ```plot block into a live graph in the chat (and into a picture for PDFs).
//
// Touch: one finger traces along the curve (2D) or rotates (3D); two fingers pan and zoom; swiping up/down still
// scrolls the chat on 2D graphs. Mouse: drag to pan/rotate, wheel to zoom, hover to trace. Keyboard: arrows, + and −,
// 0 to reset.
import { LIGHT, pageTheme, fmt } from "./common";
import { Graph2D, KIND } from "./graph2d";
import { Graph3D } from "./graph3d";
import { parseSpec, paramScope, type Spec } from "./spec";

export interface PlotHandle { destroy(): void }


function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function sizeFor(width: number, dim: 2 | 3): { w: number; h: number } {
  const w = Math.max(240, Math.floor(width));
  const h = dim === 3 ? Math.round(Math.min(Math.max(w * 0.9, 280), 560)) : Math.round(Math.min(Math.max(w * 0.66, 220), 460));
  return { w, h };
}

/** Save the picture: Android app → Downloads/zenvqo; browsers → a download. */
function savePng(canvas: HTMLCanvasElement, title: string, note: (s: string) => void) {
  const name = `graph-${(title || "plot").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").slice(0, 40) || "plot"}.png`;
  const url = canvas.toDataURL("image/png");
  const bridge = (window as unknown as { ZenvqoPDF?: { saveBytes?(id: string, b64: string, name: string): void } }).ZenvqoPDF;
  if (bridge?.saveBytes) {
    const id = "png" + Date.now();
    const prev = window.__zpdf;
    window.__zpdf = (rid, status, data) => {
      if (rid !== id) { prev?.(rid, status, data); return; }
      window.__zpdf = prev;
      note(status === "saved" ? "Saved to Downloads/zenvqo" : data || "Couldn't save the picture");
    };
    bridge.saveBytes(id, url.split(",")[1], name);
    return;
  }
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  note("Downloaded " + name);
}

export function mountPlot(host: HTMLElement, src: string): PlotHandle {
  host.textContent = "";
  host.classList.add("plot");
  const spec: Spec = parseSpec(src);
  if (!spec.items.length) {
    const box = el("div", "plot-error");
    box.setAttribute("role", "note");
    box.textContent = spec.errors.length ? `Couldn't draw this graph — ${spec.errors.join("; ")}` : "Nothing to draw.";
    const pre = el("pre", "plot-src", src.trim());
    host.append(box, pre);
    return { destroy() {} };
  }
  const values: Record<string, number> = {};
  const scope = () => paramScope(spec, values);
  if (spec.title) host.append(el("div", "plot-title", spec.title));
  const frame = el("div", "plot-frame");
  const canvas = el("canvas");
  canvas.tabIndex = 0;
  canvas.setAttribute("role", "img");
  frame.append(canvas);
  const tools = el("div", "plot-tools");
  const btn = (label: string, text: string, onClick: () => void) => {
    const b = el("button", "plot-btn", text);
    b.type = "button";
    b.setAttribute("aria-label", label);
    b.title = label;
    b.addEventListener("click", onClick);
    tools.append(b);
    return b;
  };
  host.append(frame);
  const readout = el("div", "plot-readout");
  readout.setAttribute("aria-live", "polite");
  const theme = () => pageTheme(host);
  let width = host.clientWidth || 360;
  let size = sizeFor(width, spec.dim);
  const g2 = spec.dim === 2 ? new Graph2D(canvas, spec, scope(), theme(), size) : null;
  const g3 = spec.dim === 3 ? new Graph3D(canvas, spec, scope(), theme(), size) : null;

  let raf = 0, fineTimer = 0, first = true;
  const render = (fast: boolean) => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      if (g2) {
        g2.theme = theme();
        g2.draw(fast);
        canvas.setAttribute("aria-label", g2.describe());
        if (first && !fast) {
          first = false;
          const kp = g2.keyPointSummary();
          readout.textContent = "Tap or hover the curve for coordinates" + (kp ? ` · ${kp}` : "");
        }
      }
      if (g3) { g3.theme = theme(); g3.draw(); canvas.setAttribute("aria-label", g3.describe()); }
    });
    if (fast && g2) { clearTimeout(fineTimer); fineTimer = window.setTimeout(() => render(false), 160); }
  };

  // ---- toolbar
  btn("Zoom in", "+", () => { g2 ? g2.zoom(0.7) : g3!.zoom(0.8); render(false); });
  btn("Zoom out", "−", () => { g2 ? g2.zoom(1 / 0.7) : g3!.zoom(1.25); render(false); });
  btn("Reset view", "⟲", () => { if (g2) { g2.view = g2.autoView(); g2.hover = null; } else g3!.resetView(); render(false); });
  btn("Save as picture", "PNG", () => savePng(canvas, spec.title || spec.items[0].label, (s) => { readout.textContent = s; }));
  frame.append(tools);

  // ---- legend
  const legend = el("ul", "plot-legend");
  for (const it of spec.items) {
    const li = el("li");
    const sw = el("span", "plot-swatch");
    sw.style.background = it.color;
    li.append(sw, el("span", "plot-eq", it.label));
    legend.append(li);
  }
  host.append(legend);

  // ---- sliders for parameters
  if (spec.params.length) {
    const box = el("div", "plot-params");
    for (const p of spec.params) {
      const row = el("label", "plot-param");
      const name = el("span", "plot-param-name", p.name);
      const input = el("input");
      input.type = "range";
      input.min = String(p.min);
      input.max = String(p.max);
      input.step = String((p.max - p.min) / 200);
      input.value = String(p.value);
      input.setAttribute("aria-label", `Parameter ${p.name}`);
      const out = el("output", "plot-param-value", `= ${fmt(p.value)}`);
      input.addEventListener("input", () => {
        values[p.name] = parseFloat(input.value);
        out.textContent = `= ${fmt(values[p.name])}`;
        if (g2) { g2.setScope(scope()); render(true); }
        if (g3) { g3.setScope(scope(), true); render(true); clearTimeout(fineTimer); fineTimer = window.setTimeout(() => { g3.setScope(scope()); render(false); }, 250); }
      });
      row.append(name, input, out);
      box.append(row);
    }
    host.append(box);
  }
  host.append(readout);
  if (spec.errors.length) {
    const e = el("div", "plot-error");
    e.textContent = `Skipped: ${spec.errors.join("; ")}`;
    host.append(e);
  }

  // ---- pointer / touch
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch: { d: number; cx: number; cy: number } | null = null;
  let dragged = false;
  const local = (e: PointerEvent | WheelEvent) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const showHover = (x: number, y: number, reach: number) => {
    if (!g2) return;
    g2.hover = g2.pick(x, y, reach);
    if (g2.hover) {
      const h = g2.hover;
      const kind = KIND.test(h.text) ? h.text + " " : "";
      readout.textContent = `${kind}x = ${fmt(h.x)}, y = ${fmt(h.y)}${kind ? "" : "  ·  " + h.text}`;
    }
    render(false);
  };
  canvas.style.touchAction = spec.dim === 2 ? "pan-y" : "none";
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, local(e));
    dragged = false;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    }
    if (e.pointerType !== "mouse" && pointers.size === 1 && g2) showHover(local(e).x, local(e).y, 60);
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = local(e);
    const prev = pointers.get(e.pointerId);
    if (!prev) {                                            // mouse hover
      if (e.pointerType === "mouse" && g2) showHover(p.x, p.y, 40);
      return;
    }
    pointers.set(e.pointerId, p);
    if (pointers.size >= 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      if (g2) { g2.pan(cx - pinch.cx, cy - pinch.cy); g2.zoom(pinch.d / Math.max(d, 1), cx, cy); g2.hover = null; }
      if (g3) g3.zoom(pinch.d / Math.max(d, 1));
      pinch = { d, cx, cy };
      render(true);
      return;
    }
    const dx = p.x - prev.x, dy = p.y - prev.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) dragged = true;
    if (g3) { g3.rotate(dx, dy); render(false); return; }
    if (e.pointerType === "mouse") { g2!.pan(dx, dy); g2!.hover = null; render(true); }
    else showHover(p.x, p.y, 60);                            // one finger on a 2D graph: trace
  });
  const up = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (dragged) render(false);
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  canvas.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse" && g2 && !pointers.size) { g2.hover = null; render(false); } });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const p = local(e);
    const f = Math.exp(Math.max(-0.5, Math.min(0.5, e.deltaY * 0.0015)));
    if (g2) { g2.zoom(f, p.x, p.y); render(true); }
    if (g3) { g3.zoom(f); render(false); }
  }, { passive: false });
  canvas.addEventListener("dblclick", (e) => { const p = local(e as unknown as PointerEvent); if (g2) g2.zoom(0.5, p.x, p.y); else g3!.zoom(0.7); render(false); });
  canvas.addEventListener("keydown", (e) => {
    const k = e.key;
    let used = true;
    if (g2) {
      if (k === "ArrowLeft") g2.pan(40, 0); else if (k === "ArrowRight") g2.pan(-40, 0);
      else if (k === "ArrowUp") g2.pan(0, 40); else if (k === "ArrowDown") g2.pan(0, -40);
      else if (k === "+" || k === "=") g2.zoom(0.8); else if (k === "-") g2.zoom(1.25);
      else if (k === "0" || k === "Home") g2.view = g2.autoView(); else used = false;
    } else if (g3) {
      if (k === "ArrowLeft") g3.rotate(-20, 0); else if (k === "ArrowRight") g3.rotate(20, 0);
      else if (k === "ArrowUp") g3.rotate(0, -15); else if (k === "ArrowDown") g3.rotate(0, 15);
      else if (k === "+" || k === "=") g3.zoom(0.85); else if (k === "-") g3.zoom(1.18);
      else if (k === "0" || k === "Home") g3.resetView(); else used = false;
    }
    if (used) { e.preventDefault(); render(false); }
  });

  // ---- size follows the chat column; theme follows the app
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => {
    const w = host.clientWidth;
    if (!w || Math.abs(w - width) < 2) return;
    width = w;
    size = sizeFor(w, spec.dim);
    const keep = g2 ? g2.view : null;
    (g2 || g3)!.setSize(size.w, size.h);
    if (g2 && keep) {
      // keep the centre and scale per pixel; first layout: start from the automatic view
      g2.view = g2.home = g2.autoView();
    }
    render(false);
  }) : null;
  ro?.observe(host);
  const mo = new MutationObserver(() => render(false));
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
  render(false);
  if (g3) readout.textContent = "Drag to rotate · pinch or scroll to zoom";

  return {
    destroy() {
      cancelAnimationFrame(raf);
      clearTimeout(fineTimer);
      ro?.disconnect();
      mo.disconnect();
    },
  };
}

/** A still picture of a plot block (for PDFs): light theme, legend drawn in. */
export function plotImage(src: string, w = 640): string | null {
  const spec = parseSpec(src);
  if (!spec.items.length) return null;
  const canvas = document.createElement("canvas");
  const size = sizeFor(w, spec.dim);
  if (spec.dim === 2) {
    const g = new Graph2D(canvas, spec, paramScope(spec), LIGHT, size, true);
    g.draw(false);
  } else {
    const g = new Graph3D(canvas, spec, paramScope(spec), LIGHT, size);
    g.draw();
  }
  return canvas.toDataURL("image/png");
}
