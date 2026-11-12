"""'Learn as a book' in the + menu: a topic becomes a book — title, contents, Chapter 1 — then chapter by chapter with
'Next chapter', and the whole book as a PDF."""
import json
import re

from playwright.sync_api import expect

from test_camera_pdf_read import FakeAI, open_app, wait_reply

CH1 = """# Understanding Electricity
*For curious beginners — by the end you'll be able to explain how your home's wiring works.*

## Contents
1. What is electric charge? — atoms, electrons and static
2. Current and voltage — what flows and what pushes it
3. Circuits at home — switches, fuses and safety

## Chapter 1: What is electric charge?
Everything around you is made of atoms.

### 1.1 Atoms and electrons
Electrons carry a negative charge.

### Key points
- Like charges repel; unlike charges attract.

### Practice
1. What charge does an electron carry?
2. Why does a rubbed balloon stick to a wall?

### Answers
1. Negative.
2. Rubbing gives it extra electrons; it attracts the wall's charges.
"""
CH2 = """## Chapter 2: Current and voltage
Current is the flow of charge; voltage is the push.

### Key points
- Current is measured in amperes.
"""


class BookAI(FakeAI):
    def __init__(self, replies):
        super().__init__(replies[0])
        self.replies = list(replies)

    def handle(self, route):
        if route.request.method == "POST" and not route.request.url.endswith("/models"):
            self.reply = self.replies[min(len(self.requests), len(self.replies) - 1)]
        return super().handle(route)


def test_learn_a_topic_as_a_book(browser):
    ai = BookAI([CH1, CH2])
    p, errors = open_app(browser, ai)
    p.get_by_role("button", name="Add photos, files and more").click()
    p.get_by_role("menuitem", name=re.compile("^Learn as a book")).click()
    chip = p.locator(".book-mode")
    expect(chip).to_contain_text("Learn as a book")
    expect(chip.get_by_role("button", name="Chapters")).to_have_attribute("aria-pressed", "true")
    box = p.locator("#composer-input")
    expect(box).to_have_attribute("placeholder", re.compile("What do you want to learn"))
    box.fill("electricity")
    box.press("Enter")
    wait_reply(p, 1)
    expect(chip).to_have_count(0)                                         # book mode is for one message
    expect(p.locator("article.msg-turn").last).to_have_text("Book: Electricity")
    expect(p.locator("article.msg-turn").last).to_have_attribute("title", "Teach me as a book: electricity")
    expect(p.locator(".chat-title")).to_have_text("Book: Electricity")                # the chat is named after the topic
    req = ai.requests[0]
    assert "Learn as a book" in req["messages"][0]["content"] and "## Chapter N: Title" in req["messages"][0]["content"]
    assert '"### Practice"' in req["messages"][0]["content"] and '"### Answers"' in req["messages"][0]["content"]
    assert req["messages"][-1]["content"] == "Teach me as a book: electricity" or "Teach me as a book: electricity" in json.dumps(req["messages"][-1])
    page1 = p.locator("article.msg-assistant").last
    expect(page1).to_have_class(re.compile(r"\bmsg-book\b"))
    font = page1.locator(".md p").first.evaluate("e => getComputedStyle(e).fontFamily")
    assert "serif" in font and "Georgia" in font, font
    expect(page1.locator("h3.practice-head")).to_have_text("Practice")
    expect(page1.locator("h3.answers-head")).to_have_text("Answers")
    for sel in ["h3.practice-head + ol > li", "h3.answers-head + ol > li"]:
        items = page1.locator(sel)
        expect(items).to_have_count(2)
        for i in range(2):
            items.nth(i).scroll_into_view_if_needed()
            expect(items.nth(i)).to_be_visible()
            assert items.nth(i).evaluate("e => { const b = getComputedStyle(e, '::before'); return b.content.includes('counter') && e.getBoundingClientRect().height > 30 }"), sel
    bar = p.get_by_role("region", name="Book: Understanding Electricity")
    expect(bar).to_contain_text("Chapter 1 of 3 written")
    expect(bar.get_by_role("progressbar")).to_have_attribute("aria-valuenow", "1")
    nxt = bar.get_by_role("button", name="Next: Chapter 2 — Current and voltage")
    nxt.click()
    wait_reply(p, 2)
    assert ai.requests[-1]["messages"][-1]["content"] == "Continue the book: write Chapter 2 — Current and voltage"
    expect(p.locator("article.msg-assistant").last).to_have_class(re.compile(r"\bmsg-book\b"))
    bar = p.get_by_role("region", name="Book: Understanding Electricity")
    expect(bar).to_have_count(1)                                          # only under the latest page
    expect(bar).to_contain_text("Chapter 2 of 3 written")
    bar.locator("summary").click()
    expect(bar.get_by_role("button", name="1. What is electric charge?")).to_be_visible()
    expect(bar.get_by_role("button", name="2. Current and voltage")).to_be_visible()
    expect(bar.locator("li.next")).to_contain_text("3. Circuits at home")
    expect(bar.get_by_role("button", name="Next: Chapter 3 — Circuits at home")).to_be_visible()
    with p.expect_download(timeout=60_000) as dl:
        bar.get_by_role("button", name="Save book as PDF").click()
    assert dl.value.suggested_filename.lower().endswith(".pdf")
    assert "Understanding" in dl.value.suggested_filename or "understanding" in dl.value.suggested_filename.lower()
    expect(bar).to_contain_text("downloaded", timeout=30_000)
    assert not errors, errors


