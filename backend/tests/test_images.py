"""Image tools end to end through the real chat/API routes.

A deterministic in-process provider stands in for the diffusion model here (no GPU, no 2.6 GB download), so these
tests check routing, tool calls, storage, multi-turn references, limits, safety and errors. Hosted providers are
checked against fake HTTP servers speaking the documented Gemini / OpenAI formats. The real local model is exercised
by tests/test_images_real.py (run in CI with the model downloaded)."""
import base64
import io
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from conftest import client_for, make_settings, new_conv, parse_sse, register, send
from PIL import Image, ImageDraw

from app.config import ModelConfig
from app.images.base import ImageError, Produced
from app.main import create_app


class FakeProvider:
    """Draws a labelled picture so tests can see which op/prompt/source produced it."""

    def __init__(self, name="local", ops=None, fail_with: ImageError | None = None):
        self.name, self.model = name, "fake-diffusion"
        self.ops = set(ops or ["generate", "edit", "variations", "style", "inpaint", "remove_object",
                               "remove_background", "replace_background"])
        self.negative_prompt, self.seed, self.unavailable_reason = True, True, None
        self.calls, self.fail_with = [], fail_with

    async def run(self, req, inp, progress):
        self.calls.append((req, inp))
        if self.fail_with:
            raise self.fail_with
        out = []
        for i in range(req.n):
            progress((i + 0.5) / req.n, f"Generating image {i + 1}")
            if req.op == "remove_background":
                im = inp.source.convert("RGBA")
                im.putalpha(0)
            else:
                w, h = (512, 288) if req.aspect_ratio == "16:9" else (inp.source.size if inp.source else (256, 256))
                im = Image.new("RGB", (w, h), (20 + 40 * i, 60, 120))
                ImageDraw.Draw(im).text((8, 8), f"{req.op}:{req.prompt[:30]}", fill="white")
            out.append(Produced(im, (req.seed or 7) + i, ["fake note"] if i == 0 else []))
        return out


def png(color=(200, 50, 50), size=(64, 48), mode="RGB") -> bytes:
    b = io.BytesIO()
    Image.new(mode, size, color).save(b, "PNG")
    return b.getvalue()


def make(tmp_path, providers, **kw):
    app = create_app(make_settings(tmp_path, **kw))
    app.state.images.providers = providers
    c = client_for(app)
    register(c)
    return app, c


def events(ev, name):
    return [d for e, d in ev if e == name]


def text_of(ev):
    return "".join(d["text"] for d in events(ev, "delta"))


@pytest.fixture
def fake():
    return FakeProvider()


@pytest.fixture
def ctx(tmp_path, fake):
    return make(tmp_path, [fake])


def test_generate_from_chat_text(ctx, fake):
    app, c = ctx
    cid = new_conv(c)
    code, ev = send(c, cid, "Generate an image of a futuristic city at sunset")
    assert code == 200
    tools = events(ev, "tool")
    assert tools[0]["status"] == "running" and tools[0]["name"] == "generate_image" and tools[0]["op"] == "generate"
    assert events(ev, "progress") and tools[-1]["status"] == "done"
    imgs = events(ev, "image")
    assert len(imgs) == 1
    att = imgs[0]["attachment"]
    assert att["generated"] and att["kind"] == "image" and att["mime"] == "image/png" and att["meta"]["prompt"] == "a futuristic city at sunset"
    assert ev[-1][0] == "done"
    assert "futuristic city at sunset" in text_of(ev)
    r = c.get(f"/api/files/{att['id']}")                                   # real, viewable PNG
    assert r.status_code == 200 and r.headers["content-type"] == "image/png" and r.headers["content-disposition"].startswith("inline")
    im = Image.open(io.BytesIO(r.content))
    assert im.size == (256, 256) and "AI-generated" in im.info.get("Comment", "")
    assert c.get(f"/api/files/{att['id']}?download=1").headers["content-disposition"].startswith("attachment")
    msgs = c.get(f"/api/conversations/{cid}").json()["messages"]
    assert msgs[-1]["attachments"][0]["id"] == att["id"] and msgs[-1]["status"] == "complete"   # survives reload
    assert fake.calls[0][0].prompt == "a futuristic city at sunset"


