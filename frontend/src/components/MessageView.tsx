import { Eye } from "./Brand";
import { memo, useMemo, useState } from "react";
import type { Attachment, ImageOp, Message, ModelInfo } from "../api/types";
import { timeLabel } from "../lib/format";
import { Icon } from "./Icon";
import { FileCard } from "./FileCard";
import { api } from "../api/client";
import { extractFiles, projectName, webAppPage, zip } from "../lib/project";
import { saveDataUrl } from "../lib/save";
import { ImageGallery, ToolProgress, type ImageAction } from "./ImageViews";
import { copyText, Markdown } from "./Markdown";
import { PdfButton, PdfCard, PdfPending } from "./PdfViews";
import { wantsPdf } from "../pdf/pdf";
import { NowSpeaking, SpeakControls } from "./SpeechViews";

interface Props {
  m: Message;
  isLast: boolean;
  busy: boolean;
  models: ModelInfo[];
  showTime: boolean;
  onRegenerate: () => void;
  /** link target for an attachment chip; null = not downloadable (standalone app keeps files only in the prompt) */
  fileHref?: (a: Attachment, download?: boolean) => string | null;
  onImageAction?: (action: ImageAction, a: Attachment) => void;
  imageActions?: boolean;
  numberOf?: (id: string) => number | undefined;
  /** the user message this reply answers (titles PDFs) */
  request?: string;
  /** what the image engines can do */
  imageOps?: ImageOp[];
}

const serverHref = (a: Attachment, download = false) => `/api/files/${a.id}${download ? "?download=1" : ""}`;
const noNumber = () => undefined;

/** An answer with a multi-file project: the files at a glance, a .zip of all of them, and "Make app" for web projects. */
function ProjectBar({ text }: { text: string }) {
  const files = useMemo(() => extractFiles(text), [text]);
  const [msg, setMsg] = useState("");
  if (files.length < 2) return null;
  const name = projectName(text, files);
  const page = webAppPage(files);
  async function download() {
    const bytes = zip(files, name);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    try { setMsg(await saveDataUrl("data:application/zip;base64," + btoa(bin), `${name}.zip`)); }
    catch (e) { setMsg((e as Error).message || "Couldn't save the project."); }
  }
  return (
    <section className="project-bar" aria-label={`Project ${name}`}>
      <div className="project-head">
        <Icon name="layers" size={18} />
        <div className="project-info"><strong>{name}</strong><span className="muted small-text">{files.length} files</span></div>
      </div>
      <ul className="project-files">{files.map((f) => <li key={f.path}><code>{f.path}</code></li>)}</ul>
      <div className="project-actions">
        <button type="button" className="btn small primary" onClick={download}><Icon name="download" size={16} /> Download project (.zip)</button>
        {page && <button type="button" className="btn small" onClick={() => window.dispatchEvent(new CustomEvent("zc-make-app", { detail: { html: page } }))}>
          <Icon name="phone" size={16} /> Make app</button>}
        {page && <button type="button" className="btn small" onClick={() => window.dispatchEvent(new CustomEvent("zc-view-site", { detail: { html: page } }))}>
          <Icon name="globe" size={16} /> View site</button>}
        {msg && <span className="muted small-text" role="status">{msg}</span>}
      </div>
    </section>
  );
}

async function makeAppFromFile(id: string, ev = "zc-make-app") {
  const html = await api.fileText(id);
  if (html) window.dispatchEvent(new CustomEvent(ev, { detail: { html } }));
}

