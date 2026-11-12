import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "../api/types";
import { bookMarkdown, bookReplyIds, bookRequest, chapterDone, chaptersIn, continueRequest, findBook, isBookMessage, parseContents, plannedTopics,
  reviewsIn, topicAt, topicRequest, topicsIn } from "./book";

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
  assert.deepEqual(parseContents("no book here"), { title: "", chapters: [], topics: [] });
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

/* ---------- every topic in depth ---------- */
const DEEP1 = `# Electricity, Topic by Topic
*For beginners — by the end you'll understand every idea behind your home's wiring.*

## Contents
1. **What is electric charge?** — atoms, electrons and static
   - 1.1 Atoms and electrons
   - **1.2 Static electricity** — why a balloon sticks
   - 1.3: Coulomb's law
2. Current and voltage — what flows and what pushes it
   - 2.1 What current is
   - 2.2 Voltage
3. Circuits at home
   - 3.1 Switches and fuses

## Chapter 1: What is electric charge?
Why it matters…

### 1.1 Atoms and electrons
#### The big idea
Everything is made of atoms.
#### Step by step
1. First…
#### Check yourself
1. What is 1.5 times 2?
`;
const topicPage = (id: string, title: string, extra = "") => `${extra}### ${id} ${title}\n#### The big idea\nText.\n#### 1.2.1 Not a topic\n`;

test("in-depth contents: chapters and the topics under each", () => {
  const c = parseContents(DEEP1);
  assert.equal(c.title, "Electricity, Topic by Topic");
  assert.deepEqual(c.chapters, ["What is electric charge?", "Current and voltage", "Circuits at home"]);
  assert.deepEqual(c.topics, [["Atoms and electrons", "Static electricity", "Coulomb's law"], ["What current is", "Voltage"], ["Switches and fuses"]]);
  assert.deepEqual(topicsIn(DEEP1), ["1.1"]);                         // not the contents, not "1.2.1", not "1.5 times"
  assert.deepEqual(reviewsIn("### Chapter 2 review\n## Chapter 3: X"), [2]);
  // other ways of writing the contents: headings for chapters, topics without numbers
  const alt = parseContents("# B\n## Contents\n### Chapter 1: Start\n- Getting set up\n- First steps\n### Chapter 2 — Next\n  - 2.1 More\n## Chapter 1: Start\n");
  assert.deepEqual(alt.chapters, ["Start", "Next"]);
  assert.deepEqual(alt.topics, [[], ["More"]]);
  const loose = parseContents("# B\n## Contents\n1. Start\n   - Getting set up\n   - First steps\n2. Next\n");
  assert.deepEqual(loose.topics, [["Getting set up", "First steps"], []]);
});

