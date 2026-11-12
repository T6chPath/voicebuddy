import { useEffect, useState } from "react";
import { fileSize } from "../lib/format";
import { Icon } from "./Icon";

/** What kind of file this is, for its card (like ChatGPT: a coloured tile, the name, and the type underneath). */
export function fileType(name: string, mime = "", kind = ""): { label: string; icon: string; tone: string } {
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
  if (kind === "pdf" || ext === "pdf") return { label: "PDF", icon: "pdf", tone: "pdf" };
  if (/^(docx?|odt|rtf|pages|wpd)$/.test(ext)) return { label: "Document", icon: "doc", tone: "doc" };
  if (/^(xlsx?|xlsm|ods|csv|tsv|numbers)$/.test(ext)) return { label: "Spreadsheet", icon: "table", tone: "sheet" };
  if (/^(pptx?|odp|key)$/.test(ext)) return { label: "Presentation", icon: "slides", tone: "slides" };
  if (/^(zip|rar|7z|tar|gz|tgz|bz2|xz|jar|apk)$/.test(ext)) return { label: ext === "apk" ? "Android app" : "Archive", icon: "archive", tone: "archive" };
  if (mime.startsWith("video/") || /^(mp4|m4v|mov|webm|mkv|3gp|avi|wmv|flv)$/.test(ext)) return { label: "Video", icon: "video", tone: "video" };
  if (mime.startsWith("audio/") || /^(mp3|m4a|wav|ogg|oga|opus|aac|flac|amr|wma)$/.test(ext)) return { label: "Audio", icon: "audio", tone: "audio" };
  if (/^(epub|mobi|azw3?)$/.test(ext)) return { label: "E-book", icon: "book", tone: "book" };
  if (/^(html?|xhtml)$/.test(ext)) return { label: "Web page", icon: "code", tone: "code" };
  if (/^(py|js|mjs|ts|tsx|jsx|java|kt|c|h|cpp|hpp|cs|go|rs|rb|php|swift|dart|sh|sql|css|scss|json|ya?ml|toml|xml|lua|r)$/.test(ext)) return { label: ext.toUpperCase() + " code", icon: "code", tone: "code" };
  if (kind === "image" || mime.startsWith("image/")) return { label: "Image", icon: "image", tone: "image" };
  if (/^(txt|md|markdown|log|srt|vtt)$/.test(ext) || mime.startsWith("text/")) return { label: ext === "md" ? "Markdown" : "Text", icon: "file", tone: "text" };
  return { label: ext ? ext.toUpperCase() + " file" : "File", icon: "file", tone: "text" };
}

function useObjectUrl(file?: File | Blob) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (!file) return;
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return url;
}

interface Props {
  name: string; mime?: string; kind?: string; size?: number;
  /** a picture to show instead of the type tile (a File/Blob, or a URL) */
  picture?: File | Blob | string | null;
  progress?: number | null;        // 0..1 while reading/uploading
  error?: string;
  note?: string;
  onRemove?: () => void;
  onOpen?: () => void;
  /** what tapping the card does, for screen readers (default "Open <name>") */
  openLabel?: string;
  /** show a small crop mark on a photo (tapping it crops) */
  cropBadge?: boolean;
}

/** One attachment: a square photo thumbnail, or a card with a coloured type tile, the name and the type. */
export function FileCard({ name, mime = "", kind = "", size, picture, progress, error, note, onRemove, onOpen, openLabel, cropBadge }: Props) {
  const t = fileType(name, mime, kind);
  const objUrl = useObjectUrl(picture instanceof Blob ? picture : undefined);
  const src = typeof picture === "string" ? picture : objUrl;
  const busy = progress != null && progress < 1 && !error;
  const ring = busy ? <span className="fc-ring" style={{ ["--p" as string]: String(Math.max(0.06, progress || 0)) }} aria-hidden="true" /> : null;
  const remove = onRemove && (
    <button type="button" className="fc-remove" aria-label={`Remove ${name}`} title="Remove" onClick={onRemove}><Icon name="close" size={12} /></button>
  );
  const status = busy ? <progress className="sr-only" max={1} value={progress || 0} aria-label={`Reading ${name}`} /> : null;
  if (src && !error) {
    const Tag = onOpen ? "button" : "div";
    return (
      <div className={`file-card fc-photo${busy ? " busy" : ""}`}>
        <Tag {...(onOpen ? { type: "button" as const, onClick: onOpen, "aria-label": openLabel || `Open ${name}` } : {})} className="fc-thumb">
          <img className="chip-thumb" src={src} alt="" />
          {cropBadge && !busy && <span className="fc-crop" aria-hidden="true"><Icon name="crop" size={12} /></span>}
          <span className="sr-only">{name}</span>
          {ring}
        </Tag>
        {status}
        {remove}
      </div>
    );
  }
  const body = (
    <>
      <span className={`fc-tile tone-${t.tone}`} aria-hidden="true">{busy ? ring : <Icon name={t.icon} size={18} />}</span>
      <span className="fc-text">
        <span className="fc-name" title={name}>{name}</span>
        <span className={`fc-type${error ? " fc-error" : ""}`} role={error ? "alert" : undefined}>
          {error || note || [t.label, size ? fileSize(size) : ""].filter(Boolean).join(" · ")}
        </span>
      </span>
    </>
  );
  return (
    <div className={`file-card${error ? " has-error" : ""}${busy ? " busy" : ""}`}>
      {onOpen ? <button type="button" className="fc-body" onClick={onOpen} aria-label={`Open ${name}`}>{body}</button> : <div className="fc-body">{body}</div>}
      {status}
      {remove}
    </div>
  );
}
