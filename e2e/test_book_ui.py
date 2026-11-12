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

### Answers
1. Negative.
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
    chip = p.locator(".mode-chip.book-chip")
    expect(chip).to_contain_text("Book")
    box = p.locator("#composer-input")
    expect(box).to_have_attribute("placeholder", re.compile("What do you want to learn"))
    box.fill("electricity")
    box.press("Enter")
    wait_reply(p, 1)
    expect(chip).to_have_count(0)                                         # book mode is for one message
    expect(p.locator("article.msg-user").last).to_contain_text("Teach me as a book: electricity")
    req = ai.requests[0]
    assert "Learn as a book" in req["messages"][0]["content"] and "## Chapter N: Title" in req["messages"][0]["content"]
    assert req["messages"][-1]["content"] == "Teach me as a book: electricity" or "Teach me as a book: electricity" in json.dumps(req["messages"][-1])
    page1 = p.locator("article.msg-assistant").last
    expect(page1).to_have_class(re.compile(r"\bmsg-book\b"))
    font = page1.locator(".md p").first.evaluate("e => getComputedStyle(e).fontFamily")
    assert "serif" in font and "Georgia" in font, font
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
    expect(p.locator(".book-chip")).to_be_visible()
    p.get_by_role("button", name="Cancel book mode").click()
    expect(p.locator(".book-chip")).to_have_count(0)
    p.locator("#composer-input").fill("hello")
    p.locator("#composer-input").press("Enter")
    wait_reply(p, 1)
    expect(p.locator("article.msg-user .plain").last).to_have_text("hello")
    expect(p.locator(".book-bar")).to_have_count(0)
    assert not errors, errors