test("in-depth book: topic by topic, chapters opened and ended on the way, doubts in between", () => {
  const ms = [msg("u1", "user", bookRequest("electricity", true)), msg("a1", "assistant", DEEP1)];
  assert.equal(ms[0].content, "Teach me as a book, every topic in depth: electricity");
  let b = findBook(ms)!;
  assert.equal(b.deep, true);
  assert.deepEqual(b.done, ["1.1"]);
  assert.equal(plannedTopics(b), 6);
  assert.deepEqual(b.nextTopic, { n: 1, m: 2, title: "Static electricity", chapter: "What is electric charge?", start: false, endsChapter: false, last: false });
  assert.equal(topicRequest(b.nextTopic!), "Continue the book: explain topic 1.2 — Static electricity");
  ms.push(msg("u2", "user", topicRequest(b.nextTopic!)), msg("a2", "assistant", topicPage("1.2", "Static electricity")));
  // a doubt in between doesn't end the book, and isn't one of its pages
  ms.push(msg("u3", "user", "why does my hair stand up?"), msg("a3", "assistant", "Because of static."));
  b = findBook(ms)!;
  assert.deepEqual(b.replies, ["a1", "a2"]);
  assert.equal(bookReplyIds(ms).has("a3"), false);
  assert.equal(b.nextTopic!.m, 3);
  assert.equal(b.nextTopic!.endsChapter, true);                       // the last topic of Chapter 1: it ends with the review
  assert.equal(topicRequest(b.nextTopic!), "Continue the book: explain topic 1.3 — Coulomb's law, then end Chapter 1 with its review");
  ms.push(msg("u4", "user", topicRequest(b.nextTopic!)), msg("a4", "assistant", topicPage("1.3", "Coulomb's law") + "### Chapter 1 review\nSummary."));
  b = findBook(ms)!;
  assert.deepEqual(b.replies, ["a1", "a2", "a4"]);
  assert.equal(chapterDone(b, 1), true);
  assert.deepEqual(b.nextTopic, { n: 2, m: 1, title: "What current is", chapter: "Current and voltage", start: true, endsChapter: false, last: false });
  assert.equal(topicRequest(b.nextTopic!), "Continue the book: start Chapter 2 — Current and voltage, and explain topic 2.1 — What current is");
  ms.push(msg("u5", "user", topicRequest(b.nextTopic!)), msg("a5", "assistant", topicPage("2.1", "What current is", "## Chapter 2: Current and voltage\nWhy…\n\n")));
  b = findBook(ms)!;
  assert.equal(b.current, 2);
  assert.deepEqual(b.written, [1, 2]);
  assert.equal(b.nextTopic!.start, false);
  // jump ahead from the contents: the last topic of the book (Chapter 2 isn't finished, so it's not "the last one" yet)
  const jump = topicAt(b, 3, 1);
  assert.equal(topicRequest(jump), "Continue the book: start Chapter 3 — Circuits at home, and explain topic 3.1 — Switches and fuses, then end Chapter 3 with its review");
  ms.push(msg("u6", "user", topicRequest(jump)), msg("a6", "assistant", topicPage("3.1", "Switches and fuses", "## Chapter 3: Circuits at home\n\n")));
  b = findBook(ms)!;
  // after the end of the book, the skipped topic is next — and now it really is the last one
  assert.deepEqual(b.nextTopic, { n: 2, m: 2, title: "Voltage", chapter: "Current and voltage", start: false, endsChapter: true, last: true });
  assert.equal(topicRequest(b.nextTopic!), "Continue the book: explain topic 2.2 — Voltage, then end Chapter 2 with its review (the last topic of the book)");
  assert.equal(b.complete, false);
  ms.push(msg("u7", "user", topicRequest(b.nextTopic!)), msg("a7", "assistant", topicPage("2.2", "Voltage") + "## What to learn next\n"));
  b = findBook(ms)!;
  assert.equal(b.complete, true);
  assert.equal(b.nextTopic, null);
  assert.deepEqual(b.done, ["1.1", "1.2", "1.3", "2.1", "3.1", "2.2"]);
  assert.match(bookMarkdown(ms, b), /^# Electricity[\s\S]*### 2\.2 Voltage/);
  assert.doesNotMatch(bookMarkdown(ms, b), /hair stand up|Because of static/);
});

test("in-depth book whose topics weren't listed: on until the chapter's review", () => {
  const first = "# B\n## Contents\n1. Start\n2. Next\n\n## Chapter 1: Start\n### 1.1 Hello\ntext";
  const ms = [msg("u", "user", bookRequest("x", true)), msg("a", "assistant", first)];
  let b = findBook(ms)!;
  assert.equal(plannedTopics(b), 0);
  assert.deepEqual(b.nextTopic, { n: 1, m: 2, title: "", chapter: "Start", start: false, endsChapter: false, last: false });
  assert.equal(topicRequest(b.nextTopic!), "Continue the book: explain topic 1.2");
  ms.push(msg("u2", "user", topicRequest(b.nextTopic!)), msg("a2", "assistant", "### 1.2 More\ntext\n### Chapter 1 review\nok"));
  b = findBook(ms)!;
  assert.deepEqual([b.nextTopic!.n, b.nextTopic!.m, b.nextTopic!.start], [2, 1, true]);
  // chapter books are unchanged
  assert.equal(findBook([msg("u", "user", bookRequest("x")), msg("a", "assistant", first)])!.nextTopic, null);
  assert.equal(isBookMessage("Teach me as a book, every topic in depth: x") && isBookMessage("Continue the book: explain topic 1.2"), true);
  assert.equal(isBookMessage("Teach me about books"), false);
});