export const MessageView = memo(function MessageView({ m, isLast, busy, models, showTime, onRegenerate, fileHref = serverHref,
  onImageAction, imageActions = false, numberOf = noNumber, request, imageOps }: Props) {
  const [copied, setCopied] = useState(false);
  const streaming = m.status === "streaming";
  const label = m.role === "user" ? "You" : models.find((x) => x.id === m.model)?.label || "Assistant";
  return (
    <article className={`msg msg-${m.role}`} aria-label={`${m.role === "user" ? "Your message" : "Assistant reply"}`} aria-busy={streaming}>
      <header className="msg-head">
        {m.role === "assistant" && <Eye />}
        <span className="who">{label}</span>
        {showTime && <time dateTime={new Date(m.created_at * 1000).toISOString()}>{timeLabel(m.created_at)}</time>}
      </header>
      {(() => {
        const imgs = m.attachments.filter((a) => a.kind === "image" && fileHref(a));
        return imgs.length > 0 && m.role === "user" ? (
          <ImageGallery images={imgs} href={fileHref} numberOf={numberOf} onAction={onImageAction} actions={imageActions} ops={imageOps} />
        ) : null;
      })()}
      {m.attachments.some((a) => !(a.kind === "image" && fileHref(a))) && (
        <ul className="att-list fc-row" aria-label="Attachments">
          {m.attachments.filter((a) => !(a.kind === "image" && fileHref(a))).map((a) => {
            const page = /\.x?html?$/i.test(a.name);
            return <li key={a.id} className="chip fc-li">
              <FileCard name={a.name} mime={a.mime} kind={a.kind} size={a.size}
                        onOpen={() => window.dispatchEvent(new CustomEvent("zc-preview-file", { detail: { id: a.id, name: a.name, mime: a.mime, kind: a.kind, size: a.size, href: fileHref(a) } }))} />
              {page && <button type="button" className="chip chip-action" onClick={() => void makeAppFromFile(a.id)} aria-label={`Make an Android app from ${a.name}`}>
                <Icon name="phone" size={14} /> Make app</button>}
              {page && <button type="button" className="chip chip-action" onClick={() => void makeAppFromFile(a.id, "zc-view-site")} aria-label={`View ${a.name} as a website`}>
                <Icon name="globe" size={14} /> View site</button>}</li>;
          })}
        </ul>
      )}
      <div className="msg-body">
        {m.role === "user" ? <p className="plain">{m.content}</p>
          : m.content ? <Markdown text={m.content} live={streaming} />
          : streaming && !m.tool ? <span className="typing" role="img" aria-label="Assistant is typing"><i /><i /><i /></span> : null}
        {streaming && m.content && <span className="cursor" aria-hidden="true" />}
      </div>
      {m.role === "assistant" && <NowSpeaking id={m.id} />}
      {m.role === "assistant" && streaming && request && wantsPdf(request) && <PdfPending text={m.content} request={request} />}
      {m.role === "assistant" && !streaming && m.content && <PdfCard id={m.id} text={m.content} request={request} />}
      {m.role === "assistant" && !streaming && m.content.includes("```") && <ProjectBar text={m.content} />}
      {m.tool && m.tool.status === "running" && <ToolProgress t={m.tool} />}
      {m.role === "assistant" && m.attachments.some((a) => a.kind === "image" && fileHref(a)) && (
        <ImageGallery images={m.attachments.filter((a) => a.kind === "image" && fileHref(a))} href={fileHref} numberOf={numberOf} ops={imageOps}
                      onAction={onImageAction} actions={imageActions && !streaming} />
      )}
      {m.status === "error" && (
        <div className="msg-error" role="alert">
          <Icon name="alert" size={16} /> <span>{m.error || "Something went wrong."}</span>
          {isLast && !busy && <button type="button" className="btn small" onClick={onRegenerate}>Retry</button>}
        </div>
      )}
      {m.status === "stopped" && <p className="muted small-text">Stopped</p>}
      {m.role === "assistant" && !streaming && m.content && (
        <div className="msg-actions">
          <button type="button" className="icon-btn" aria-label={copied ? "Copied" : "Copy reply"} title="Copy"
                  onClick={() => copyText(m.content).then((ok) => { setCopied(ok); window.setTimeout(() => setCopied(false), 1500); })}>
            <Icon name={copied ? "check" : "copy"} size={16} />
          </button>
          <SpeakControls id={m.id} text={m.content} />
          <PdfButton id={m.id} text={m.content} request={request} />
          {isLast && !busy && (
            <button type="button" className="icon-btn" aria-label="Regenerate reply" title="Regenerate" onClick={onRegenerate}>
              <Icon name="refresh" size={16} />
            </button>
          )}
        </div>
      )}
    </article>
  );
});
