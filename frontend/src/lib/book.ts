/** "Learn as a book": a topic taught in depth as a book, written in one of two ways —
 *  - chapter by chapter: the first reply is the book's title, its contents and Chapter 1; each "Next" asks for the
 *    next chapter;
 *  - every topic in depth: the contents list each chapter's topics (1.1, 1.2 …) and every reply explains ONE topic in
 *    depth; each "Next" asks for the next topic (starting the next chapter, or ending one with its review, on the way).
 * Questions asked between pages don't end the book: its pages are the answers to its request and to each
 * "Continue the book" message, wherever they are in the conversation. These helpers find the book in a conversation. */
import type { Message } from "../api/types";

export const BOOK_PREFIX = "Teach me as a book: ";
export const DEEP_PREFIX = "Teach me as a book, every topic in depth: ";
export const CONTINUE_PREFIX = "Continue the book: ";

export const isDeepRequest = (t: string) => t.startsWith(DEEP_PREFIX);
export const isBookRequest = (t: string) => t.startsWith(BOOK_PREFIX) || isDeepRequest(t);
export const isBookContinue = (t: string) => t.startsWith(CONTINUE_PREFIX);
/** any "Learn as a book" message — these ask for text, never for a picture */
export const isBookMessage = (t: string) => isBookRequest(t) || isBookContinue(t);

