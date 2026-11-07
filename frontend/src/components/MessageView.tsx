import { memo, useState } from "react";
import type { Attachment, Message, ModelInfo } from "../api/types";
import { fileSize, timeLabel } from "../lib/format";
import { Icon } from "./Icon";
import { copyText, Markdown } from "./Markdown";

interface Props {
  m: Message;
  isLast: boolean;
  busy: boolean;
  models: ModelInfo[];
  showTime: boolean;
  onRegenerate: () => void;
  /** link target for an attachment chip; null = not downloadable (standalone app keeps files only in the prompt) */
  fileHref?: (a: Attachment) => string | null;
}

const serverHref = (a: Attachment) => `/api/files/${a.id}`;

export const MessageView = memo(function MessageView({ m, isLast, busy, models, showTime, onRegenerate, fileHref = serverHref }: Props) {
  const [copied, setCopied] = useState(false);
  const streaming = m.status === "streaming";
  const label = m.role === "user" ? "You" : models.find((x) => x.id === m.model)?.label || "Assistant";
  return (
    <article className={`msg msg-${m.role}`} aria-label={`${m.role === "user" ? "Your message" : "Assistant reply"}`} aria-busy={streaming}>
      <header className="msg-head">
        <span className="who">{label}</span>
        {showTime && <time dateTime={new Date(m.created_at * 1000).toISOString()}>{timeLabel(m.created_at)}</time>}
      </header>
      {m.attachments.length > 0 && (
        <ul className="att-list" aria-label="Attachments">
          {m.attachments.map((a) => {
            const href = fileHref(a);
            const inner = <><Icon name="file" size={14} /> {a.name} <span className="muted">{fileSize(a.size)}</span></>;
            return <li key={a.id}>{href ? <a className="chip" href={href} target="_blank" rel="noopener">{inner}</a> : <span className="chip">{inner}</span>}</li>;
          })}
        </ul>
      )}
      <div className="msg-body">
        {m.role === "user" ? <p className="plain">{m.content}</p>
          : m.content ? <Markdown text={m.content} />
          : streaming ? <span className="typing" role="img" aria-label="Assistant is typing"><i /><i /><i /></span> : null}
        {streaming && m.content && <span className="cursor" aria-hidden="true" />}
      </div>
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