def test_multiturn_edit_uses_previous_image(ctx, fake):
    app, c = ctx
    cid = new_conv(c)
    _, ev = send(c, cid, "draw a red fox in a forest, anime, 16:9")
    first = events(ev, "image")[0]["attachment"]
    req = fake.calls[0][0]
    assert req.style == "anime" and req.aspect_ratio == "16:9"
    _, ev = send(c, cid, "make it night time")
    assert events(ev, "tool")[0]["op"] == "edit"
    req, inp = fake.calls[1]
    assert req.source_id == first["id"] and req.prompt == "night time"
    assert req.context_prompt == "red fox in a forest" and inp.source.size == (512, 288)
    second = events(ev, "image")[0]["attachment"]
    assert second["meta"]["parent_id"] == first["id"]
    _, ev = send(c, cid, "give me 3 variations of image 1")
    req, _ = fake.calls[2]
    assert req.op == "variations" and req.n == 3 and req.source_id == first["id"]
    assert len(events(ev, "image")) == 3


def test_upload_and_remove_background(ctx, fake):
    app, c = ctx
    cid = new_conv(c)
    fid = c.post("/api/files", files={"file": ("me.png", png(), "image/png")}).json()["id"]
    code, ev = send(c, cid, "Remove the background", file_ids=[fid])      # echo model has no vision: allowed for editing
    assert code == 200
    req, inp = fake.calls[0]
    assert req.op == "remove_background" and req.source_id == fid and inp.source.size == (64, 48)
    att = events(ev, "image")[0]["attachment"]
    out = Image.open(io.BytesIO(c.get(f"/api/files/{att['id']}").content))
    assert out.mode == "RGBA" and out.getextrema()[3] == (0, 0)          # transparency kept in the PNG


def test_replace_background_and_clarify(ctx, fake):
    app, c = ctx
    cid = new_conv(c)
    fid = c.post("/api/files", files={"file": ("me.png", png(), "image/png")}).json()["id"]
    _, ev = send(c, cid, "change the background to a beach at sunset", file_ids=[fid])
    assert fake.calls[0][0].op == "replace_background" and fake.calls[0][0].background == "beach at sunset"
    _, ev = send(c, cid, "change the background")
    assert "What should the new background be" in text_of(ev) and len(fake.calls) == 1


def test_ui_actions_mask_inpaint_and_options(ctx, fake):
    app, c = ctx
    cid = new_conv(c)
    src = c.post("/api/files", files={"file": ("p.png", png(size=(80, 60)), "image/png")}).json()["id"]
    m = Image.new("L", (80, 60), 0)
    ImageDraw.Draw(m).rectangle((10, 10, 30, 30), fill=255)
    b = io.BytesIO()
    m.save(b, "PNG")
    mask = c.post("/api/files", files={"file": ("mask.png", b.getvalue(), "image/png")}).json()["id"]
    code, ev = send(c, cid, "replace with a vase of flowers", image={"op": "inpaint", "source_id": src, "mask_id": mask,
                                                                       "seed": 99, "output_format": "webp"})
    assert code == 200, ev
    req, inp = fake.calls[0]
    assert req.op == "inpaint" and req.prompt == "replace with a vase of flowers" and req.seed == 99
    assert inp.mask.size == (80, 60) and inp.mask.getbbox() == (10, 10, 31, 31)
    att = events(ev, "image")[0]["attachment"]
    assert att["mime"] == "image/webp" and att["meta"]["seed"] == 99
    _, ev = send(c, cid, "a lighthouse", image={"op": "generate", "style": "cinematic", "aspect_ratio": "16:9",
                                                 "n": 2, "negative_prompt": "people"})
    req, _ = fake.calls[1]
    assert (req.style, req.aspect_ratio, req.n, req.negative_prompt) == ("cinematic", "16:9", 2, "people")
    assert len(events(ev, "image")) == 2


def test_regenerate_makes_a_new_image(ctx, fake):
    app, c = ctx
    cid = new_conv(c)
    send(c, cid, "generate an image of a teapot", image={"seed": 5, "style": "3d"})
    r = c.post(f"/api/conversations/{cid}/regenerate")
    ev = parse_sse(r.text)
    req = fake.calls[1][0]
    assert req.op == "generate" and req.style == "3d" and req.seed is None and len(events(ev, "image")) == 1
    assert len([m for m in c.get(f"/api/conversations/{cid}").json()["messages"] if m["role"] == "assistant"]) == 1


def test_normal_chat_still_works(ctx, fake):
    app, c = ctx
    cid = new_conv(c)
    _, ev = send(c, cid, "what is the area of india? show me code and a table")
    assert not events(ev, "tool") and "You said" in text_of(ev) and not fake.calls