export function bookRequest(topic: string, deep = false): string { return (deep ? DEEP_PREFIX : BOOK_PREFIX) + topic.trim(); }
export function continueRequest(n: number, title: string): string {
  return `${CONTINUE_PREFIX}write Chapter ${n}${title ? ` — ${title}` : ""}`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** How a "Learn as a book" message shows in the conversation: a short page-turn label, not the instruction sent to
 *  the AI ("Continue the book: explain topic 1.2 — Static electricity, then end Chapter 1 with its review" → "1.2 Static
 *  electricity"). */
export function bookTurnLabel(t: string): string {
  if (isDeepRequest(t)) return `Book in depth: ${cap(t.slice(DEEP_PREFIX.length).trim())}`;
  if (t.startsWith(BOOK_PREFIX)) return `Book: ${cap(t.slice(BOOK_PREFIX.length).trim())}`;
  if (!isBookContinue(t)) return t;
  const rest = t.slice(CONTINUE_PREFIX.length).trim();
  const ch = rest.match(/^write Chapter (\d+)(?: — (.+))?$/);
  if (ch) return `Chapter ${ch[1]}${ch[2] ? ` — ${ch[2]}` : ""}`;
  const tp = rest.match(/^(?:start Chapter (\d+)(?: — .+?)?, and )?explain topic (\d+\.\d+)(?: — (.+?))?(?:, then end Chapter \d+ with its review)?(?: \(the last topic of the book\))?$/);
  if (tp) return `${tp[1] ? `Chapter ${tp[1]} · ` : ""}${tp[2]}${tp[3] ? ` ${tp[3]}` : ""}`;
  return cap(rest);
}

/** The next topic of an in-depth book — and what else that page has to do. */
export interface NextTopic {
  n: number;               // chapter
  m: number;               // topic in the chapter (n.m)
  title: string;           // the topic's title ("" when the contents didn't list it: the AI picks it)
  chapter: string;         // the chapter's title
  start: boolean;          // the chapter hasn't begun yet: the page opens it
  endsChapter: boolean;    // the chapter's other topics are done: the page ends with the chapter's review
  last: boolean;           // the last topic of the whole book
}

export function topicRequest(t: NextTopic): string {
  const id = `${t.n}.${t.m}`;
  let s = CONTINUE_PREFIX + (t.start ? `start Chapter ${t.n}${t.chapter ? ` — ${t.chapter}` : ""}, and explain topic ${id}` : `explain topic ${id}`);
  if (t.title) s += ` — ${t.title}`;
  if (t.endsChapter) s += `, then end Chapter ${t.n} with its review`;
  if (t.last) s += " (the last topic of the book)";
  return s;
}

const plain = (s: string) => s.replace(/\*\*|__|`/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim();
const cleanTitle = (s: string) => plain(s).replace(/^Chapter\s+\d+\s*[:.—–-]\s*/i, "").split(/\s+[—–-]\s+/)[0].replace(/[.:]$/, "").trim();
const indent = (line: string) => (line.match(/^[ \t]*/)?.[0] || "").replace(/\t/g, "    ").length;

/** "1.1 Topic", "- 1.1 Topic", "   - **1.2** Topic — what it covers", "1.3: Topic" — not "1.2.1 …" */
const TOPIC_LINE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?(?:Topic\s+)?(\d{1,2})\.(\d{1,2})(?![\d.]\d)\.?(?:\*\*|__)?\s*[:.)—–-]?\s+(.+)$/;
/** "1. Title", "1) Title", "### Chapter 1: Title", "- Chapter 1 — Title", "**Chapter 1: Title**" */
const CHAPTER_LINE = /^(?:#{3,6}\s+|[-*+]\s+)?(?:\*\*|__)?(?:Chapter\s+(\d+)\s*[:.)—–-]\s*|(\d+)[.)]\s+)(.+)$/i;
const CONTENTS = /^##\s+(?:Contents|Table of contents)\s*$([\s\S]*?)(?=^##\s|$(?![\s\S]))/im;

/** The book's title, planned chapters and — for in-depth books — each chapter's topics, from its first reply
 *  ("# Title" … "## Contents" + a numbered list, topics nested under their chapter as "1.1 …", "1.2 …"). */
export function parseContents(md: string): { title: string; chapters: string[]; topics: string[][] } {
  const title = plain(md.match(/^#\s+(.+)$/m)?.[1] || "");
  const block = md.match(CONTENTS)?.[1] || "";
  const chapters: string[] = [];
  const topics: string[][] = [];
  let cur = 0;
  for (const line of block.split("\n")) {
    if (!line.trim()) continue;
    const t = line.match(TOPIC_LINE);
    if (t) {
      const n = +t[1], m = +t[2], tt = cleanTitle(t[3]);
      if (tt && n >= 1 && m >= 1 && m <= 30) (topics[n - 1] ||= [])[m - 1] = tt;
      continue;
    }
    const c = indent(line) < 2 ? line.trim().match(CHAPTER_LINE) : null;
    if (c) {
      const n = +(c[1] || c[2]), tt = cleanTitle(c[3]);
      if (tt && n >= 1 && n <= 60) { chapters[n - 1] = tt; cur = n; }
      continue;
    }
    // a topic nested under the chapter without its number ("   - Atoms and electrons")
    const sub = cur ? line.match(/^\s{2,}(?:[-*+]|\d+[.)])\s+(.+)$/) : null;
    if (sub && !/^(?:\*\*|__)?\d+\.\d/.test(sub[1])) { const tt = cleanTitle(sub[1]); if (tt) (topics[cur - 1] ||= []).push(tt); }
  }
  const n = chapters.length;
  return {
    title,
    chapters: chapters.filter(Boolean),
    topics: Array.from({ length: n }, (_, i) => (topics[i] || []).filter(Boolean)).filter((_, i) => chapters[i]),
  };
}

/** Chapter numbers written in a reply ("## Chapter 3: …"). */
export function chaptersIn(md: string): number[] {
  return [...md.matchAll(/^##\s+Chapter\s+(\d+)\b/gim)].map((m) => +m[1]);
}

/** Topics explained in a reply ("### 2.3 Ohm's law" → "2.3"), in order. */
export function topicsIn(md: string): string[] {
  return [...md.replace(CONTENTS, "").matchAll(/^#{3,4}\s+(?:Topic\s+)?(\d{1,2})\.(\d{1,2})(?!\.?\d)\b/gm)].map((m) => `${+m[1]}.${+m[2]}`);
}

/** Chapters ended with their review ("### Chapter 2 review"). */
export function reviewsIn(md: string): number[] {
  return [...md.matchAll(/^#{2,4}\s+Chapter\s+(\d+)\s*(?:[:—–-]\s*)?(?:review|recap|summary)\b/gim)].map((m) => +m[1]);
}

export interface Book {
  title: string;
  deep: boolean;               // every topic in depth (one topic per page) — or chapter by chapter
  chapters: string[];          // planned chapter titles (may be empty if the AI gave none)
  topics: string[][];          // in-depth books: each chapter's planned topics ([] when the contents didn't list them)
  written: number[];           // chapter numbers written (begun, for in-depth books) so far, in order
  done: string[];              // in-depth books: topics explained so far ("1.1", "1.2" …), in order
  reviewed: number[];          // in-depth books: chapters ended with their review
  replies: string[];           // ids of the book's pages, in order
  next: { n: number; title: string } | null;    // chapter books: the next chapter
  nextTopic: NextTopic | null;                   // in-depth books: the next topic
  current: number;             // the chapter being read
  complete: boolean;
}

type Plan = Pick<Book, "chapters" | "topics" | "written" | "done" | "reviewed">;

/** A chapter of an in-depth book is finished when it has had its review, or all its listed topics are explained. */
export function chapterDone(b: Plan, n: number): boolean {
  const list = b.topics[n - 1] || [];
  return b.reviewed.includes(n) || (list.length > 0 && list.every((_, j) => b.done.includes(`${n}.${j + 1}`)));
}

/** Topic n.m of an in-depth book, with what its page has to do (open the chapter, end it with its review…). */
export function topicAt(b: Plan, n: number, m: number): NextTopic {
  const list = b.topics[n - 1] || [];
  const endsChapter = list.length > 0 && list.every((_, j) => j + 1 === m || b.done.includes(`${n}.${j + 1}`));
  const total = b.chapters.length;
  const last = endsChapter && total > 0 && n <= total && Array.from({ length: total }, (_, i) => i + 1).every((c) => c === n || chapterDone(b, c));
  return { n, m, title: list[m - 1] || "", chapter: b.chapters[n - 1] || "", start: !b.written.includes(n), endsChapter, last };
}

/** A chapter whose topics weren't listed goes on until the AI ends it with its review — or this many topics. */
const MAX_TOPICS = 12;

function planNext(b: Plan, after: [number, number] | null): NextTopic | null {
  const total = b.chapters.length;
  const nextIn = (n: number, from: number): NextTopic | null => {
    const list = b.topics[n - 1] || [];
    if (list.length) {
      for (let j = from; j <= list.length; j++) if (!b.done.includes(`${n}.${j}`)) return topicAt(b, n, j);
      return null;
    }
    if (b.reviewed.includes(n)) return null;
    const explained = b.done.filter((k) => k.startsWith(`${n}.`)).map((k) => +k.split(".")[1]);
    const m = Math.max(from, ...explained.map((x) => x + 1));
    return m <= MAX_TOPICS ? topicAt(b, n, m) : null;
  };
  const [n0, m0] = after || [1, 0];
  let next = nextIn(n0, m0 + 1);
  for (let n = n0 + 1; !next && (total ? n <= total : n === n0 + 1); n++) next = nextIn(n, 1);
  // anything skipped on the way (topics opened out of order from the contents)
  for (let n = 1; !next && n <= Math.min(n0, Math.max(total, 1)); n++) next = nextIn(n, 1);
  return next;
}

/** The latest book in this conversation, or null. A book's pages are the answers to its request and to each
 *  "Continue the book" message after it; other questions in between (doubts) don't end it — a new book does. */
export function findBook(messages: Message[]): Book | null {
  let start = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user" && isBookRequest(messages[i].content)) { start = i; break; }
  if (start < 0) return null;
  const deep = isDeepRequest(messages[start].content);
  const replies: Message[] = [];
  for (let i = start; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "user" || (i !== start && !isBookContinue(m.content))) continue;
    const a = messages[i + 1];
    if (a?.role === "assistant" && a.content) replies.push(a);
  }
  if (!replies.length) return null;
  const { title, chapters, topics } = parseContents(replies[0].content);
  const written: number[] = [], done: string[] = [], reviewed: number[] = [];
  let lastTopic: [number, number] | null = null;
  for (const r of replies) {
    for (const n of chaptersIn(r.content)) if (!written.includes(n)) written.push(n);
    const ts = topicsIn(r.content);
    for (const k of ts) if (!done.includes(k)) done.push(k);
    if (ts.length) { const [n, m] = ts[ts.length - 1].split(".").map(Number); lastTopic = [n, m]; }
    for (const n of reviewsIn(r.content)) if (!reviewed.includes(n)) reviewed.push(n);
  }
  const total = chapters.length;
  const book: Book = {
    title: title || "Your book", deep, chapters, topics: deep ? topics : [], written, done: deep ? done : [], reviewed: deep ? reviewed : [],
    replies: replies.map((r) => r.id), next: null, nextTopic: null, current: 0, complete: false,
  };
  if (deep) {
    // a topic counts toward the chapter it belongs to; the chapter heading alone (no topic yet) doesn't finish anything
    if (!lastTopic && written.length) lastTopic = [written[written.length - 1], 0];
    book.nextTopic = planNext(book, lastTopic);
    book.current = lastTopic?.[0] || 1;
    book.complete = total > 0 && Array.from({ length: total }, (_, i) => i + 1).every((n) => chapterDone(book, n));
    if (book.complete) book.nextTopic = null;
  } else {
    const last = written.length ? Math.max(...written) : 0;
    book.next = total ? (last < total ? { n: last + 1, title: chapters[last] || "" } : null) : { n: last + 1, title: "" };
    book.current = last;
    book.complete = total > 0 && !book.next;
  }
  return book;
}

/** How many topics an in-depth book plans (0 when some chapter's topics weren't listed). */
export function plannedTopics(b: Book): number {
  return b.chapters.length && b.chapters.every((_, i) => (b.topics[i] || []).length) ? b.topics.reduce((s, t) => s + t.length, 0) : 0;
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
    if (m.role === "user" && isBookMessage(m.content) && messages[i + 1].role === "assistant") ids.add(messages[i + 1].id);
  }
  return ids;
}
