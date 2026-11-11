import { Eye } from "./Brand";
import { memo, useState } from "react";
import type { Attachment, ImageOp, Message, ModelInfo } from "../api/types";
import { fileSize, timeLabel } from "../lib/format";
import { Icon } from "./Icon";
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
        <ul className="att-list" aria-label="Attachments">
          {m.attachments.filter((a) => !(a.kind === "image" && fileHref(a))).map((a) => {
            const href = fileHref(a);
            const inner = <><Icon name="file" size={14} /> {a.name} <span className="muted">{fileSize(a.size)}</span></>;
            return <li key={a.id}>{href ? <a className="chip" href={href} target="_blank" rel="noopener">{inner}</a> : <span className="chip">{inner}</span>}</li>;
          })}
        </ul>
      )}
      <div className="msg-body">
        {m.role === "user" ? <p className="plain">{m.content}</p>
          : m.content ? <Markdown text={m.content} />
          : streaming && !m.tool ? <span className="typing" role="img" aria-label="Assistant is typing"><i /><i /><i /></span> : null}
        {streaming && m.content && <span className="cursor" aria-hidden="true" />}
      </div>
      {m.role === "assistant" && <NowSpeaking id={m.id} />}
      {m.role === "assistant" && streaming && request && wantsPdf(request) && <PdfPending text={m.content} request={request} />}
      {m.role === "assistant" && !streaming && m.content && <PdfCard id={m.id} text={m.content} request={request} />}
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