def test_safety_blocks_before_provider(ctx, fake):
    app, c = ctx
    cid = new_conv(c)
    _, ev = send(c, cid, "generate a nude photo of a woman")
    assert "can't create sexual" in text_of(ev) and ev[-1][0] == "done" and not fake.calls
    fid = c.post("/api/files", files={"file": ("me.png", png(), "image/png")}).json()["id"]
    _, ev = send(c, cid, "make her naked", file_ids=[fid], image={"op": "edit"})
    assert "can't remove clothing" in text_of(ev) and not fake.calls


def test_unavailable_explains_real_reason(tmp_path):
    app, c = make(tmp_path, [])
    cid = new_conv(c)
    _, ev = send(c, cid, "Generate an image of a futuristic city at sunset")
    t = text_of(ev)
    assert "can't make or edit images" in t and "ZC_IMAGE_PROVIDERS=none" in t and "text-only" not in t
    assert c.get("/api/images/capabilities").json()["available"] is False


def test_local_provider_reports_missing_packages(tmp_path):
    from app.images.local import LocalProvider
    p = LocalProvider()                     # reports what's missing when the image packages aren't installed
    if p.ops:
        pytest.skip("image packages are installed here")
    app, c = make(tmp_path, [p])
    cap = c.get("/api/images/capabilities").json()
    assert not cap["available"] and "requirements-images.txt" in cap["reason"]


def test_provider_fallback_and_errors(tmp_path):
    bad = FakeProvider("gemini", fail_with=ImageError("no quota", "quota"))
    good = FakeProvider("local")
    app, c = make(tmp_path, [bad, good])
    cid = new_conv(c)
    _, ev = send(c, cid, "generate an image of a boat")
    assert len(events(ev, "image")) == 1 and "Gemini failed (no quota)" in text_of(ev)
    only_bad = FakeProvider("gemini", fail_with=ImageError("Gemini is down", "provider_error", retryable=True))
    app, c = make(tmp_path / "b", [only_bad])
    cid = new_conv(c)
    _, ev = send(c, cid, "generate an image of a boat")
    assert ev[-1][0] == "error" and ev[-1][1]["message"] == "Gemini is down" and ev[-1][1]["retryable"]
    assert events(ev, "tool")[-1]["status"] == "failed"


def test_unsupported_op_and_missing_source(tmp_path):
    gen_only = FakeProvider("gemini", ops=["generate"])
    app, c = make(tmp_path, [gen_only])
    cid = new_conv(c)
    fid = c.post("/api/files", files={"file": ("me.png", png(), "image/png")}).json()["id"]
    _, ev = send(c, cid, "remove the background", file_ids=[fid])
    assert ev[-1][0] == "error" and "can remove background" in ev[-1][1]["message"]
    _, ev = send(c, cid, "x", image={"op": "variations"})
    cid2 = new_conv(c)
    _, ev = send(c, cid2, "variations please", image={"op": "variations"})
    assert ev[-1][0] == "error" and ev[-1][1]["code"] == "no_source"


def test_rate_limit_and_cross_user(tmp_path, monkeypatch):
    monkeypatch.setenv("ZC_IMAGE_RATE", "2/3600")
    fake = FakeProvider()
    app, c = make(tmp_path, [fake])
    cid = new_conv(c)
    for _ in range(2):
        send(c, cid, "generate an image of a cat")
    _, ev = send(c, cid, "generate an image of a cat")
    assert ev[-1][0] == "error" and ev[-1][1]["code"] == "rate_limited"
    att = c.get(f"/api/conversations/{cid}").json()["messages"][1]["attachments"][0]
    other = client_for(app)
    register(other, "bob@example.com", "Bob")
    ocid = new_conv(other)
    code, body = send(other, ocid, "make it blue", image={"op": "edit", "source_id": att["id"]})
    assert code == 400 and "not found" in body["detail"]
    assert other.get(f"/api/files/{att['id']}").status_code == 404


def test_corrupt_upload_is_rejected(ctx, fake):
    app, c = ctx
    cid = new_conv(c)
    fid = c.post("/api/files", files={"file": ("x.png", b"\x89PNG\r\n\x1a\n" + b"\0" * 64, "image/png")}).json()["id"]
    code, ev = send(c, cid, "remove the background", file_ids=[fid])
    assert code == 200 and ev[-1][0] == "error" and "couldn't be read" in ev[-1][1]["message"] and not fake.calls


def test_direct_images_api(ctx, fake):
    app, c = ctx
    r = c.post("/api/images", json={"op": "generate", "prompt": "a red bicycle", "n": 2, "aspect_ratio": "16:9"})
    assert r.status_code == 200 and len(r.json()["images"]) == 2
    assert c.post("/api/images", json={"op": "generate", "prompt": "nude"}).status_code == 422
    cap = c.get("/api/images/capabilities").json()
    assert cap["available"] and "generate" in cap["ops"] and "photorealistic" in cap["styles"]


