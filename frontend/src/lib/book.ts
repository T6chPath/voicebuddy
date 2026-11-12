/** "Learn as a book": a topic taught in depth, chapter by chapter. The first reply is the book's title, its contents and
 * Chapter 1; each "Next chapter" asks for the next one. These helpers find the book in a conversation. */
import type { Message } from "../api/types";

export const BOOK_PREFIX = "Teach me as a book: ";
export const CONTINUE_PREFIX = "Continue the book: ";

export const isBookRequest = (t: string) => t.startsWith(BOOK_PREFIX);
export const isBookContinue = (t: string) => t.startsWith(CONTINUE_PREFIX);

export function bookRequest(topic: string): string { return BOOK_PREFIX + topic.trim(); }
export function continueRequest(n: number, title: string): string {
  return `${CONTINUE_PREFIX}write Chapter ${n}${title ? ` — ${title}` : ""}`;
}

const plain = (s: string) => s.replace(/\*\*|__|`/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim();

/** The book's title and planned chapters, from its first reply ("# Title" … "## Contents" + a numbered list). */
export function parseContents(md: string): { title: string; chapters: string[] } {
  const title = plain(md.match(/^#\s+(.+)$/m)?.[1] || "");
  const block = md.match(/^##\s+(?:Contents|Table of contents)\s*$([\s\S]*?)(?=^##\s|$(?![\s\S]))/im)?.[1] || "";
  const chapters: string[] = [];
  for (const m of block.matchAll(/^\s*(\d+)[.)]\s+(.+)$/gm)) {
    const t = plain(m[2]).replace(/^Chapter\s+\d+\s*[:.—-]\s*/i, "").split(/\s+[—–-]\s+/)[0].replace(/[.:]$/, "").trim();
    if (t) chapters[+m[1] - 1] = t;
  }
  return { title, chapters: chapters.filter(Boolean) };
}

/** Chapter numbers written in a reply ("## Chapter 3: …"). */
export function chaptersIn(md: string): number[] {
  return [...md.matchAll(/^##\s+Chapter\s+(\d+)\b/gim)].map((m) => +m[1]);
}

export interface Book {
  title: string;
  chapters: string[];          // planned chapter titles (may be empty if the AI gave none)
  written: number[];           // chapter numbers written so far, in order
  replies: string[];           // ids of the book's replies, in order
  next: { n: number; title: string } | null;
}

/** The latest book in this conversation, or null. A book's replies are the answers to its request and to each
 *  "Continue the book" message after it. */
export function findBook(messages: Message[]): Book | null {
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user" && isBookRequest(messages[i].content)) { start = i; break; }
  if (start < 0) return null;
  const replies: Message[] = [];
  for (let i = start; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (i !== start && !isBookContinue(m.content)) break;            // the user moved on to something else
    const a = messages[i + 1];
    if (a?.role === "assistant" && a.content) replies.push(a);
  }
  if (!replies.length) return null;
  const { title, chapters } = parseContents(replies[0].content);
  const written: number[] = [];
  for (const r of replies) for (const n of chaptersIn(r.content)) if (!written.includes(n)) written.push(n);
  const last = written.length ? Math.max(...written) : 0;
  const total = chapters.length;
  const next = total ? (last < total ? { n: last + 1, title: chapters[last] || "" } : null) : { n: last + 1, title: "" };
  return { title: title || "Your book", chapters, written, replies: replies.map((r) => r.id), next };
}

/** The whole book as one Markdown document (for the PDF). */
export function bookMarkdown(messages: Message[], book: Book): string {
  const byId = new Map(messages.map((m) => [m.id, m.content]));
  return book.replies.map((id) => (byId.get(id) || "").trim()).join("\n\n");
}

/** Which replies in the conversation are book pages (for the reading style). */
export function bookReplyIds(messages: Message[]): Set<string> {
  const ids = new Set<string>();
  for (let i = 0; i < messages.length - 1; i++) {
    const m = messages[i];
    if (m.role === "user" && (isBookRequest(m.content) || isBookContinue(m.content)) && messages[i + 1].role === "assistant") ids.add(messages[i + 1].id);
  }
  return ids;
}
