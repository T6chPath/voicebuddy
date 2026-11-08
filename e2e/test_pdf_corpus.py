"""Many kinds of PDF, read by the app exactly as the Android APK does (pdf.js + the data files from assets/pdfjs,
served through a stand-in for the window.ZenvqoAssets bridge). For each file the test checks what reaches the AI."""
import base64
from pathlib import Path

import pytest
from playwright.sync_api import expect

from pdf_corpus import build
from test_camera_pdf_read import FakeAI, open_app, user_parts, wait_reply

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "android" / "app" / "src" / "main" / "assets"
SHOTS = Path(__file__).parent / "screenshots"

BRIDGE = """window.ZenvqoAssets = { read(path) {
  const x = new XMLHttpRequest(); x.open("GET", "http://app-assets.test/" + path, false); x.send();
  return x.status === 200 ? x.responseText : null; } };"""


def serve_assets(route):
    path = route.request.url.split("app-assets.test/", 1)[1]
    f = (ASSETS / path).resolve()
    headers = {"access-control-allow-origin": "*"}
    if not str(f).startswith(str(ASSETS / "pdfjs")) or not f.is_file():
        return route.fulfill(status=404, headers=headers, body="")
    route.fulfill(status=200, headers=headers, content_type="text/plain", body=base64.b64encode(f.read_bytes()).decode())


@pytest.fixture(scope="module")
def corpus(browser, tmp_path_factory):
    out = tmp_path_factory.mktemp("corpus")
    return out, build(out, browser)


def app(browser, ai):
    p, errors = open_app(browser, ai, BRIDGE)
    p.context.route("http://app-assets.test/**", serve_assets)
    return p, errors


def attach(p, path, password=None, wrong_first=False):
    p.locator("form.composer input[type=file]").set_input_files(str(path))
    if password:
        dlg = p.get_by_role("dialog", name="This PDF is locked")
        expect(dlg).to_be_visible(timeout=20_000)
        if wrong_first:
            dlg.get_by_label("Password").fill("nope")
            dlg.get_by_role("button", name="Open PDF").click()
            expect(dlg.get_by_role("alert")).to_contain_text("That password is wrong")
        dlg.get_by_label("Password").fill(password)
        dlg.get_by_role("button", name="Open PDF").click()
    chip = p.locator(".att-list.pending .chip").last
    expect(chip.locator("progress")).to_have_count(0, timeout=60_000)
    return chip


CASES = ["scan-jpeg2000.pdf", "japanese-cid.pdf", "restricted.pdf", "mixed.pdf", "legacy-hindi-font.pdf", "damaged-xref.pdf",
         "junk-before-header.pdf", "download", "form-filled.pdf", "hindi-and-long.pdf"]


@pytest.mark.parametrize("name", CASES)
def test_reads_every_kind(browser, corpus, name):
    folder, cases = corpus
    expect_text, picture = cases[name]
    ai = FakeAI("Answer.")
    p, errors = app(browser, ai)
    chip = attach(p, folder / name)
    assert "chip-error" not in (chip.get_attribute("class") or ""), chip.inner_text()
    p.locator("#composer-input").fill("What does this PDF say?")
    p.locator("#composer-input").press("Enter")
    wait_reply(p, 1)
    text, images = user_parts(ai.requests[-1])
    assert expect_text in text, text[:1500]
    if picture:
        assert len(images) >= 1, text[:600]
        from test_camera_pdf_read import decode
        img = decode(images[0])
        dark = sum(1 for x in range(0, img.width, 5) for y in range(0, img.height, 5) if sum(img.getpixel((x, y))) < 200)
        assert dark > 50, f"page picture looks blank ({dark})"
    else:
        assert not images, f"{len(images)} unexpected pictures"
    if name == "hindi-and-long.pdf":
        assert "--- Page 60 ---" in text and "Fact 60: the code is 1060" in text
    if name == "mixed.pdf":
        assert "Page 2 is attached as picture" in text
    if name == "form-filled.pdf":
        assert "R-2047" in text and "[Form fields filled in]" in text
    assert not errors, errors


def test_password_pdf_asks_and_reads(browser, corpus):
    folder, cases = corpus
    ai = FakeAI("The code is 4471.")
    p, errors = app(browser, ai)
    attach(p, folder / "password-zen123.pdf", password="zen123", wrong_first=True)
    SHOTS.mkdir(exist_ok=True)
    p.locator("#composer-input").fill("What is the vault code?")
    p.locator("#composer-input").press("Enter")
    wait_reply(p, 1)
    text, _ = user_parts(ai.requests[-1])
    assert "The vault code is 4471" in text
    assert not errors, errors


def test_password_cancelled_says_so(browser, corpus):
    folder, _ = corpus
    p, errors = app(browser, FakeAI())
    p.locator("form.composer input[type=file]").set_input_files(str(folder / "password-zen123.pdf"))
    dlg = p.get_by_role("dialog", name="This PDF is locked")
    expect(dlg).to_be_visible(timeout=20_000)
    p.screenshot(path=str(SHOTS / "pdf-password.png"))
    dlg.get_by_role("button", name="Cancel").click()
    expect(p.locator(".chip-error")).to_contain_text("locked with a password", timeout=10_000)
    assert not errors, errors


@pytest.mark.parametrize("name", ["scan-jpeg2000.pdf", "legacy-hindi-font.pdf", "mixed.pdf"])
def test_older_webviews_without_wasm_simd(browser, corpus, name):
    """Android WebViews before Chrome 91 can't run pdf.js's WebAssembly decoders: the plain-JS ones must take over."""
    folder, cases = corpus
    ai = FakeAI("Answer.")
    p, errors = open_app(browser, ai, BRIDGE + "window.__zvqNoWasm = true; delete ArrayBuffer.prototype.transferToFixedLength;")
    p.context.route("http://app-assets.test/**", serve_assets)
    attach(p, folder / name)
    p.locator("#composer-input").fill("What does it say?")
    p.locator("#composer-input").press("Enter")
    wait_reply(p, 1)
    _, images = user_parts(ai.requests[-1])
    from test_camera_pdf_read import decode
    img = decode(images[0])
    dark = sum(1 for x in range(0, img.width, 5) for y in range(0, img.height, 5) if sum(img.getpixel((x, y))) < 200)
    assert dark > 50, f"page picture looks blank ({dark})"
    assert not errors, errors
