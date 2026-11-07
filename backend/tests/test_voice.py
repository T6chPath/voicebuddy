"""Voice input API: WebSocket streaming and HTTP fallback, with a scripted recognizer in place of Whisper. Real Whisper on
real speech is tested in tests/test_voice_real.py."""
import base64
import io
import json
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import pytest
from conftest import HDR, client_for, make_settings, register
from starlette.websockets import WebSocketDisconnect

from app.asr.engines import clean, to_wav
from app.main import create_app

SR = 16000


class ScriptedASR:
    """'Recognises' a tone: 300 Hz → English sentence, 500 Hz → Hindi sentence. Partials report seconds heard."""
    name, model, unavailable_reason, partials = "whisper", "scripted", None, True

    def __init__(self):
        self.calls = []

    def transcribe(self, audio, lang, partial=False):
        self.calls.append((len(audio) / SR, lang, partial))
        if partial:
            return f"listening {len(audio) / SR:.0f}s", lang
        spec = np.abs(np.fft.rfft(audio[:SR]))
        f = np.argmax(spec) * SR / min(len(audio), SR)
        return ("What is Artificial Intelligence?", "en") if f < 400 else ("कृत्रिम बुद्धिमत्ता क्या है?", "hi")


def tone(f, secs, amp=0.3):
    t = np.arange(int(SR * secs)) / SR
    return (amp * np.sin(2 * np.pi * f * t)).astype(np.float32)


def pcm(x):
    return (x * 32767).astype("<i2").tobytes()


@pytest.fixture
def ctx(tmp_path, monkeypatch):
    monkeypatch.setenv("ZC_ASR_PARTIAL_S", "0.2")
    app = create_app(make_settings(tmp_path))
    asr = ScriptedASR()
    app.state.asr.engines = [asr]
    app.state.asr.partial_every = 0.2
    c = client_for(app)
    register(c)
    return app, c, asr


def test_clean_drops_hallucinations_and_loops():
    assert clean("Thank you for watching!", 0.8) == ("", "empty")
    assert clean("धन्यवाद।", 1.0) == ("", "empty")
    t, conf = clean("ok ok ok ok ok ok fine", 3)
    assert t == "ok ok ok fine" and conf == "low"
    assert clean("What is AI?", 2) == ("What is AI?", "ok")


def test_http_fallback(ctx):
    app, c, asr = ctx
    cfg = c.get("/api/voice/config").json()
    assert cfg["available"] and cfg["partials"] and cfg["stores_audio"] is False
    r = c.post("/api/voice/transcribe?lang=en", content=to_wav(tone(300, 2)), headers={"Content-Type": "audio/wav"})
    assert r.status_code == 200 and r.json()["text"] == "What is Artificial Intelligence?" and r.json()["audio_s"] == 2.0
    r = c.post("/api/voice/transcribe", content=to_wav(np.zeros(SR * 2, np.float32)))
    assert r.json()["confidence"] == "empty" and len(asr.calls) == 1             # silence never reaches the engine
    assert c.post("/api/voice/transcribe", content=b"not audio").status_code == 415
    anon = client_for(create_app(make_settings(app.state.settings.data_dir / "x")))
    assert anon.post("/api/voice/transcribe", content=to_wav(tone(300, 1))).status_code == 401


def test_websocket_stream_partials_final(ctx):
    app, c, asr = ctx
    with c.websocket_connect("/api/voice/ws", headers={"Origin": "http://localhost:5173"}) as ws:
        ready = ws.receive_json()
        assert ready["type"] == "ready" and ready["partials"] is True
        ws.send_text(json.dumps({"type": "start", "lang": "auto"}))
        audio = tone(300, 2.5)
        partials = []
        for i in range(0, len(audio), 960):                     # 60 ms frames, in real time-ish
            ws.send_bytes(pcm(audio[i:i + 960]))
            time.sleep(0.01)
        ws.send_text(json.dumps({"type": "end"}))
        while True:
            m = ws.receive_json()
            if m["type"] == "partial":
                partials.append(m["text"])
            elif m["type"] == "final":
                break
        assert partials and partials[0].startswith("listening")
        assert m["text"] == "What is Artificial Intelligence?" and m["lang"] == "en" and m["audio_s"] == 2.5
        assert set(m["ms"]) == {"decode", "after_end"}
        ws.send_text(json.dumps({"type": "start", "lang": "hi"}))                # second turn on the same socket
        ws.send_bytes(pcm(tone(500, 1.5)))
        ws.send_text(json.dumps({"type": "end"}))
        m = ws.receive_json()
        while m["type"] != "final":
            m = ws.receive_json()
        assert m["text"] == "कृत्रिम बुद्धिमत्ता क्या है?" and asr.calls[-1][1] == "hi"
        ws.send_text(json.dumps({"type": "start"}))
        ws.send_bytes(pcm(tone(300, 1)))
        ws.send_text(json.dumps({"type": "cancel"}))                              # interrupted: nothing transcribed
        ws.send_text(json.dumps({"type": "ping"}))
        assert ws.receive_json()["type"] == "pong"


