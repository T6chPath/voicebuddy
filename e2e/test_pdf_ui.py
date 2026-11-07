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


def pdf_pages(path: Path) -> int:
    info = subprocess.run(["pdfinfo", str(path)], capture_output=True, text=True, check=True).stdout
    return int(re.search(r"^Pages:\s+(\d+)", info, re.M).group(1))


def ink(path: Path, page: int = 1) -> float:
    """Share of non-white pixels on a page: a drawn document, not a blank sheet."""
    from PIL import Image
    png = path.with_suffix(f".p{page}.png")
    subprocess.run(["pdftoppm", "-png", "-r", "40", "-f", str(page), "-l", str(page), "-singlefile", str(path), str(png.with_suffix(""))], check=True)
    im = Image.open(png).convert("L")
    return sum(1 for v in im.getdata() if v < 200) / (im.width * im.height)


def test_android_falls_back_when_print_engine_fails(browser, tmp_path):
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True)
    ctx.add_init_script("""
      window.__pdf = [];
      window.ZenvqoPDF = {
        save(id) { setTimeout(() => window.__zpdf(id, 'error', 'engine broke'), 50); },
        saveBytes(id, b64, name) { window.__pdf.push({id, b64, name}); setTimeout(() => window.__zpdf(id, 'saved', 'Downloads/zenvqo'), 50); },
        open() {}, share() {},
      };""")
    p = ctx.new_page()
    p.goto(HTML.as_uri())
    reply = ask(p, "generate pdf of 30 quiz questions")
    expect(reply.locator(".pdf-card")).to_contain_text("Saved to Downloads/zenvqo", timeout=20_000)
    got = p.evaluate("window.__pdf")[0]
    import base64
    out = tmp_path / got["name"]
    out.write_bytes(base64.b64decode(got["b64"]))
    assert out.read_bytes().startswith(b"%PDF") and pdf_pages(out) >= 3 and ink(out) > 0.01
    ctx.close()


def test_browser_downloads_real_pdf_file(page, tmp_path):
    page.goto("/")
    page.get_by_role("button", name="Create an account").click()
    page.get_by_label("Name").fill("Asha")
    page.get_by_label("Email").fill("pdf@example.com")
    page.get_by_label("Password").fill("correct horse battery")
    page.get_by_role("button", name="Create account").click()
    expect(page.get_by_role("heading", name="How can I help?")).to_be_visible()
    page.evaluate("() => { window.__printed = 0; window.print = () => { window.__printed++; }; }")
    with page.expect_download(timeout=30_000) as d:                                            # asked for → downloaded
        reply = ask(page, "make a pdf of 12 practice questions")
    dl = d.value
    assert dl.suggested_filename == "practice-quiz-12-questions.pdf"
    out = tmp_path / dl.suggested_filename
    dl.save_as(out)
    info = subprocess.run(["pdfinfo", str(out)], capture_output=True, text=True, check=True).stdout
    assert "Practice Quiz (12 questions)" in info and "A4" in info and pdf_pages(out) >= 1
    assert ink(out) > 0.01                                                                     # math fonts + text drawn
    first_page_png(out, SHOTS / "pdf-browser-download-page1.png")
    card = reply.locator(".pdf-card")
    expect(card).to_contain_text("Downloaded")
    with page.expect_download():
        card.get_by_role("button", name="Download again").click()
    card.get_by_role("button", name="Print").click()                                           # sharper text via print
    assert page.evaluate("window.__printed") == 1
    page.emulate_media(media="print")
    printed = tmp_path / "browser.pdf"
    page.pdf(path=str(printed), prefer_css_page_size=True, print_background=True)
    text = pdf_text(printed)
    assert "Practice Quiz (12 questions)" in text and "12." in text
    assert "New chat" not in text and "Message zenvqo" not in text                              # only the document prints
    page.emulate_media(media="screen")
    plain = ask(page, "tell me something")                                                     # any reply can be saved
    with page.expect_download():
        plain.get_by_role("button", name="Save as PDF").click()
    expect(plain.locator(".pdf-card")).to_contain_text("Downloaded")
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