# ---------------- LLM tool calling ----------------

class ToolLLM(BaseHTTPRequestHandler):
    """OpenAI-compatible chat server that answers the first turn with a streamed generate_image tool call."""
    seen: list = []
    reject_tools = False

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        ToolLLM.seen.append(body)
        if body.get("tools") and ToolLLM.reject_tools:
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b'{"error":"tools not supported"}')
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        if body.get("tools"):
            args = json.dumps({"prompt": "a majestic lion on a rock at golden hour", "style": "photorealistic", "aspect_ratio": "3:2"})
            chunks = [{"tool_calls": [{"index": 0, "id": "call_9", "type": "function", "function": {"name": "generate_image", "arguments": ""}}]},
                      {"tool_calls": [{"index": 0, "function": {"arguments": args[:20]}}]},
                      {"tool_calls": [{"index": 0, "function": {"arguments": args[20:]}}]}]
        elif body["messages"][-1]["role"] == "tool":
            chunks = [{"content": "Ye lijiye — "}, {"content": "sher ki photo."}]
        else:
            chunks = [{"content": "plain answer"}]
        for ch in chunks:
            self.wfile.write(f"data: {json.dumps({'choices': [{'delta': ch}]})}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")

    def log_message(self, *a):
        pass


@pytest.fixture
def llm():
    srv = ThreadingHTTPServer(("127.0.0.1", 0), ToolLLM)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    ToolLLM.seen, ToolLLM.reject_tools = [], False
    yield f"http://127.0.0.1:{srv.server_address[1]}/v1"
    srv.shutdown()
    srv.server_close()


def test_llm_tool_call_drives_generation(tmp_path, llm):
    fake = FakeProvider()
    app, c = make(tmp_path, [fake], models=[ModelConfig("m", "Model", "openai", llm, "x", tools=True)])
    cid = new_conv(c, "m")
    _, ev = send(c, cid, "mujhe ek sher ki tasveer dikhao jo chattan pe baitha ho")   # rules can't parse this → model decides
    first = ToolLLM.seen[0]
    assert [t["function"]["name"] for t in first["tools"]] == ["generate_image", "edit_image"]
    assert "generate_image" in first["messages"][0]["content"] and "text-only" in first["messages"][0]["content"]
    req = fake.calls[0][0]
    assert (req.prompt, req.style, req.aspect_ratio) == ("a majestic lion on a rock at golden hour", "photorealistic", "3:2")
    assert events(ev, "tool")[0]["args"]["via"] == "tool" and len(events(ev, "image")) == 1
    follow = ToolLLM.seen[1]["messages"]
    assert follow[-2]["tool_calls"][0]["id"] == "call_9" and follow[-1]["role"] == "tool"
    assert json.loads(follow[-1]["content"])["images"][0]["ref"] == "#1"
    assert text_of(ev) == "Ye lijiye — sher ki photo."
    _, ev = send(c, cid, "thanks!")                                                    # history carries the image note
    assert "[Image #1 generated (256\\u00d7256): a majestic lion" in json.dumps(ToolLLM.seen[-1]["messages"])


def test_tools_unsupported_falls_back_to_rules(tmp_path, llm):
    ToolLLM.reject_tools = True
    fake = FakeProvider()
    app, c = make(tmp_path, [fake], models=[ModelConfig("m", "Model", "openai", llm, "x", tools=True)], image_router="llm")
    cid = new_conv(c, "m")
    _, ev = send(c, cid, "Generate an image of a futuristic city at sunset")
    assert fake.calls and fake.calls[0][0].prompt == "a futuristic city at sunset" and ev[-1][0] == "done"


# ---------------- hosted providers' wire format ----------------

class FakeHosted(BaseHTTPRequestHandler):
    seen: list = []
    mode = "ok"

    def _send(self, code, obj):
        b = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def do_POST(self):
        raw = self.rfile.read(int(self.headers["Content-Length"]))
        FakeHosted.seen.append((self.path, dict(self.headers), raw))
        img = base64.b64encode(png((10, 200, 10), (96, 64))).decode()
        if FakeHosted.mode == "quota":
            return self._send(429, {"error": {"code": 429, "message": "Quota exceeded ... limit: 0, model: gemini-2.5-flash-image",
                                              "status": "RESOURCE_EXHAUSTED"}})
        if FakeHosted.mode == "blocked":
            return self._send(200, {"candidates": [{"finishReason": "IMAGE_SAFETY", "content": {"parts": []}}]})
        if FakeHosted.mode == "moderation":
            return self._send(400, {"error": {"code": "moderation_blocked", "message": "Your request was rejected by the safety system."}})
        if ":generateContent" in self.path:
            return self._send(200, {"candidates": [{"content": {"parts": [{"text": "Here you go"},
                                                                           {"inlineData": {"mimeType": "image/png", "data": img}}]}}]})
        return self._send(200, {"created": 1, "data": [{"b64_json": img}]})

    def log_message(self, *a):
        pass