def test_book_mode_and_image_mode_switch_each_other_off(browser):
    p, errors = open_app(browser, FakeAI("ok"))
    p.get_by_role("button", name="Add photos, files and more").click()
    p.get_by_role("menuitem", name=re.compile("^Learn as a book")).click()
    expect(p.locator(".book-mode")).to_be_visible()
    p.get_by_role("button", name="Cancel book mode").click()
    expect(p.locator(".book-mode")).to_have_count(0)
    p.locator("#composer-input").fill("hello")
    p.locator("#composer-input").press("Enter")
    wait_reply(p, 1)
    expect(p.locator("article.msg-user .plain").last).to_have_text("hello")
    expect(p.locator(".book-bar")).to_have_count(0)
    assert not errors, errors


DEEP1 = """# Electricity, Topic by Topic
*For beginners — by the end you'll understand every idea behind your home's wiring.*

## Contents
1. What is electric charge? — atoms, electrons and static
   - 1.1 Atoms and electrons
   - 1.2 Static electricity
2. Current and voltage — what flows and what pushes it
   - 2.1 What current is
   - 2.2 Voltage

## Chapter 1: What is electric charge?
Everything around you is made of atoms.

### 1.1 Atoms and electrons
Everything around you is built from atoms: a tiny nucleus with electrons around it.

Electrons carry a negative charge; protons a positive one.

> **Example:** An atom with 6 protons and 7 electrons has a charge of $-e$.

> **Definition:** Charge is the property that makes particles push or pull on each other.

#### Practice
1. What charge does a proton carry?
2. An atom has 8 protons and 10 electrons. What is its charge?
3. Why is a neutral atom neutral?

#### Answers
1. $+e$.
2. $(8-10)e = -2e$: it is a negative ion.
3. It has as many electrons as protons, so the charges cancel.
"""
DEEP2 = """### 1.2 Static electricity
Rubbing moves electrons from one thing to another.

### Chapter 1 review
Like charges repel; unlike charges attract.
"""
DOUBT = "Because combing moves electrons onto your hair, and like charges repel."
DEEP3 = """## Chapter 2: Current and voltage
Now the charges start to move.

### 2.1 What current is
Current is charge flowing past a point each second.
"""
DEEP4 = """### 2.2 Voltage
Voltage is the push that makes charge flow.

### Chapter 2 review
Current flows; voltage pushes.

## What to learn next
Resistance and Ohm's law.
"""


