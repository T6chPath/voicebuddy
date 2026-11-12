import { useState } from "react";
import type { Message } from "../api/types";
import { bookMarkdown, chapterDone, continueRequest, plannedTopics, topicAt, topicRequest, type Book, type NextTopic } from "../lib/book";
import { makePdf, openPdf, sharePdf, type PdfResult } from "../pdf/pdf";
import { Icon } from "./Icon";

/** Scrolls the conversation to a page heading: a chapter ("Chapter 3") or a topic ("2.4") — the first page that has it. */
function goTo(selector: string) {
  document.querySelector<HTMLElement>(`.msg-book .msg-body ${selector}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
const goToChapter = (n: number) => goTo(`h2[data-chapter="${n}"]`);
const goToTopic = (id: string) => goTo(`h3[data-topic="${id}"]`);

const topicLabel = (t: NextTopic) => `${t.start ? `Chapter ${t.n} · ` : ""}${t.n}.${t.m}${t.title ? ` — ${t.title}` : ""}`;

/** How far the reader is, in words. */
function progress(book: Book): { text: string; done: number; total: number; label: string } {
  const chapters = book.chapters.length;
  if (book.deep) {
    const planned = plannedTopics(book);
    const done = book.done.length;
    const of = chapters ? ` · Chapter ${Math.min(book.current || 1, chapters)} of ${chapters}` : "";
    if (book.complete) return { text: `All ${planned || done} topics explained — book complete`, done: planned || done, total: planned || done, label: "Topics explained" };
    if (planned) return { text: `${done} of ${planned} topics explained${of}`, done, total: planned, label: "Topics explained" };
    const finished = book.chapters.filter((_, i) => chapterDone(book, i + 1)).length;
    return { text: `${done} topic${done === 1 ? "" : "s"} explained${of}`, done: finished, total: chapters, label: "Chapters finished" };
  }
  const done = book.written.length;
  if (book.complete) return { text: `All ${chapters} chapters written — book complete`, done, total: chapters, label: "Chapters written" };
  return { text: chapters ? `Chapter ${Math.max(...book.written, 0)} of ${chapters} written` : `${done} chapter${done === 1 ? "" : "s"} written`, done, total: chapters, label: "Chapters written" };
}

/** Under the latest page of a book: how far you are, the contents, the next page and the whole book as a PDF.
 *  `compact` — after a question asked between pages: just the way back into the book. */
export function BookBar({ book, messages, busy, onNext, compact = false }: { book: Book; messages: Message[]; busy: boolean; onNext: (text: string) => void; compact?: boolean }) {
  const [pdf, setPdf] = useState<{ status: "making" | "saved" | "error"; result?: PdfResult; error?: string } | null>(null);
  const p = progress(book);
  const pct = p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;

  async function save() {
    setPdf({ status: "making" });
    try { setPdf({ status: "saved", result: await makePdf(book.title, bookMarkdown(messages, book), { book: true }) }); }
    catch (e) { setPdf({ status: "error", error: (e as Error).message || "Couldn't make the PDF." }); }
  }

  const next = book.deep
    ? book.nextTopic && (
      <button type="button" className="btn primary" disabled={busy} onClick={() => onNext(topicRequest(book.nextTopic!))}>
        <span>Next: {topicLabel(book.nextTopic)}</span>
      </button>)
    : book.next && (
      <button type="button" className="btn primary" disabled={busy} onClick={() => onNext(continueRequest(book.next!.n, book.next!.title))}>
        <span>Next: Chapter {book.next.n}{book.next.title ? ` — ${book.next.title}` : ""}</span>
      </button>);

  const head = (
    <div className="book-head">
      <span className="book-ico" aria-hidden="true"><Icon name="book" size={compact ? 17 : 20} /></span>
      <div className="book-meta">
        <strong>{book.title}</strong>
        <span className="muted small-text">{compact ? `Back to your book — ${p.text.charAt(0).toLowerCase()}${p.text.slice(1)}` : p.text}</span>
      </div>
    </div>
  );

  if (compact) return (
    <section className="book-bar compact" aria-label={`Book: ${book.title}`}>
      {head}
      {next && <div className="book-actions">{next}</div>}
    </section>
  );

  return (
    <section className={`book-bar${book.deep ? " deep" : ""}`} aria-label={`Book: ${book.title}`}>
      {head}
      {p.total > 0 && (
        <div className="book-progress" role="progressbar" aria-label={p.label} aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done}>
          <i style={{ width: `${pct}%` }} />
        </div>
      )}
      {book.chapters.length > 0 && (book.deep ? <DeepContents book={book} busy={busy} onNext={onNext} /> : (
        <details className="book-toc">
          <summary>Contents</summary>
          <ol>
            {book.chapters.map((t, i) => {
              const n = i + 1, written = book.written.includes(n), next = book.next?.n === n;
              return (
                <li key={n} className={written ? "done" : next ? "next" : ""}>
                  {written ? <button type="button" onClick={() => goToChapter(n)}><Icon name="check" size={14} /><span>{n}. {t}</span></button>
                    : <span className="toc-later">{n}. {t}{next ? <em> — next</em> : null}</span>}
                </li>
              );
            })}
          </ol>
        </details>
      ))}
      <div className="book-actions">
        {next}
        <button type="button" className={`btn${book.complete ? " primary" : ""}`} disabled={busy || pdf?.status === "making"} onClick={() => void save()}>
          <Icon name="pdf" size={16} /> {pdf?.status === "making" ? "Making the PDF…" : "Save book as PDF"}
        </button>
      </div>
      {!book.complete && <p className="book-tip muted small-text">Stuck on something? Ask about it in the message box, then tap Next to carry on.</p>}
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

/** An in-depth book's contents: each chapter with its topics. Explained topics take you to their page; any other
 *  topic can be explained now, out of order. */
function DeepContents({ book, busy, onNext }: { book: Book; busy: boolean; onNext: (text: string) => void }) {
  return (
    <details className="book-toc deep">
      <summary>Contents</summary>
      <ol>
        {book.chapters.map((t, i) => {
          const n = i + 1, topics = book.topics[i] || [], finished = chapterDone(book, n);
          return (
            <li key={n} className={`toc-chapter${finished ? " done" : ""}`}>
              {book.written.includes(n)
                ? <button type="button" className="toc-ch" onClick={() => goToChapter(n)}>{finished && <Icon name="check" size={14} />}<span>{n}. {t}</span></button>
                : <span className="toc-ch">{n}. {t}</span>}
              {topics.length > 0 && (
                <ol>
                  {topics.map((tt, j) => {
                    const id = `${n}.${j + 1}`, done = book.done.includes(id), next = book.nextTopic?.n === n && book.nextTopic.m === j + 1;
                    return (
                      <li key={id} className={done ? "done" : next ? "next" : ""}>
                        {done
                          ? <button type="button" aria-label={`Go to ${id} ${tt}`} onClick={() => goToTopic(id)}><Icon name="check" size={14} /><span>{id} {tt}</span></button>
                          : <button type="button" className="toc-explain" aria-label={`Explain ${id} ${tt}${next ? " (next)" : ""}`} disabled={busy}
                                    onClick={() => onNext(topicRequest(topicAt(book, n, j + 1)))}>
                              <span className="toc-id">{id}</span><span>{tt}</span><em>{next ? "Next" : "Explain"}</em>
                            </button>}
                      </li>
                    );
                  })}
                </ol>
              )}
            </li>
          );
        })}
      </ol>
    </details>
  );
}
