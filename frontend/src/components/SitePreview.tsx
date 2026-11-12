import { useEffect, useId, useRef, useState } from "react";
import { appName, asPage } from "../apk/apk";
import { Icon } from "./Icon";

/** Pages run in a sandbox with no access to zenvqo, where localStorage throws: give them a stand-in so saved data works. */
const STORAGE = "<script>(function(){function mk(){var d={};return{getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null}," +
  "setItem:function(k,v){d[String(k)]=String(v)},removeItem:function(k){delete d[String(k)]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null}," +
  "get length(){return Object.keys(d).length}}}['localStorage','sessionStorage'].forEach(function(n){try{window[n].getItem('x')}catch(e){" +
  "try{Object.defineProperty(window,n,{value:mk(),configurable:true})}catch(_){}}})})()</script>";

/** The page as the sandbox should get it: a complete document, with the storage stand-in first in <head>. */
export function sitePage(html: string): string {
  const page = asPage(html, appName(html));
  if (/<head[^>]*>/i.test(page)) return page.replace(/<head[^>]*>/i, (h) => h + STORAGE);
  if (/<html[^>]*>/i.test(page)) return page.replace(/<html[^>]*>/i, (h) => h + STORAGE);
  return STORAGE + page;
}

/** "View site": the web page the AI wrote (or a file the user attached), running full-screen like a real website. */
export function SitePreview({ html, onClose }: { html: string; onClose: () => void }) {
  const titleId = useId();
  const ref = useRef<HTMLDialogElement>(null);
  const [run, setRun] = useState(0);                       // bumping it reloads the page
  const [wide, setWide] = useState(false);                 // desktop-width view on a phone
  const name = appName(html);
  const page = sitePage(html);
  const closed = useRef(false);
  const frame = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {                                       // desktop view: a 1280px-wide page shrunk to fit the screen
    const el = frame.current;
    if (!el || !wide) { setScale(1); return; }
    const fit = () => setScale(Math.min(1, el.clientWidth / 1280));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [wide]);
  const close = () => { if (closed.current) return; closed.current = true; onClose(); };

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    // the phone's Back button closes the preview instead of leaving the chat
    if (!history.state?.zvSite) history.pushState({ ...(history.state || {}), zvSite: true }, "");
    const onPop = () => { if (!history.state?.zvSite) close(); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const shut = () => { if (history.state?.zvSite) history.back(); else close(); };

  return (
    <dialog ref={ref} className="site-preview" aria-labelledby={titleId} onCancel={(e) => { e.preventDefault(); shut(); }}>
      <header className="site-bar">
        <button type="button" className="icon-btn" aria-label="Close website" onClick={shut}><Icon name="close" /></button>
        <div className="site-title">
          <Icon name="globe" size={16} />
          <h2 id={titleId}>{name}</h2>
        </div>
        <button type="button" className={`icon-btn${wide ? " on" : ""}`} aria-pressed={wide} aria-label="Desktop view" title="Desktop view"
                onClick={() => setWide((w) => !w)}><Icon name="monitor" /></button>
        <button type="button" className="icon-btn" aria-label="Reload website" title="Reload" onClick={() => setRun((n) => n + 1)}><Icon name="refresh" /></button>
        <button type="button" className="btn small primary" onClick={() => { const h = html; shut(); window.setTimeout(() => window.dispatchEvent(new CustomEvent("zc-make-app", { detail: { html: h } })), 50); }}>
          <Icon name="phone" size={16} /> Make app</button>
      </header>
      <div ref={frame} className={`site-frame${wide ? " wide" : ""}`}>
        <iframe key={run} style={wide ? { width: 1280, height: `${100 / scale}%`, transform: `scale(${scale})` } : undefined} title={`Website: ${name}`} srcDoc={page}
                sandbox="allow-scripts allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock" />
      </div>
    </dialog>
  );
}
