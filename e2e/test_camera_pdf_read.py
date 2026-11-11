"""Camera photos and PDF reading in the app (the standalone build the Android APK ships).

The camera is Chromium's fake camera playing a picture with text in it; the AI is a fake OpenAI-compatible server
(routed in the browser), so the tests check exactly what the app sends to the model: the photo itself, the PDF's
text page by page, and pictures of scanned pages."""
import base64
import io
import json
import re
from pathlib import Path

import pytest
from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import expect

ROOT = Path(__file__).resolve().parents[1]
HTML = ROOT / "frontend" / "dist-standalone" / "zenvqo-chat.html"
SHOTS = Path(__file__).parent / "screenshots"
API = "http://fake-ai.test/v1"
SETTINGS = {"server_url": API, "api_key": "test-key", "default_model": "srv:vision-1"}


def font(size):
    for f in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"):
        if Path(f).exists():
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


def picture(text, w=1280, h=720):
    im = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(im)
    d.ellipse((60, 60, 260, 260), fill=(220, 30, 30))
    d.text((320, 280), text, fill="black", font=font(96))
    return im


@pytest.fixture(scope="module")
def camera_browser(pw, tmp_path_factory):
    clip = tmp_path_factory.mktemp("cam") / "camera.mjpeg"
    buf = io.BytesIO()
    frame = picture("ZENVQO 42")
    for _ in range(30):
        frame.save(buf, "JPEG", quality=90)
    clip.write_bytes(buf.getvalue())
    b = pw.chromium.launch(args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
                                 f"--use-file-for-fake-video-capture={clip}"])
    yield b
    b.close()


