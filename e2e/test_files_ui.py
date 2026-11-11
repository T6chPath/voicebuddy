"""Every kind of file in the phone app build: documents are read on the phone (Word, Excel, PowerPoint, OpenDocument,
EPUB, RTF, ZIP, old .doc…), pictures inside them and snapshots of videos go to the AI as images, unusual picture formats
are converted (the Android side decodes what the WebView can't), and photos go to a model that can see."""
import base64
import io
import json
import re
from pathlib import Path

from PIL import Image
from playwright.sync_api import expect

from test_camera_pdf_read import HTML, wait_reply

FILES = Path(__file__).parent / "files"
CORS = {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS"}
JPEG = base64.b64encode((lambda b: (Image.new("RGB", (40, 30), (250, 200, 0)).save(b, "JPEG"), b.getvalue())[1])(io.BytesIO())).decode()


class Service:
    """An OpenAI-compatible service (like OpenRouter) with a text-only and a picture-reading model."""
    def __init__(self):
        self.requests = []

    def handle(self, route):
        r = route.request
        if r.method == "OPTIONS":
            return route.fulfill(status=204, headers=CORS)
        if r.url.endswith("/models"):
            return route.fulfill(status=200, headers=CORS, content_type="application/json", body=json.dumps({"data": [
                {"id": "deepseek/deepseek-v4-flash"}, {"id": "google/gemini-2.5-flash"}, {"id": "qwen/qwen3-coder"}]}))
        self.requests.append(json.loads(r.post_data))
        route.fulfill(status=200, headers=CORS, content_type="text/event-stream",
                      body='data: {"choices":[{"delta":{"content":"Read it."}}]}\n\ndata: [DONE]\n\n')


def app(browser, model="srv:google/gemini-2.5-flash", extra=""):
    svc = Service()
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    settings = {"server_url": "https://openrouter.ai/api/v1", "api_key": "k", "default_model": model}
    ctx.add_init_script(f"localStorage.setItem('zc.local.settings', {json.dumps(json.dumps(settings))});" + extra)
    ctx.route("https://openrouter.ai/api/v1/**", svc.handle)
    p = ctx.new_page()
    errors = []
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.goto(HTML.as_uri())
    expect(p.locator("#composer-input")).to_be_visible()
    return p, svc, errors


def ask_with(p, names, text, n=1):
    p.locator("form.composer input[type=file]").set_input_files([str(FILES / x) for x in names])
    expect(p.locator(".att-list.pending .chip")).to_have_count(len(names))
    expect(p.locator(".att-list.pending progress")).to_have_count(0, timeout=30_000)
    errs = p.locator(".att-list.pending .chip-error").all_inner_texts()
    assert not errs, errs
    p.locator("#composer-input").fill(text)
    p.get_by_role("button", name="Send message").click()
    wait_reply(p, n)


def last_user(req):
    m = [x for x in req["messages"] if x["role"] == "user"][-1]["content"]
    if isinstance(m, str):
        return m, []
    return "".join(x.get("text", "") for x in m if x["type"] == "text"), [x["image_url"]["url"] for x in m if x["type"] == "image_url"]


def test_office_documents_are_read(browser):
    p, svc, errors = app(browser)
    ask_with(p, ["report.docx", "sales.xlsx", "solar.pptx"], "summarise these")
    text, images = last_user(svc.requests[-1])
    assert "(Word document)" in text and "# Mango Farm Report" in text and "| May | 1250 |" in text
    assert "(Excel spreadsheet)" in text and "| Chai | 3 | 15 | =B2*C2 |" in text and "Shop opens at 7 am" in text
    assert "(PowerPoint presentation)" in text and "## Slide 1: Solar Energy" in text and "Speaker notes: Mention rooftop panels" in text
    assert len(images) == 2 and all(u.startswith("data:image/jpeg") for u in images), "the pictures inside the files"
    ask_with(p, ["report.odt", "report.doc", "book.epub"], "and these", 2)
    text, _ = last_user(svc.requests[-1])
    assert "(OpenDocument text)" in text and "(Word 97–2003 document)" in text and "1,250 kg of Alphonso" in text
    assert "(e-book (EPUB))" in text and "tiger slept under the banyan tree" in text
    ask_with(p, ["letter.rtf", "code.zip", "sales.ods"], "and these", 3)
    text, images = last_user(svc.requests[-1])
    assert "Dear Riya," in text and "--- app/main.py ---" in text and "Samosa" in text and len(images) == 1
    assert not errors, errors


def test_videos_and_any_picture_format(browser):
    stub = f"window.ZenvqoAssets = {{ toJpeg(b64, max) {{ window.__converted = (window.__converted || 0) + 1; return '{JPEG}'; }}, read() {{ return null; }} }};"
    p, svc, errors = app(browser, extra=stub)
    ask_with(p, ["clip.webm"], "what happens in this video?")
    text, frames = last_user(svc.requests[-1])
    assert re.search(r'Video "clip\.webm": 0:0[34] long, 160×120\. \d snapshots', text), text
    assert len(frames) >= 2
    colours = [Image.open(io.BytesIO(base64.b64decode(u.split(",", 1)[1]))).convert("RGB").getpixel((80, 60)) for u in frames]
    assert colours[0][0] > 200 and colours[-1][2] > 200, colours                                     # red first, blue last
    ask_with(p, ["photo.bmp", "scan.tiff", "fake.heic"], "what are these?", 2)
    _, images = last_user(svc.requests[-1])
    assert len(images) == 3 and all(u.startswith("data:image/jpeg") for u in images)
    assert p.evaluate("window.__converted") == 2, "TIFF and HEIC were decoded by the Android side"
    assert not errors, errors


def test_photos_go_to_a_model_that_can_see(browser):
    p, svc, errors = app(browser, model="srv:deepseek/deepseek-v4-flash")
    p.locator("#composer-input").fill("hi")
    p.get_by_role("button", name="Send message").click()
    wait_reply(p, 1)
    assert svc.requests[-1]["model"] == "deepseek/deepseek-v4-flash"
    ask_with(p, ["red.jpg"], "what colour is this?", 2)
    req = svc.requests[-1]
    assert req["model"] == "google/gemini-2.5-flash", "switched to the service's best picture-reading model"
    assert last_user(req)[1], "the photo was sent"
    expect(p.locator("article.msg-assistant").last.locator(".msg-head")).to_contain_text("gemini-2.5-flash")
    p.locator("#composer-input").fill("thanks")
    p.get_by_role("button", name="Send message").click()
    wait_reply(p, 3)
    assert svc.requests[-1]["model"] == "google/gemini-2.5-flash"          # the chat still has the photo in it
    assert not errors, errors


def test_file_cards_preview_drop_and_audio(browser):
    p, svc, errors = app(browser, model="srv:deepseek/deepseek-v4-flash")
    p.locator("form.composer input[type=file]").set_input_files([str(FILES / x) for x in ["report.docx", "sales.xlsx", "red.jpg", "tone.mp3"]])
    row = p.locator(".att-list.pending")
    expect(row.locator(".fc-progress, progress")).to_have_count(0, timeout=30_000)
    expect(row.locator(".file-card")).to_have_count(4)
    expect(row.locator(".file-card", has_text="report.docx")).to_contain_text("Document")
    expect(row.locator(".file-card", has_text="sales.xlsx")).to_contain_text("Spreadsheet")
    expect(row.locator(".file-card", has_text="tone.mp3")).to_contain_text("Audio")
    expect(row.locator(".fc-photo img")).to_be_visible()                                         # the photo as a thumbnail
    p.get_by_role("button", name="Remove sales.xlsx").click()
    expect(row.locator(".file-card")).to_have_count(3)
    p.locator("#composer-input").fill("what's in these?")
    p.get_by_role("button", name="Send message").click()
    wait_reply(p, 1)
    req = svc.requests[-1]
    assert req["model"] == "google/gemini-2.5-flash", "a model that can see and hear"
    parts = [x for x in req["messages"] if x["role"] == "user"][-1]["content"]
    audio = [x for x in parts if x["type"] == "input_audio"]
    assert len(audio) == 1 and audio[0]["input_audio"]["format"] == "wav"
    wav = base64.b64decode(audio[0]["input_audio"]["data"])
    assert wav[:4] == b"RIFF" and wav[8:12] == b"WAVE" and 55_000 < len(wav) < 75_000           # 2 s of 16 kHz mono
    assert 'Audio "tone.mp3", 0:02 long' in parts[0]["text"]
    # the sent file opens: what the AI read from it
    user = p.locator("article.msg-user").last
    user.get_by_role("button", name="Open report.docx").click()
    dlg = p.get_by_role("dialog", name="report.docx")
    expect(dlg).to_contain_text("Mango Farm Report")
    expect(dlg).to_contain_text("Document")
    dlg.get_by_role("button", name="Done").click()
    # files dropped anywhere on the chat
    data = base64.b64encode((FILES / "letter.rtf").read_bytes()).decode()
    dt = p.evaluate_handle(f"""() => {{ const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(atob("{data}"), c => c.charCodeAt(0))], "letter.rtf", {{ type: "application/rtf" }})); return dt; }}""")
    p.dispatch_event("main.chat", "dragenter", {"dataTransfer": dt})
    expect(p.locator(".drop-overlay")).to_be_visible()
    p.dispatch_event("main.chat", "drop", {"dataTransfer": dt})
    expect(p.locator(".drop-overlay")).to_have_count(0)
    expect(p.locator(".att-list.pending .file-card")).to_contain_text("letter.rtf")
    assert not errors, errors
