import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { renderBlocks, type Block } from "../lib/markdown";
import type { PlotHandle } from "../plot/mount";

interface Shown { html: string; nodes: ChildNode[] }

/** Renders sanitised Markdown. Code-block "Copy" buttons are handled by event delegation.
 *  The reply is drawn block by block (see renderBlocks): when it changes, only the blocks that changed are replaced on
 *  the page, so a long reply streaming in doesn't rebuild — and re-lay-out — everything above the line being written. */
export const Markdown = memo(function Markdown({ text, live = false }: { text: string; live?: boolean }) {
  // While a reply streams in, redraw it only as often as this phone can keep up with: the gap between redraws adapts to
  // how long the last one took (fast phones ~every 50 ms, slow ones less often), so scrolling and typing stay smooth.
  const [shown, setShown] = useState(text);
  const latest = useRef(text);
  const lastAt = useRef(0);
  const cost = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  latest.current = text;
  useEffect(() => {
    if (!live) return;
    const gap = Math.max(50, Math.min(500, cost.current * 3));
    const wait = lastAt.current + gap - performance.now();
    if (wait <= 0) { lastAt.current = performance.now(); setShown(text); }
    else if (timer.current === undefined) {
      timer.current = window.setTimeout(() => { timer.current = undefined; lastAt.current = performance.now(); setShown(latest.current); }, wait);
    }
  }, [text, live]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const display = live ? shown : text;
  const blocks = useMemo<Block[]>(() => {
    const t0 = performance.now();
    const b = renderBlocks(display, live);
    cost.current = performance.now() - t0;
    return b;
  }, [display, live]);

  const box = useRef<HTMLDivElement>(null);
  const onPage = useRef<Shown[]>([]);
  const plots = useRef(new Map<HTMLElement, PlotHandle>());
  // put the blocks on the page: keep the ones that didn't change, replace from the first one that did
  useLayoutEffect(() => {
    const root = box.current;
    if (!root) return;
    const t0 = performance.now();
    const prev = onPage.current;
    let i = 0;
    while (i < prev.length && i < blocks.length && prev[i].html === blocks[i].html) i++;
    for (let j = i; j < prev.length; j++) {
      for (const n of prev[j].nodes) {
        if (n instanceof HTMLElement) for (const [el, h] of plots.current) if (n === el || n.contains(el)) { h.destroy(); plots.current.delete(el); }
        n.remove();
      }
    }
    const next = prev.slice(0, i);
    if (i < blocks.length) {
      const frag = document.createDocumentFragment();
      for (let j = i; j < blocks.length; j++) {
        const t = document.createElement("template");
        t.innerHTML = blocks[j].html;
        next.push({ html: blocks[j].html, nodes: [...t.content.childNodes] });
        frag.append(t.content);
      }
      root.append(frag);
    }
    onPage.current = next;
    // what the phone then spends laying out and painting the change counts too (measured just after that frame)
    if (live) requestAnimationFrame(() => window.setTimeout(() => { cost.current = Math.max(cost.current, performance.now() - t0 - 16); }, 0));
    cost.current += performance.now() - t0;
  }, [blocks]);
  // ```plot blocks → live graphs, once their text has settled (while a reply streams in, the last block keeps changing)
  useEffect(() => {
    const root = box.current;
    if (!root || !blocks.some((b) => b.html.includes("plot-block"))) return;
    const t = window.setTimeout(() => {
      void import("../plot/mount").then(({ mountPlot }) => {
        for (const el of root.querySelectorAll<HTMLElement>(".plot-block[data-plot]")) {
          if (el.dataset.mounted || !el.isConnected) continue;
          el.dataset.mounted = "1";
          try { plots.current.set(el, mountPlot(el, decodeURIComponent(el.dataset.plot || ""))); } catch (e) { console.error("plot failed", e); }
        }
      });
    }, live ? 600 : 50);
    return () => clearTimeout(t);
  }, [blocks, live]);
  useEffect(() => () => { for (const h of plots.current.values()) h.destroy(); plots.current.clear(); }, []);
  function onClick(e: MouseEvent<HTMLDivElement>) {
    const tex = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-copy-tex]");
    if (tex) {
      copyText(tex.dataset.copyTex || "").then((ok) => {
        tex.textContent = ok ? "Copied" : "Copy failed";
        tex.setAttribute("aria-label", tex.textContent);
        window.setTimeout(() => { tex.textContent = "Copy LaTeX"; tex.setAttribute("aria-label", "Copy LaTeX"); }, 1500);
      });
      return;
    }
    const vs = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-view-site]");
    if (vs) {
      const code = vs.closest(".code-block")?.querySelector("code")?.textContent ?? "";
      window.dispatchEvent(new CustomEvent("zc-view-site", { detail: { html: code } }));
      return;
    }
    const mk = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-make-app]");
    if (mk) {
      const code = mk.closest(".code-block")?.querySelector("code")?.textContent ?? "";
      window.dispatchEvent(new CustomEvent("zc-make-app", { detail: { html: code } }));
      return;
    }
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-copy]");
    if (!btn) return;
    const code = btn.closest(".code-block")?.querySelector("code")?.textContent ?? "";
    copyText(code).then((ok) => {
      btn.textContent = ok ? "Copied" : "Copy failed";
      window.setTimeout(() => { btn.textContent = "Copy"; }, 1500);
    });
  }
  return <div className="md" ref={box} onClick={onClick} />;
});

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");                // http:// or older browsers
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}
