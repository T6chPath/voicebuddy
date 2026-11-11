import { forwardRef, type ReactNode, useCallback, useEffect, useId, useImperativeHandle, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { api, ApiError, uploadFile } from "../api/client";
import type { UploadedFile } from "../api/types";
import { fileSize, isMac } from "../lib/format";
import { CameraDialog } from "./CameraViews";
import { Icon } from "./Icon";

const MAX_CHARS = 32000;
const MAX_FILES = 5;
const MAX_MB = 50;
const ACCEPT = ".txt,.md,.csv,.tsv,.json,.py,.js,.ts,.tsx,.jsx,.html,.css,.sql,.yaml,.yml,.toml,.xml,.log,.java,.kt,.c,.cpp,.h,.go,.rs,.sh,.pdf,image/png,image/jpeg,image/webp,image/gif";

interface Pending { key: string; file: File; progress: number; uploaded?: UploadedFile; error?: string; abort?: () => void }

export interface MenuItem { key: string; icon: string; label: string; hint?: string; ariaLabel?: string; on?: boolean; disabled?: boolean; onSelect: () => void }

export interface ComposerHandle { focus: () => void; setText: (t: string) => void }

export type Uploader = (file: File, onProgress: (frac: number) => void) => { promise: Promise<UploadedFile>; abort: () => void };

interface Props {
  busy: boolean;
  sendOnEnter: boolean;
  onSend: (text: string, files: UploadedFile[]) => Promise<boolean>;
  onStop: () => void;
  /** defaults to uploading to the zenvqo server; the standalone build reads files locally instead */
  upload?: Uploader;
  discard?: (f: UploadedFile) => void;
  accept?: string;
  placeholder?: string;
  /** extra controls next to the send button */
  tools?: ReactNode;
  /** controls kept outside the "+" menu, next to send (the mic) */
  trailing?: ReactNode;
  /** extra entries in the "+" menu (after Camera and Photos & files) */
  menu?: MenuItem[];
  /** small mode tags next to "+" (e.g. "Image") */
  chips?: ReactNode;
  /** shown above the input (e.g. "Editing image #3") */
  banner?: ReactNode;
  /** popover anchored to the composer */
  popover?: ReactNode;
}

const serverDiscard = (f: UploadedFile) => { api.deleteFile(f.id).catch(() => {}); };

/** What a message with only attachments asks. */
export function defaultQuestion(files: { kind: string }[]): string {
  if (files.length && files.every((f) => f.kind === "image")) return files.length > 1 ? "Explain everything in these images." : "Explain everything in this image.";
  if (files.length && files.every((f) => f.kind === "pdf")) return files.length > 1 ? "Summarise these PDFs." : "Summarise this PDF.";
  return "Explain these files.";
}

function Thumb({ file }: { file: File }) {
  const [url, setUrl] = useState("");
  useEffect(() => { const u = URL.createObjectURL(file); setUrl(u); return () => URL.revokeObjectURL(u); }, [file]);
  return url ? <img className="chip-thumb" src={url} alt="" /> : null;
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { busy, sendOnEnter, onSend, onStop, upload = uploadFile, discard = serverDiscard, accept = ACCEPT, placeholder = "Message zenvqo…",
    tools, trailing, menu = [], chips, banner, popover }, ref) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuId = useId();
  const plus = useRef<HTMLButtonElement>(null);
  const menuEl = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    menuEl.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus();
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menuEl.current?.contains(t) && !plus.current?.contains(t)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [menuOpen]);
  const closeMenu = (refocus = true) => { setMenuOpen(false); if (refocus) plus.current?.focus(); };
  function menuKeys(e: KeyboardEvent<HTMLDivElement>) {
    const items = [...(menuEl.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") || [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === "Home") { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === "End") { e.preventDefault(); items[items.length - 1]?.focus(); }
    else if (e.key === "Tab") setMenuOpen(false);
  }
  const [text, setText] = useState("");
  const [files, setFiles] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const [camera, setCamera] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();

  useImperativeHandle(ref, () => ({ focus: () => ta.current?.focus(), setText: (t) => { setText(t); ta.current?.focus(); } }), []);

  useEffect(() => {                                   // auto-grow up to ~40% of the viewport
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.4) + "px";
  }, [text]);

  const addFiles = useCallback((list: FileList | File[]) => {
    const incoming = Array.from(list);
    setFiles((cur) => {
      const room = MAX_FILES - cur.length;
      const take = incoming.slice(0, Math.max(0, room));
      const rejected = incoming.length - take.length;
      const next = take.map<Pending>((file) => ({ key: `${file.name}-${file.size}-${Math.random()}`, file, progress: 0,
        error: file.size > MAX_MB * 1024 * 1024 ? `Larger than ${MAX_MB} MB` : undefined }));
      if (rejected > 0) next.push({ key: `limit-${Math.random()}`, file: new File([], `${rejected} more file(s)`), progress: 0, error: `Max ${MAX_FILES} files per message` });
      for (const p of next) {
        if (p.error) continue;
        const up = upload(p.file, (fr) => setFiles((xs) => xs.map((x) => (x.key === p.key ? { ...x, progress: fr } : x))));
        p.abort = up.abort;
        up.promise
          .then((u) => setFiles((xs) => xs.map((x) => (x.key === p.key ? { ...x, uploaded: u, progress: 1 } : x))))
          .catch((e) => { if ((e as Error).name !== "AbortError") setFiles((xs) => xs.map((x) => (x.key === p.key ? { ...x, error: e instanceof ApiError || (e instanceof Error && e.message) ? (e as Error).message : "Upload failed" } : x))); });
      }
      return [...cur, ...next];
    });
  }, []);

  function remove(p: Pending) {
    p.abort?.();
    if (p.uploaded) discard(p.uploaded);
    setFiles((xs) => xs.filter((x) => x.key !== p.key));
    ta.current?.focus();
  }

  const uploading = files.some((f) => !f.uploaded && !f.error);
  const hasErrors = files.some((f) => f.error);
  const ready = files.filter((f) => f.uploaded);
  // a photo or PDF can be sent on its own: the question then is "explain this" / "summarise this"
  const canSend = !busy && !uploading && !hasErrors && (text.trim().length > 0 || ready.length > 0) && text.length <= MAX_CHARS;

  async function submit() {
    if (!canSend) return;
    const draft = text, sent = files;
    setText("");                                       // clear right away; the reply streams below
    setFiles([]);
    const up = sent.filter((f) => f.uploaded).map((f) => f.uploaded!);
    const ok = await onSend(draft.trim() || defaultQuestion(up), up);
    if (!ok) {                                         // rejected before streaming (e.g. image + text-only model): restore the draft
      setText((t) => t || draft);
      setFiles((cur) => (cur.length ? cur : sent));
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.nativeEvent.isComposing) return;            // IME (e.g. Hindi transliteration keyboards) — don't send mid-composition
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === "Enter" && ((sendOnEnter && !e.shiftKey && !mod) || (!sendOnEnter && mod))) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape" && busy) {
      e.preventDefault();
      onStop();
    }
  }

  function onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
    if (e.clipboardData.files.length) { e.preventDefault(); addFiles(e.clipboardData.files); }
  }
  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  }

  const over = text.length > MAX_CHARS;
  return (
    <form className={`composer${dragging ? " dragging" : ""}`} onSubmit={(e) => { e.preventDefault(); submit(); }}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}
          aria-label="Message composer">
      {popover}
      {camera && <CameraDialog onPhoto={(f) => addFiles([f])} onClose={() => { setCamera(false); ta.current?.focus(); }} />}
      {banner}
      {files.length > 0 && (
        <ul className="att-list pending" aria-label="Files to send">
          {files.map((p) => (
            <li key={p.key} className={`chip${p.error ? " chip-error" : ""}`}>
              {p.file.type.startsWith("image/") && !p.error ? <Thumb file={p.file} /> : <Icon name="file" size={14} />}
              <span className="chip-name">{p.file.name}</span>
              {p.error ? <span className="chip-status" role="alert">{p.error}</span>
                : p.uploaded ? <span className="muted">{fileSize(p.uploaded.size)}{p.uploaded.truncated ? " · truncated" : ""}</span>
                : <progress max={1} value={p.progress} aria-label={`Uploading ${p.file.name}`} />}
              <button type="button" className="icon-btn small" aria-label={`Remove ${p.file.name}`} onClick={() => remove(p)}>
                <Icon name="close" size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="composer-text">
        <label htmlFor="composer-input" className="sr-only">Message</label>
        <textarea id="composer-input" ref={ta} rows={1} value={text} placeholder={files.length ? "Ask about it — or just send" : placeholder} onChange={(e) => setText(e.target.value)}
                  onKeyDown={onKeyDown} onPaste={onPaste} aria-describedby={hintId} aria-invalid={over} enterKeyHint={sendOnEnter ? "send" : "enter"} />
      </div>
      <div className="composer-tools">
        <div className="plus-wrap">
          <button type="button" ref={plus} className={`plus-btn${menuOpen ? " open" : ""}`} aria-label="Add photos, files and more" title="Add"
                  aria-haspopup="menu" aria-expanded={menuOpen} aria-controls={menuId} onClick={() => setMenuOpen((x) => !x)}>
            <Icon name="plus" size={20} />
          </button>
          <div id={menuId} ref={menuEl} role="menu" aria-label="Add to your message" className="plus-menu" hidden={!menuOpen} onKeyDown={menuKeys}>
            {[
              { key: "camera", icon: "camera", label: "Camera", hint: "Take a photo", ariaLabel: "Take a photo", disabled: files.length >= MAX_FILES, onSelect: () => setCamera(true) },
              { key: "files", icon: "clip", label: "Photos & files", hint: "Images, PDFs, code, text", ariaLabel: "Attach files", disabled: files.length >= MAX_FILES,
                onSelect: () => input.current?.click() },
              ...menu,
            ].map((it) => (
              <button key={it.key} type="button" role="menuitem" className={`plus-item${it.on ? " on" : ""}`} aria-label={it.ariaLabel}
                      disabled={it.disabled} onClick={() => { closeMenu(false); it.onSelect(); }}>
                <span className="pi-ico" aria-hidden="true"><Icon name={it.icon} size={20} /></span>
                <span className="pi-text"><span className="pi-label">{it.label}</span>{it.hint && <span className="pi-hint">{it.hint}</span>}</span>
                {it.on && <Icon name="check" size={16} />}
              </button>
            ))}
          </div>
        </div>
        {chips}
        <input ref={input} type="file" multiple accept={accept} hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
        <span className="spacer" />
        {tools}
        {trailing}
        {busy ? (
          <button type="button" className="send-btn stop" onClick={onStop} aria-label="Stop generating">
            <Icon name="stop" />
          </button>
        ) : (
          <button type="submit" className="send-btn" disabled={!canSend} aria-label={uploading ? "Waiting for uploads" : "Send message"}>
            <Icon name="send" />
          </button>
        )}
      </div>
      <p id={hintId} className={`composer-hint${over ? " over" : ""}`}>
        {over ? `${text.length.toLocaleString()} / ${MAX_CHARS.toLocaleString()} characters — shorten your message`
          : sendOnEnter ? "Enter to send · Shift+Enter for a new line" : `${isMac() ? "⌘" : "Ctrl"}+Enter to send`}
        {busy && " · Esc to stop"}
      </p>
    </form>
  );
});
