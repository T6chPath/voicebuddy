import { useEffect, useId, useState } from "react";
import { api, LOCAL_MODE } from "../api/client";
import { fileSize } from "../lib/format";
import { Modal } from "./Dialogs";
import { fileType } from "./FileCard";
import { Icon } from "./Icon";

export interface PreviewTarget { id: string; name: string; mime: string; kind: string; size: number; href?: string | null }

/** Tapping a sent file: what the AI read from it (the text the app took out of the document), like ChatGPT's preview. */
export function FilePreview({ f, onClose }: { f: PreviewTarget; onClose: () => void }) {
  const titleId = useId();
  const [text, setText] = useState<string | null | undefined>(undefined);
  const t = fileType(f.name, f.mime, f.kind);
  useEffect(() => {
    let live = true;
    api.fileText(f.id).then((x) => { if (live) setText(x); }, () => { if (live) setText(null); });
    return () => { live = false; };
  }, [f.id]);
  const shown = text ? text.slice(0, 40_000) : "";
  return (
    <Modal open onClose={onClose} title={f.name} labelledBy={titleId}>
      <div className="file-preview">
        <p className="fp-meta"><span className={`fc-tile tone-${t.tone}`} aria-hidden="true"><Icon name={t.icon} size={16} /></span>
          <span>{t.label} · {fileSize(f.size)}</span></p>
        {text === undefined ? <p className="muted"><span className="spinner" /> Opening…</p>
          : text ? <>
              <p className="muted small-text">{LOCAL_MODE ? "What the AI reads from this file:" : "Contents:"}</p>
              <pre className="fp-text" tabIndex={0}>{shown}{text.length > shown.length ? "\n\n… (more)" : ""}</pre>
            </>
          : <p className="muted">There's no text to show for this file.</p>}
        <div className="modal-actions">
          {f.href && !LOCAL_MODE && <a className="btn" href={f.href} target="_blank" rel="noopener"><Icon name="download" size={16} /> Download</a>}
          <button type="button" className="btn primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </Modal>
  );
}
