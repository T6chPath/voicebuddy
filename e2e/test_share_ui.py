"""Share → zenvqo from WhatsApp, Gallery, Files… (like ChatGPT), in the phone app build: the Android side copies what
was shared (stand-in here: window.ZenvqoShare); the app opens a new chat with the files and text in the message box."""
import base64
import json
from pathlib import Path

from playwright.sync_api import expect

from test_camera_pdf_read import FakeAI, open_app, wait_reply

FILES = Path(__file__).parent / "files"


def bridge(files, text):
    items, blobs = [], {}
    for i, (name, mime) in enumerate(files):
        data = (FILES / name).read_bytes()
        items.append({"id": str(i + 1), "name": name.replace("red.jpg", "IMG-20261111-WA0007.jpg"), "mime": mime, "size": len(data)})
        blobs[str(i + 1)] = base64.b64encode(data).decode()
    return f"""
window.__shareCalls = [];
(() => {{
  const blobs = {json.dumps(blobs)};
  let pending = {json.dumps({"files": items, "text": text})};
  window.ZenvqoShare = {{
    pending() {{ return window.__shareReady ? JSON.stringify(pending) : '{{"busy":true}}'; }},
    read(id, off, len) {{ window.__shareCalls.push(['read', id, off, len]);
      const s = atob(blobs[id]).slice(off, off + len); return btoa(s); }},
    done() {{ window.__shareCalls.push(['done']); pending = {{files: [], text: ''}}; }},
  }};
}})();
"""


def test_shared_from_whatsapp_opens_a_new_chat_with_the_files(browser):
    ai = FakeAI("ok")
    p, errors = open_app(browser, ai, bridge([("red.jpg", "image/jpeg"), ("report.docx", "application/octet-stream")], "Check this report from Riya"))
    p.locator("#composer-input").fill("hello")
    p.locator("#composer-input").press("Enter")
    wait_reply(p, 1)                                                                   # in the middle of a chat
    p.evaluate("window.__shareReady = true; window.__zshare()")                        # Android: "copied, here it is"
    expect(p.locator("article.msg-user")).to_have_count(0)                              # a new chat
    cards = p.locator(".att-list.pending .file-card")
    expect(cards).to_have_count(2)
    expect(cards.nth(1)).to_contain_text("report.docx")
    expect(cards.nth(1)).to_contain_text("Document")
    expect(p.locator(".att-list.pending .fc-photo img")).to_be_visible()
    expect(p.locator("#composer-input")).to_have_value("Check this report from Riya")
    expect(p.locator(".att-list.pending progress")).to_have_count(0, timeout=20_000)
    assert ["done"] in p.evaluate("window.__shareCalls")
    p.get_by_role("button", name="Send message").click()
    wait_reply(p, 1)
    last = [m for m in ai.requests[-1]["messages"] if m["role"] == "user"][-1]["content"]
    flat = json.dumps(last)
    assert "Mango Farm Report" in flat and "image_url" in flat and "Check this report from Riya" in flat
    assert not errors, errors


def test_shared_while_the_app_starts(browser):
    ai = FakeAI("ok")
    p, errors = open_app(browser, ai, bridge([("letter.rtf", "application/rtf")], "") + "window.__shareReady = true;")
    expect(p.locator(".att-list.pending .file-card")).to_contain_text("letter.rtf")
    assert not errors, errors