@pytest.fixture
def hosted(monkeypatch):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeHosted)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    FakeHosted.seen, FakeHosted.mode = [], "ok"
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    monkeypatch.setenv("GEMINI_API_KEY", "g-key")
    monkeypatch.setenv("ZC_GEMINI_BASE_URL", base)
    monkeypatch.setenv("OPENAI_API_KEY", "o-key")
    monkeypatch.setenv("ZC_OPENAI_BASE_URL", base + "/v1")
    yield base
    srv.shutdown()
    srv.server_close()


def test_gemini_request_format_and_errors(tmp_path, hosted):
    from app.images.hosted import GeminiProvider
    app, c = make(tmp_path, [GeminiProvider()])
    cid = new_conv(c)
    _, ev = send(c, cid, "generate an image of a parrot, 16:9, seed 3")
    path, headers, raw = FakeHosted.seen[0]
    body = json.loads(raw)
    assert path == "/v1beta/models/gemini-2.5-flash-image:generateContent" and headers["x-goog-api-key"] == "g-key"
    assert body["generationConfig"] == {"responseModalities": ["TEXT", "IMAGE"], "imageConfig": {"aspectRatio": "16:9"}}
    assert "a parrot" in body["contents"][0]["parts"][0]["text"]
    att = events(ev, "image")[0]["attachment"]
    assert (att["width"], att["height"]) == (96, 64) and "doesn't support seeds" in text_of(ev)
    _, ev = send(c, cid, "make it purple")                                            # edit sends the image back
    parts = json.loads(FakeHosted.seen[1][2])["contents"][0]["parts"]
    assert parts[1]["inlineData"]["mimeType"] == "image/png" and "imageConfig" not in json.loads(FakeHosted.seen[1][2])["generationConfig"]
    FakeHosted.mode = "quota"
    _, ev = send(c, cid, "generate an image of a parrot")
    assert ev[-1][0] == "error" and "paid tier" in ev[-1][1]["message"] and len(FakeHosted.seen) == 3   # no retry on limit 0
    FakeHosted.mode = "blocked"
    _, ev = send(c, cid, "generate an image of a parrot")
    assert "declined" in text_of(ev) and ev[-1][0] == "done"


def test_openai_request_format(tmp_path, hosted):
    from app.images.hosted import OpenAIImageProvider
    app, c = make(tmp_path, [OpenAIImageProvider()])
    cid = new_conv(c)
    _, ev = send(c, cid, "generate an image of a cabin, landscape")
    path, headers, raw = FakeHosted.seen[0]
    body = json.loads(raw)
    assert path == "/v1/images/generations" and headers["Authorization"] == "Bearer o-key"
    assert body["model"] == "gpt-image-1" and body["size"] == "1536x1024" and body["n"] == 1
    src = events(ev, "image")[0]["attachment"]["id"]
    m = Image.new("L", (96, 64), 0)
    ImageDraw.Draw(m).rectangle((0, 0, 20, 20), fill=255)
    b = io.BytesIO()
    m.save(b, "PNG")
    mask = c.post("/api/files", files={"file": ("mask.png", b.getvalue(), "image/png")}).json()["id"]
    send(c, cid, "a small red door", image={"op": "inpaint", "source_id": src, "mask_id": mask})
    path, headers, raw = FakeHosted.seen[1]
    assert path == "/v1/images/edits" and headers["Content-Type"].startswith("multipart/form-data")
    assert b'name="mask"; filename="mask.png"' in raw and b'name="image"; filename="image.png"' in raw
    start = raw.index(b"\x89PNG", raw.index(b'name="mask"'))
    mask_png = Image.open(io.BytesIO(raw[start:]))
    assert mask_png.mode == "RGBA" and mask_png.getpixel((5, 5))[3] == 0 and mask_png.getpixel((60, 50))[3] == 255
    FakeHosted.mode = "moderation"
    _, ev = send(c, cid, "generate an image of a cabin")
    assert "declined" in text_of(ev)
