"""Standalone single-file app, opened from file:// (as on a laptop/phone) — no backend.
Build first:  cd frontend && node scripts/build-standalone.mjs"""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from playwright.sync_api import expect

ROOT = Path(__file__).resolve().parents[1]
HTML = ROOT / "frontend" / "dist-standalone" / "zenvqo-chat.html"
SHOTS = Path(__file__).resolve().parent / "screenshots"


class FakeLlama(BaseHTTPRequestHandler):
    """Mimics llama-server: /v1/models and streaming /v1/chat/completions, with CORS."""
    seen: list = []

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        body = json.dumps({"object": "list", "data": [{"id": "zenvqo-3b-q4_k_m.gguf", "object": "model"}]}).encode()
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeLlama.seen.append(req)
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for w in ["नमस्ते! ", "I am ", "**zenvqo** ", "on your laptop."]:
            self.wfile.write(f"data: {json.dumps({'choices': [{'delta': {'content': w}}]})}\n\n".encode())
            self.wfile.flush()
        self.wfile.write(b"data: [DONE]\n\n")

    def log_message(self, *a):
        pass


@pytest.fixture(scope="module")
def llama():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeLlama)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()
    srv.server_close()


@pytest.fixture
def app(browser):
    assert HTML.exists(), "run: cd frontend && node scripts/build-standalone.mjs"
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.on("dialog", lambda d: d.accept())
    pg.goto(HTML.as_uri())
    yield pg
    ctx.close()


def send(pg, text):
    pg._before = pg.locator("article.msg-assistant").count()
    box = pg.get_by_label("Message", exact=True)
    box.fill(text)
    box.press("Enter")


def done(pg):
    msgs = pg.locator("article.msg-assistant")
    expect(msgs).to_have_count(pg._before + 1, timeout=15000)
    expect(msgs.last).to_have_attribute("aria-busy", "false", timeout=15000)


def test_works_offline_without_login_and_persists(app):
    expect(app.get_by_role("heading", name="How can I help?")).to_be_visible()      # no login screen
    expect(app.get_by_role("button", name="Sign out")).to_have_count(0)
    send(app, "show me code and a table")
    done(app)
    reply = app.locator("article.msg-assistant").last
    expect(reply.locator(".code-block .code-lang")).to_have_text("python")
    expect(reply.locator("table")).to_be_visible()
    assert "#/c/cnv_" in app.url                                                    # hash routing on file://
    app.reload()
    expect(app.locator("article.msg")).to_have_count(2)                              # saved in IndexedDB
    expect(app.locator("nav .conv-title").first).to_have_text("show me code and a table")
    app.go_back()
    expect(app.get_by_role("heading", name="How can I help?")).to_be_visible()
    assert app.errors == []


def test_connects_to_llama_server_directly(app, llama):
    app.get_by_role("button", name="Settings").click()
    dlg = app.get_by_role("dialog", name="Settings")
    dlg.get_by_label("Model server address").fill(llama.replace("http://", ""))       # scheme optional
    dlg.get_by_role("button", name="Test connection").click()
    expect(dlg.locator(".conn-ok")).to_contain_text("zenvqo-3b-q4_k_m")
    dlg.get_by_label("Custom instructions").fill("Reply in Hinglish.")
    dlg.get_by_role("button", name="Save").click()
    expect(dlg.get_by_text("Saved", exact=True)).to_be_visible()
    app.keyboard.press("Escape")
    app.get_by_role("button", name="New chat").click()
    expect(app.get_by_label("Model")).to_have_value("srv:zenvqo-3b-q4_k_m.gguf")
    send(app, "who are you?")
    done(app)
    expect(app.locator("article.msg-assistant").last).to_contain_text("नमस्ते! I am zenvqo on your laptop.")
    req = FakeLlama.seen[-1]
    assert req["model"] == "zenvqo-3b-q4_k_m.gguf" and req["stream"] is True
    assert "Reply in Hinglish." in req["messages"][0]["content"]
    assert app.errors == []


def test_unreachable_server_and_file_attach(app, tmp_path):
    app.get_by_role("button", name="Settings").click()
    dlg = app.get_by_role("dialog", name="Settings")
    dlg.get_by_label("Model server address").fill("http://127.0.0.1:9")
    dlg.get_by_role("button", name="Test connection").click()
    expect(dlg.locator(".conn-err")).to_contain_text("Can't reach")
    app.keyboard.press("Escape")
    f = tmp_path / "list.md"
    f.write_text("# Groceries\nmangoes, atta")
    app.locator("input[type=file]").set_input_files(str(f))
    expect(app.locator(".att-list.pending .chip")).to_contain_text("list.md")
    send(app, "read my file")
    done(app)
    expect(app.locator("article.msg-assistant").last).to_contain_text("# Groceries")
    pdf = tmp_path / "a.pdf"
    pdf.write_bytes(b"%PDF-1.4 fake")
    app.locator("input[type=file]").set_input_files(str(pdf))
    expect(app.locator(".chip-error")).to_contain_text("PDFs need the zenvqo server app")


def test_mobile_layout_standalone(browser):
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    pg = ctx.new_page()
    pg.goto(HTML.as_uri())
    pg._before = 0
    send(pg, "code and a table please")
    done(pg)
    assert pg.evaluate("document.documentElement.scrollWidth - window.innerWidth") <= 0
    pg.screenshot(path=str(SHOTS / "standalone-mobile.png"))
    ctx.close()
