import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "../api/types";
import { bookMarkdown, bookReplyIds, bookRequest, chaptersIn, continueRequest, findBook, parseContents } from "./book";

const FIRST = `# Understanding Electricity
*From a single charge to the power grid.*

## Contents
1. **What is electric charge?** — atoms, electrons and static
2. Current and voltage
3. Chapter 3: Resistance and Ohm's law
4. Circuits in your home

## Chapter 1: What is electric charge?
Everything is made of atoms…

### Key points
- Like charges repel.
`;
const SECOND = `## Chapter 2: Current and voltage
Current is the flow of charge…`;

const msg = (id: string, role: "user" | "assistant", content: string): Message =>
  ({ id, role, content, model: "m", status: "complete", error: null, attachments: [], created_at: 0 });

test("contents: title and chapter titles, cleaned up", () => {
  const c = parseContents(FIRST);
  assert.equal(c.title, "Understanding Electricity");
  assert.deepEqual(c.chapters, ["What is electric charge?", "Current and voltage", "Resistance and Ohm's law", "Circuits in your home"]);
  assert.deepEqual(chaptersIn(FIRST), [1]);
  assert.deepEqual(parseContents("no book here"), { title: "", chapters: [] });
});

test("the book in a conversation: chapters written and the next one", () => {
  const ms = [msg("u1", "user", bookRequest("electricity")), msg("a1", "assistant", FIRST)];
  let b = findBook(ms)!;
  assert.equal(b.title, "Understanding Electricity");
  assert.deepEqual(b.written, [1]);
  assert.deepEqual(b.next, { n: 2, title: "Current and voltage" });
  assert.equal(continueRequest(2, "Current and voltage"), "Continue the book: write Chapter 2 — Current and voltage");
  ms.push(msg("u2", "user", continueRequest(2, "Current and voltage")), msg("a2", "assistant", SECOND));
  b = findBook(ms)!;
  assert.deepEqual(b.written, [1, 2]);
  assert.deepEqual(b.next, { n: 3, title: "Resistance and Ohm's law" });
  assert.deepEqual(b.replies, ["a1", "a2"]);
  assert.match(bookMarkdown(ms, b), /^# Understanding Electricity[\s\S]*## Chapter 2: Current and voltage/);
  assert.deepEqual([...bookReplyIds(ms)], ["a1", "a2"]);
  // the user asks something else: the book stops there
  ms.push(msg("u3", "user", "what's the weather?"), msg("a3", "assistant", "Sunny"));
  assert.deepEqual(findBook(ms)!.replies, ["a1", "a2"]);
  assert.equal(bookReplyIds(ms).has("a3"), false);
});

test("last chapter written → no next; no contents → keep counting", () => {
  const all = FIRST.replace("## Chapter 1", "## Chapter 4");
  assert.equal(findBook([msg("u", "user", bookRequest("x")), msg("a", "assistant", all)])!.next, null);
  const loose = findBook([msg("u", "user", bookRequest("x")), msg("a", "assistant", "# Book\n\n## Chapter 1: Start\ntext")])!;
  assert.deepEqual(loose.next, { n: 2, title: "" });
  assert.equal(findBook([msg("u", "user", "hello"), msg("a", "assistant", "hi")]), null);
});
