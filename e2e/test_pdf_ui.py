"""PDF files from replies. The Android path is checked by giving the exact HTML the app hands to window.ZenvqoPDF to
Chromium's PDF engine (the engine Android's WebView prints with) and reading the resulting PDF back; the browser path
prints the page with print styles."""
import json
import re
import subprocess
from pathlib import Path

import pytest
from conftest import start_server
from playwright.sync_api import expect

ROOT = Path(__file__).resolve().parents[1]
SHOTS = Path(__file__).parent / "screenshots"
HTML = ROOT / "frontend" / "dist-standalone" / "zenvqo-chat.html"

MOCK = """
window.__pdf = [];
window.ZenvqoPDF = {
  save(id, html, name) { window.__pdf.push({ev: 'save', id, html, name}); setTimeout(() => window.__zpdf(id, 'saved', 'Downloads/zenvqo'), 300); },
  open(id) { window.__pdf.push({ev: 'open', id}); },
  share(id) { window.__pdf.push({ev: 'share', id}); },
};
"""


def ask(p, text):
    box = p.get_by_label("Message", exact=True)
    box.fill(text)
    box.press("Enter")
    reply = p.locator("article.msg-assistant").last
    expect(reply).to_have_attribute("aria-busy", "false", timeout=15_000)
    return reply


def pdf_text(path: Path) -> str:
    return subprocess.run(["pdftotext", "-layout", str(path), "-"], capture_output=True, text=True, check=True).stdout


def first_page_png(path: Path, out: Path):
    subprocess.run(["pdftoppm", "-png", "-r", "60", "-f", "1", "-l", "1", "-singlefile", str(path), str(out.with_suffix(""))], check=True)


def test_android_app_saves_quiz_pdf(browser, tmp_path):
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    ctx.add_init_script(MOCK)
    p = ctx.new_page()
    errors = []
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.goto(HTML.as_uri())
    reply = ask(p, "generate pdf of 30 quiz questions")
    card = reply.locator(".pdf-card")
    expect(card).to_contain_text("Saved to Downloads/zenvqo", timeout=10_000)              # made automatically
    expect(card).to_contain_text("practice-quiz-30-questions.pdf")
    card.get_by_role("button", name="Open").click()
    card.get_by_role("button", name="Share").click()
    log = p.evaluate("window.__pdf")
    save = next(x for x in log if x["ev"] == "save")
    assert save["name"] == "practice-quiz-30-questions.pdf"
    assert [x["ev"] for x in log[1:]] == ["open", "share"] and log[1]["id"] == save["id"]
    html = save["html"]
    assert html.startswith("<!DOCTYPE html>") and "KaTeX_Main" in html and "@page" in html
    p.screenshot(path=str(SHOTS / "pdf-android-card.png"))

    # what Android's print engine makes of it
    doc = ctx.new_page()
    doc.set_content(html, wait_until="load")
    doc.evaluate("document.fonts.ready")
    out = tmp_path / "quiz.pdf"
    doc.pdf(path=str(out), prefer_css_page_size=True, print_background=True)
    text = pdf_text(out)
    assert text.count("Practice Quiz (30 questions)") == 1 and "offline demo, not a real AI" not in text   # title once, no chat preamble
    assert len(re.findall(r"^\s*30\.", text, re.M)) >= 1 and "Answer key" in text
    assert "नई दिल्ली" in text or "दिल्ली" in text                                          # Hindi text kept as text
    assert "\\frac" not in text and "$" not in text                                           # math typeset, not raw
    pages = text.count("\f")                                                                 # pdftotext ends every page with \f
    assert pages >= 2 and re.search(rf"\b1\s*/\s*{pages}\b", text) and re.search(rf"\b{pages}\s*/\s*{pages}\b", text)   # page numbers
    assert "Copy LaTeX" not in text and "Read aloud" not in text                              # no app buttons in the file
    first_page_png(out, SHOTS / "pdf-quiz-page1.png")
    (SHOTS / "pdf-quiz.pdf").write_bytes(out.read_bytes())
    assert errors == []
    ctx.close()


def test_browser_print_layout_and_button(page, tmp_path):
    page.goto("/")
    page.get_by_role("button", name="Create an account").click()
    page.get_by_label("Name").fill("Asha")
    page.get_by_label("Email").fill("pdf@example.com")
    page.get_by_label("Password").fill("correct horse battery")
    page.get_by_role("button", name="Create account").click()
    expect(page.get_by_role("heading", name="How can I help?")).to_be_visible()
    page.evaluate("() => { window.__printed = 0; window.print = () => { window.__printed++; }; }")
    reply = ask(page, "make a pdf of 12 practice questions")
    card = reply.locator(".pdf-card")
    expect(card).to_contain_text("Save as PDF")                                                 # browsers: needs a tap
    card.get_by_role("button", name="Save PDF").click()
    assert page.evaluate("window.__printed") == 1 and page.title().startswith("practice-quiz-12-questions")
    page.emulate_media(media="print")
    out = tmp_path / "browser.pdf"
    page.pdf(path=str(out), prefer_css_page_size=True, print_background=True)
    text = pdf_text(out)
    assert "Practice Quiz (12 questions)" in text and "12." in text
    assert "New chat" not in text and "Message zenvqo" not in text                              # only the document prints
    page.emulate_media(media="screen")
    plain = ask(page, "tell me something")                                                     # any reply can be saved
    plain.get_by_role("button", name="Save as PDF").click()
    expect(plain.locator(".pdf-card")).to_be_visible()
    assert page.evaluate("window.__printed") == 2
    assert page.errors == []


@pytest.fixture(scope="module")
def own_server(tmp_path_factory):
    """A server of its own: the shared one allows only 10 sign-ups per 10 minutes (the login rate limit)."""
    base, proc = start_server(tmp_path_factory)
    yield base
    proc.terminate()
    proc.wait(10)


@pytest.fixture
def page(browser, own_server):
    ctx = browser.new_context(base_url=own_server, viewport={"width": 1280, "height": 800})
    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    yield pg
    ctx.close()
