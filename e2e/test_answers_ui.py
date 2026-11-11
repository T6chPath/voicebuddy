"""Answers are laid out for reading: the AI is told how to structure them, and the app shows headings, key terms,
steps, tables and highlight boxes (> **Tip:** …) clearly — in the phone app build."""
from pathlib import Path

from playwright.sync_api import expect

from test_camera_pdf_read import FakeAI, open_app, wait_reply

SAMPLE = (Path(__file__).parent / "answer_sample.md").read_text()


def test_answer_layout_and_instructions(browser):
    ai = FakeAI(SAMPLE)
    p, errors = open_app(browser, ai)
    p.locator("#composer-input").fill("What is photosynthesis?")
    p.locator("#composer-input").press("Enter")
    wait_reply(p, 1)
    md = p.locator("article.msg-assistant .md").last
    system = ai.requests[0]["messages"][0]["content"]
    assert "begin with the direct answer" in system and "> **In short:**" in system and "Hinglish" in system
    expect(md.locator("h2")).to_have_count(2)
    expect(md.locator("ol > li")).to_have_count(3)
    expect(md.locator("table th").first).to_have_text("Needs")
    for kind, label in [("example", "Example"), ("tip", "Tip"), ("summary", "In short")]:
        box = md.locator(f"aside.callout-{kind}")
        expect(box).to_have_count(1)
        expect(box.locator(".callout-label")).to_have_text(label)
    expect(md.locator("aside.callout-summary")).to_contain_text("solar-powered kitchens")
    expect(md.locator("blockquote")).to_have_count(0)
    lead, body = md.locator("p").nth(0), md.locator("p").nth(1)
    size = lambda loc: float(loc.evaluate("e => parseFloat(getComputedStyle(e).fontSize)"))
    assert size(lead) > size(body), "the direct answer is a little larger"
    hl = md.locator("p strong").first.evaluate("e => getComputedStyle(e).backgroundImage")
    assert "gradient" in hl, "key terms are highlighted"
    assert not errors, errors