def test_learn_every_topic_in_depth(browser):
    """'In depth': every topic of every chapter gets its own page; Next goes topic by topic, opening and ending
    chapters on the way; a doubt asked between pages keeps the way back into the book."""
    ai = BookAI([DEEP1, DEEP2, DOUBT, DEEP3, DEEP4])
    p, errors = open_app(browser, ai)
    p.get_by_role("button", name="Add photos, files and more").click()
    expect(p.get_by_role("menuitem", name=re.compile("^Learn as a book"))).to_contain_text("every topic in depth")
    p.get_by_role("menuitem", name=re.compile("^Learn as a book")).click()
    depth = p.get_by_role("group", name="Learn as a book").get_by_role("group", name="How the book is written")
    expect(depth.get_by_role("button", name="Chapters")).to_have_attribute("aria-pressed", "true")
    depth.get_by_role("button", name="In depth").click()
    expect(depth.get_by_role("button", name="In depth")).to_have_attribute("aria-pressed", "true")
    expect(depth.get_by_role("button", name="Chapters")).to_have_attribute("aria-pressed", "false")
    box = p.locator("#composer-input")
    expect(box).to_have_attribute("placeholder", "What do you want to learn in depth?")
    expect(box).to_be_focused()
    expect(p.locator(".book-mode")).to_contain_text("Every topic of every chapter explained in depth")
    box.fill("electricity")
    box.press("Enter")
    wait_reply(p, 1)
    expect(p.locator("article.msg-turn").last).to_have_text("Book in depth: Electricity")
    expect(p.locator("article.msg-turn").last).to_have_attribute("title", "Teach me as a book, every topic in depth: electricity")
    expect(p.locator(".chat-title")).to_have_text("Book in depth: Electricity")
    system = ai.requests[0]["messages"][0]["content"]
    assert "Teach me as a book, every topic in depth:" in system and "### Chapter N review" in system
    assert "Never use fixed section labels" in system and '"**Example:**"' in system and "The big idea\" (" not in system
    assert '"#### Practice"' in system and '"#### Answers"' in system                 # every topic ends with practice and answers
    expect(p.locator("article.msg-assistant").last).to_have_class(re.compile(r"\bmsg-book\b"))
    bar = p.get_by_role("region", name="Book: Electricity, Topic by Topic")
    expect(bar).to_contain_text("1 of 4 topics explained · Chapter 1 of 2")
    expect(bar.get_by_role("progressbar", name="Topics explained")).to_have_attribute("aria-valuenow", "1")
    expect(bar.get_by_role("progressbar")).to_have_attribute("aria-valuemax", "4")
    expect(bar).to_contain_text("Stuck on something? Ask about it in the message box")
    bar.get_by_role("button", name="Next: 1.2 — Static electricity").click()
    wait_reply(p, 2)
    assert ai.requests[-1]["messages"][-1]["content"] == "Continue the book: explain topic 1.2 — Static electricity, then end Chapter 1 with its review"
    expect(p.locator("article.msg-turn").last).to_have_text("1.2 Static electricity")
    # a doubt between pages: answered normally, and the book is still a tap away
    box.fill("why does my hair stand up after combing?")
    box.press("Enter")
    wait_reply(p, 3)
    expect(p.locator("article.msg-assistant").last).not_to_have_class(re.compile(r"\bmsg-book\b"))
    compact = p.locator(".book-bar.compact")
    expect(compact).to_have_count(1)
    expect(compact).to_contain_text("Back to your book — 2 of 4 topics explained")
    compact.get_by_role("button", name="Next: Chapter 2 · 2.1 — What current is").click()
    wait_reply(p, 4)
    assert ai.requests[-1]["messages"][-1]["content"] == "Continue the book: start Chapter 2 — Current and voltage, and explain topic 2.1 — What current is"
    expect(p.locator("article.msg-assistant").last).to_have_class(re.compile(r"\bmsg-book\b"))
    expect(p.locator(".book-bar")).to_have_count(1)                      # only under the latest page
    bar = p.get_by_role("region", name="Book: Electricity, Topic by Topic")
    expect(bar).to_contain_text("3 of 4 topics explained · Chapter 2 of 2")
    bar.locator("summary").click()
    expect(bar.get_by_role("button", name="Go to 1.1 Atoms and electrons")).to_be_visible()
    expect(bar.get_by_role("button", name="Go to 2.1 What current is")).to_be_visible()
    expect(bar.get_by_role("button", name="Explain 2.2 Voltage (next)")).to_be_visible()
    bar.get_by_role("button", name="Go to 1.2 Static electricity").click()
    p.wait_for_function("""() => { const h = [...document.querySelectorAll('.msg-book .md h3')].find((x) => x.textContent.startsWith('1.2'));
        const r = h.getBoundingClientRect(); return r.top > -5 && r.top < innerHeight / 2; }""", timeout=5000)
    bar.get_by_role("button", name="Next: 2.2 — Voltage").click()
    wait_reply(p, 5)
    assert ai.requests[-1]["messages"][-1]["content"] == "Continue the book: explain topic 2.2 — Voltage, then end Chapter 2 with its review (the last topic of the book)"
    bar = p.get_by_role("region", name="Book: Electricity, Topic by Topic")
    expect(bar).to_contain_text("All 4 topics explained — book complete")
    expect(bar.get_by_role("button", name=re.compile("^Next"))).to_have_count(0)
    expect(bar.get_by_role("button", name="Save book as PDF")).to_have_class(re.compile(r"\bprimary\b"))
    # the pages read like a book: a cover, contents, chapter openers, numbered topics, examples and definitions in boxes
    first = p.locator("article.msg-book").first
    expect(first.locator(".md > h1:first-child")).to_have_text("Electricity, Topic by Topic")
    expect(first.locator("h2.contents-head + ol > li")).to_have_count(2)
    expect(first.locator("h2.contents-head + ol .sec-num").first).to_have_text("1.1")
    expect(first.locator('h2.chapter-head[data-chapter="1"] .ch-title')).to_have_text("What is electric charge?")
    expect(first.locator('h3.topic-head[data-topic="1.1"] .topic-num')).to_have_text("1.1")
    expect(first.locator(".callout-example .callout-label")).to_have_text("Example")
    expect(first.locator(".callout-define .callout-label")).to_have_text("Definition")
    expect(first.locator("h4.practice-head")).to_have_text("Practice")
    expect(first.locator("h4.answers-head")).to_have_text("Answers")
    expect(first.locator("h4.practice-head + ol > li")).to_have_count(3)
    expect(first.locator("h4.answers-head + ol > li")).to_have_count(3)
    last_answer = first.locator("h4.answers-head + ol > li").last
    last_answer.scroll_into_view_if_needed()
    expect(last_answer).to_be_visible()
    expect(last_answer).to_contain_text("the charges cancel")
    expect(p.locator(".msg-book .review-head")).to_have_count(2)
    cover = first.locator(".md > h1:first-child").evaluate("e => getComputedStyle(e).backgroundImage")
    assert "gradient" in cover, cover
    expect(p.locator("article.msg-turn")).to_have_count(4)                # the doubt stays a normal message
    expect(p.locator("article.msg-user:not(.msg-turn)")).to_have_count(1)
    # the whole book as a PDF: a cover page, then each chapter on a page of its own
    with p.expect_download(timeout=90_000) as dl:
        bar.get_by_role("button", name="Save book as PDF").click()
    pdf = open(dl.value.path(), "rb").read()
    assert pdf.startswith(b"%PDF") and len(re.findall(rb"/Type /Page\b(?!s)", pdf)) >= 3
    # the choice is remembered for the next book
    p.get_by_role("button", name="Add photos, files and more").click()
    p.get_by_role("menuitem", name=re.compile("^Learn as a book")).click()
    expect(p.locator(".book-mode").get_by_role("button", name="In depth")).to_have_attribute("aria-pressed", "true")
    assert not errors, errors
