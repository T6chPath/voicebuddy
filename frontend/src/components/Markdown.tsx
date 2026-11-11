import { memo, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { renderMarkdown } from "../lib/markdown";
import type { PlotHandle } from "../plot/mount";

/** Renders sanitised Markdown. Code-block "Copy" buttons are handled by event delegation. */
export const Markdown = memo(function Markdown({ text, live = false }: { text: string; live?: boolean }) {
  // While a reply streams in, re-format it only as often as this phone can keep up with: the gap between redraws
  // adapts to how long the last one took (fast phones ~every 60 ms, slow ones less often), so typing stays smooth.
  const [shown, setShown] = useState(text);
  const latest = useRef(text);
  const lastAt = useRef(0);
  const cost = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  latest.current = text;
  useEffect(() => {
    if (!live) return;
    const gap = Math.max(60, Math.min(400, cost.current * 4));
    const wait = lastAt.current + gap - performance.now();
    if (wait <= 0) { lastAt.current = performance.now(); setShown(text); }
    else if (timer.current === undefined) {
      timer.current = window.setTimeout(() => { timer.current = undefined; lastAt.current = performance.now(); setShown(latest.current); }, wait);
    }
  }, [text, live]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const display = live ? shown : text;
  const html = useMemo(() => {
    const t0 = performance.now();
    const h = renderMarkdown(display);
    cost.current = performance.now() - t0;
    return h;
  }, [display]);
  const box = useRef<HTMLDivElement>(null);
  // ```plot blocks → live graphs (after the text settles: while a reply streams in, the block keeps changing)
  useEffect(() => {
    const root = box.current;
    if (!root || !html.includes("plot-block")) return;
    const handles: PlotHandle[] = [];
    const t = window.setTimeout(() => {
      void import("../plot/mount").then(({ mountPlot }) => {
        for (const el of root.querySelectorAll<HTMLElement>(".plot-block[data-plot]")) {
          if (el.dataset.mounted) continue;
          el.dataset.mounted = "1";
          try { handles.push(mountPlot(el, decodeURIComponent(el.dataset.plot || ""))); } catch (e) { console.error("plot failed", e); }
        }
      });
    }, 250);
    return () => { clearTimeout(t); handles.forEach((h) => h.destroy()); };
  }, [html]);
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
  return <div className="md" ref={box} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
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