class FakeAI:
    """OpenAI-compatible endpoints answered inside the browser; remembers every chat request."""

    def __init__(self, reply="Here is what I see."):
        self.requests, self.reply = [], reply

    def handle(self, route):
        req = route.request
        cors = {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS"}
        if req.method == "OPTIONS":
            return route.fulfill(status=204, headers=cors)
        if req.url.endswith("/models"):
            return route.fulfill(status=200, headers=cors, content_type="application/json", body=json.dumps({"data": [{"id": "vision-1"}]}))
        self.requests.append(json.loads(req.post_data))
        chunks = [{"choices": [{"delta": {"content": w}}]} for w in re.findall(r"\S+\s*|\s+", self.reply)]   # keeps line breaks
        body = "".join(f"data: {json.dumps(c)}\n\n" for c in chunks) + "data: [DONE]\n\n"
        route.fulfill(status=200, headers=cors, content_type="text/event-stream", body=body)


def open_app(browser, ai, init=""):
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    ctx.add_init_script(f"localStorage.setItem('zc.local.settings', {json.dumps(json.dumps(SETTINGS))});" + init)
    ctx.route(API + "/**", ai.handle)
    p = ctx.new_page()
    errors = []
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.goto(HTML.as_uri())
    expect(p.locator("#composer-input")).to_be_visible()
    return p, errors


def wait_reply(p, n):
    expect(p.locator("article.msg-assistant")).to_have_count(n, timeout=20_000)
    expect(p.locator("article.msg-assistant").last).to_have_attribute("aria-busy", "false", timeout=20_000)


def user_parts(req):
    """(text, [image data URLs]) of the last user message sent to the model."""
    msg = [m for m in req["messages"] if m["role"] == "user"][-1]
    if isinstance(msg["content"], str):
        return msg["content"], []
    text = "".join(x.get("text", "") for x in msg["content"] if x["type"] == "text")
    return text, [x["image_url"]["url"] for x in msg["content"] if x["type"] == "image_url"]


def decode(data_url):
    assert data_url.startswith("data:image/jpeg;base64,"), data_url[:40]
    return Image.open(io.BytesIO(base64.b64decode(data_url.split(",", 1)[1]))).convert("RGB")


def test_take_photo_and_ai_explains_it(camera_browser):
    ai = FakeAI("The photo shows a red circle and the words ZENVQO 42.")
    p, errors = open_app(camera_browser, ai)
    p.get_by_role("button", name="Add photos, files and more").click()
    p.get_by_role("menuitem", name="Take a photo").click()
    dialog = p.get_by_role("dialog", name="Take a photo")
    expect(dialog).to_be_visible()
    shutter = dialog.get_by_role("button", name="Take photo")
    expect(shutter).to_be_enabled(timeout=10_000)
    SHOTS.mkdir(exist_ok=True)
    p.wait_for_timeout(500)
    p.screenshot(path=str(SHOTS / "camera-live.png"))
    shutter.click()
    expect(dialog.get_by_role("img", name="The photo you took")).to_be_visible()
    dialog.get_by_role("button", name="Use photo").click()
    expect(dialog).to_be_hidden()
    chip = p.locator(".att-list.pending .chip")
    expect(chip).to_contain_text("photo-")
    expect(chip.locator("img.chip-thumb")).to_be_visible()
    expect(p.get_by_role("button", name="Send message")).to_be_enabled(timeout=5_000)
    p.locator("#composer-input").press("Enter")                     # no question typed → "explain everything"
    wait_reply(p, 1)
    p.screenshot(path=str(SHOTS / "camera-reply.png"))

    text, images = user_parts(ai.requests[-1])
    assert text.startswith("Explain everything in this image."), text
    assert len(images) == 1
    img = decode(images[0])
    assert img.size == (1280, 720)
    # the photo really is the camera picture: red circle top-left, dark text in the middle
    r, g, b = img.getpixel((160, 160))
    assert r > 180 and g < 90 and b < 90, (r, g, b)
    dark = sum(1 for x in range(320, 1200, 4) for y in range(280, 400, 4) if sum(img.getpixel((x, y))) < 150)
    assert dark > 200, dark
    system = ai.requests[-1]["messages"][0]["content"]
    assert "explain everything in it" in system and "all visible text" in system
    # the photo is shown in the chat, and the answer is there
    expect(p.locator("article.msg-user img").first).to_have_attribute("src", re.compile(r"^data:image/jpeg"))
    expect(p.locator("article.msg-assistant").last).to_contain_text("ZENVQO 42")
    assert not errors, errors


def test_camera_question_typed_and_retake(camera_browser):
    ai = FakeAI("It is a sign.")
    p, errors = open_app(camera_browser, ai)
    p.get_by_role("button", name="Add photos, files and more").click()
    p.get_by_role("menuitem", name="Take a photo").click()
    dialog = p.get_by_role("dialog", name="Take a photo")
    shutter = dialog.get_by_role("button", name="Take photo")
    expect(shutter).to_be_enabled(timeout=10_000)
    shutter.click()
    dialog.get_by_role("button", name="Retake").click()                     # back to the live camera
    expect(dialog.get_by_role("button", name="Take photo")).to_be_enabled(timeout=10_000)
    dialog.get_by_role("button", name="Take photo").click()
    dialog.get_by_role("button", name="Use photo").click()
    expect(p.get_by_role("button", name="Send message")).to_be_enabled(timeout=5_000)
    p.locator("#composer-input").fill("What number is written here?")
    p.locator("#composer-input").press("Enter")
    wait_reply(p, 1)
    text, images = user_parts(ai.requests[-1])
    assert text.startswith("What number is written here?") and len(images) == 1
    assert not errors, errors


def test_camera_permission_denied_shows_help(browser):
    deny = "navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));"
    p, errors = open_app(browser, FakeAI(), deny)
    p.get_by_role("button", name="Add photos, files and more").click()
    p.get_by_role("menuitem", name="Take a photo").click()
    dialog = p.get_by_role("dialog", name="Take a photo")
    expect(dialog.get_by_role("alert")).to_contain_text("Camera permission was denied")
    expect(dialog.get_by_role("button", name="Choose a photo instead")).to_be_visible()
    p.keyboard.press("Escape")
    expect(dialog).to_be_hidden()
    assert not errors, errors


def make_text_pdf(browser, path):
    p = browser.new_page()
    p.set_content("""<style>@page{size:A4;margin:20mm} body{font:14pt sans-serif} .b{break-before:page}</style>
      <h1>Atlantis Handbook</h1><p>The capital of Atlantis is Coralia. It has 12 bridges.</p>
      <div class="b"><h2>Chapter 2</h2><p>The national fruit of Atlantis is the sea-mango, harvested in March.</p></div>""")
    p.pdf(path=str(path), format="A4")
    p.close()


def attach(p, path):
    p.locator("form.composer input[type=file]").set_input_files(str(path))
    chip = p.locator(".att-list.pending .chip").last
    expect(chip).to_contain_text(Path(path).name)
    expect(p.get_by_role("button", name="Send message")).to_be_enabled(timeout=30_000)
    return chip


def test_pdf_questions_answered_from_its_pages(browser, tmp_path):
    pdf = tmp_path / "atlantis.pdf"
    make_text_pdf(browser, pdf)
    ai = FakeAI("Coralia is the capital (Page 1).")
    p, errors = open_app(browser, ai)
    attach(p, pdf)
    p.locator("#composer-input").fill("What is the capital of Atlantis?")
    p.locator("#composer-input").press("Enter")
    wait_reply(p, 1)
    text, images = user_parts(ai.requests[-1])
    assert '<attached_file name="atlantis.pdf" pages="2">' in text
    assert "--- Page 1 ---" in text and "The capital of Atlantis is Coralia" in text
    assert "--- Page 2 ---" in text and "sea-mango" in text and not images
    assert "mention the page" in ai.requests[-1]["messages"][0]["content"]

    # a long conversation later, the PDF is still there for follow-up questions
    p.locator("#composer-input").fill("Note: " + "lorem ipsum " * 2200)
    p.locator("#composer-input").press("Enter")
    wait_reply(p, 2)
    p.locator("#composer-input").fill("When is the national fruit harvested?")
    p.locator("#composer-input").press("Enter")
    wait_reply(p, 3)
    req = ai.requests[-1]
    kept = json.dumps(req["messages"])
    assert "harvested in March" in kept
    assert all("atlantis.pdf" not in json.dumps(m) for m in req["messages"][1:]), "older turn should have been dropped"
    assert "Files the user attached earlier" in req["messages"][0]["content"]
    p.screenshot(path=str(SHOTS / "pdf-read-chat.png"))
    assert not errors, errors


def test_scanned_pdf_pages_go_as_pictures(browser, tmp_path):
    pdf = tmp_path / "scan.pdf"
    picture("RECEIPT 789", 1240, 1754).save(pdf, "PDF", resolution=150)
    ai = FakeAI("The receipt number is 789.")
    p, errors = open_app(browser, ai)
    attach(p, pdf)
    p.locator("#composer-input").press("Enter")                       # → "Summarise this PDF."
    wait_reply(p, 1)
    text, images = user_parts(ai.requests[-1])
    assert text.startswith("Summarise this PDF.") and "It is scanned: pictures of the pages are attached" in text
    assert len(images) == 1
    page = decode(images[0])
    assert max(page.size) >= 1200
    dark = sum(1 for x in range(0, page.width, 6) for y in range(0, page.height, 6) if sum(page.getpixel((x, y))) < 150)
    assert dark > 100, dark
    assert not errors, errors


def test_demo_model_says_how_to_get_photos_explained(camera_browser):
    p, errors = open_app(camera_browser, FakeAI(), "localStorage.setItem('zc.local.settings', JSON.stringify({default_model: 'echo'}));")
    p.get_by_role("button", name="Add photos, files and more").click()
    p.get_by_role("menuitem", name="Take a photo").click()
    dialog = p.get_by_role("dialog", name="Take a photo")
    expect(dialog.get_by_role("button", name="Take photo")).to_be_enabled(timeout=10_000)
    dialog.get_by_role("button", name="Take photo").click()
    dialog.get_by_role("button", name="Use photo").click()
    expect(p.get_by_role("button", name="Send message")).to_be_enabled(timeout=5_000)
    p.locator("#composer-input").press("Enter")
    expect(p.locator("span").filter(has_text="The offline demo can't see pictures")).to_be_visible(timeout=10_000)
    assert not errors, errors
