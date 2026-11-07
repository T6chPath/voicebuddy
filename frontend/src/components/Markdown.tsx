import { memo, useMemo, type MouseEvent } from "react";
import { renderMarkdown } from "../lib/markdown";

/** Renders sanitised Markdown. Code-block "Copy" buttons are handled by event delegation. */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
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
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-copy]");
    if (!btn) return;
    const code = btn.closest(".code-block")?.querySelector("code")?.textContent ?? "";
    copyText(code).then((ok) => {
      btn.textContent = ok ? "Copied" : "Copy failed";
      window.setTimeout(() => { btn.textContent = "Copy"; }, 1500);
    });
  }
  return <div className="md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
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
