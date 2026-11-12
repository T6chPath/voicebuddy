import { useState } from "react";
import type { Message } from "../api/types";
import { bookMarkdown, continueRequest, type Book } from "../lib/book";
import { makePdf, openPdf, sharePdf, type PdfResult } from "../pdf/pdf";
import { Icon } from "./Icon";

/** Scrolls the conversation to a chapter's heading. */
function goTo(n: number) {
  const h = [...document.querySelectorAll<HTMLElement>(".msg-book .msg-body h2")].find((x) => new RegExp(`^Chapter\\s+${n}\\b`, "i").test(x.textContent || ""));
  h?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Under the latest page of a book: how far you are, the contents, the next chapter and the whole book as a PDF. */
export function BookBar({ book, messages, busy, onNext }: { book: Book; messages: Message[]; busy: boolean; onNext: (text: string) => void }) {
  const [pdf, setPdf] = useState<{ status: "making" | "saved" | "error"; result?: PdfResult; error?: string } | null>(null);
  const total = book.chapters.length;
  const done = book.written.length;
  const pct = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const finished = total > 0 && !book.next;

  async function save() {
    setPdf({ status: "making" });
    try { setPdf({ status: "saved", result: await makePdf(book.title, bookMarkdown(messages, book)) }); }
    catch (e) { setPdf({ status: "error", error: (e as Error).message || "Couldn't make the PDF." }); }
  }

  return (
    <section className="book-bar" aria-label={`Book: ${book.title}`}>
      <div className="book-head">
        <span className="book-ico" aria-hidden="true"><Icon name="book" size={20} /></span>
        <div className="book-meta">
          <strong>{book.title}</strong>
          <span className="muted small-text">
            {finished ? `All ${total} chapters written — book complete` : total ? `Chapter ${Math.max(...book.written, 0)} of ${total} written` : `${done} chapter${done === 1 ? "" : "s"} written`}
          </span>
        </div>
      </div>
      {total > 0 && (
        <div className="book-progress" role="progressbar" aria-label="Chapters written" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
          <i style={{ width: `${pct}%` }} />
        </div>
      )}
      {total > 0 && (
        <details className="book-toc">
          <summary>Contents</summary>
          <ol>
            {book.chapters.map((t, i) => {
              const n = i + 1, written = book.written.includes(n), next = book.next?.n === n;
              return (
                <li key={n} className={written ? "done" : next ? "next" : ""}>
                  {written ? <button type="button" onClick={() => goTo(n)}><Icon name="check" size={14} /><span>{n}. {t}</span></button>
                    : <span className="toc-later">{n}. {t}{next ? <em> — next</em> : null}</span>}
                </li>
              );
            })}
          </ol>
        </details>
      )}
      <div className="book-actions">
        {book.next && (
          <button type="button" className="btn primary" disabled={busy} onClick={() => onNext(continueRequest(book.next!.n, book.next!.title))}>
            <span>Next: Chapter {book.next.n}{book.next.title ? ` — ${book.next.title}` : ""}</span>
          </button>
        )}
        <button type="button" className={`btn${finished ? " primary" : ""}`} disabled={busy || pdf?.status === "making"} onClick={() => void save()}>
          <Icon name="pdf" size={16} /> {pdf?.status === "making" ? "Making the PDF…" : "Save book as PDF"}
        </button>
      </div>
      {pdf?.status === "saved" && pdf.result && (
        <p className="book-pdf" role="status">
          <Icon name="check" size={16} />
          <span>{pdf.result.kind === "file" ? <>Saved <strong>{pdf.result.name}</strong> to {pdf.result.where}</> : pdf.result.kind === "download" ? `${pdf.result.name} downloaded` : "Opened the Save as PDF screen"}</span>
          {pdf.result.kind === "file" && <>
            <button type="button" className="btn small" onClick={() => openPdf(pdf.result!.id)}>Open</button>
            <button type="button" className="btn small" onClick={() => sharePdf(pdf.result!.id)}>Share</button>
          </>}
        </p>
      )}
      {pdf?.status === "error" && <p className="form-error" role="alert">{pdf.error}</p>}
    </section>
  );
}