def test_websocket_security_and_limits(ctx, monkeypatch):
    app, c, asr = ctx
    with pytest.raises(WebSocketDisconnect) as e:
        with c.websocket_connect("/api/voice/ws", headers={"Origin": "https://evil.example"}) as ws:
            ws.receive_json()
    assert e.value.code == 4403
    anon = client_for(app)
    with pytest.raises(WebSocketDisconnect) as e:
        with anon.websocket_connect("/api/voice/ws") as ws:
            ws.receive_json()
    assert e.value.code == 4401
    app.state.asr.max_s = 2
    with c.websocket_connect("/api/voice/ws") as ws:
        ws.receive_json()
        ws.send_text(json.dumps({"type": "start"}))
        a = tone(300, 3)
        for i in range(0, len(a), 1600):
            ws.send_bytes(pcm(a[i:i + 1600]))
        msgs = []
        while not any(m["type"] == "final" for m in msgs):
            msgs.append(ws.receive_json())
        assert any(m["type"] == "error" and m["code"] == "too_long" for m in msgs)
    from app.asr.service import SecondsLimiter
    app.state.asr.limiter = SecondsLimiter(3, 3600)
    app.state.asr.max_s = 30
    r1 = c.post("/api/voice/transcribe", content=to_wav(tone(300, 2)))
    r2 = c.post("/api/voice/transcribe", content=to_wav(tone(300, 2)))
    assert r1.status_code == 200 and r2.status_code == 429


def test_unavailable_reason(tmp_path):
    app = create_app(make_settings(tmp_path))
    c = client_for(app)
    register(c)
    cfg = c.get("/api/voice/config").json()
    assert cfg["available"] is False and "ZC_ASR_ENGINES=none" in cfg["reason"]
    with c.websocket_connect("/api/voice/ws") as ws:
        m = ws.receive_json()
        assert m["type"] == "error" and m["code"] == "unavailable"


class FakeHosted(BaseHTTPRequestHandler):
    seen: list = []

    def do_POST(self):
        raw = self.rfile.read(int(self.headers["Content-Length"]))
        FakeHosted.seen.append((self.path, dict(self.headers), raw))
        if ":generateContent" in self.path:
            body = {"candidates": [{"content": {"parts": [{"text": "AI kya hai?"}]}}]}
        else:
            body = {"text": "What is AI?"}
        b = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def log_message(self, *a):
        pass


def test_hosted_engines_wire_format(tmp_path, monkeypatch):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeHosted)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    monkeypatch.setenv("OPENAI_API_KEY", "o")
    monkeypatch.setenv("ZC_OPENAI_BASE_URL", base + "/v1")
    monkeypatch.setenv("GEMINI_API_KEY", "g")
    monkeypatch.setenv("ZC_GEMINI_BASE_URL", base)
    try:
        from app.asr.engines import GeminiASREngine, OpenAIASREngine
        o, g = OpenAIASREngine(), GeminiASREngine()
        assert o.transcribe(tone(300, 1), "en")[0] == "What is AI?"
        path, h, raw = FakeHosted.seen[-1]
        assert path == "/v1/audio/transcriptions" and h["Authorization"] == "Bearer o"
        assert b'name="model"' in raw and b"gpt-4o-mini-transcribe" in raw and b'filename="speech.wav"' in raw and b"RIFF" in raw
        assert g.transcribe(tone(300, 1), "hinglish")[0] == "AI kya hai?"
        path, h, raw = FakeHosted.seen[-1]
        body = json.loads(raw)
        assert path == "/v1beta/models/gemini-2.5-flash:generateContent" and h["x-goog-api-key"] == "g"
        parts = body["contents"][0]["parts"]
        assert "Latin letters" in parts[0]["text"] and parts[1]["inlineData"]["mimeType"] == "audio/wav"
        assert base64.b64decode(parts[1]["inlineData"]["data"])[:4] == b"RIFF"
    finally:
        srv.shutdown()
        srv.server_close()
