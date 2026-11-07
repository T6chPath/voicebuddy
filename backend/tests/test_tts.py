"""TTS service through the real API routes. A deterministic tone engine stands in for the neural model here; the real
Kokoro voices are tested (with a speech-recognition round trip) in tests/test_tts_real.py. Hosted engines are checked
against fake servers speaking the documented Gemini / OpenAI formats."""
import base64
import io
import json
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import pytest
from conftest import client_for, make_settings, register

from app.main import create_app
from app.tts.engines import Caps, TTSError, VoiceInfo
from app.tts.text import detect_lang, sentences, speakable


class ToneEngine:
    def __init__(self, name="kokoro", fail=None):
        self.name, self.model, self.unavailable_reason, self.fail = name, "tone-1", None, fail
        self.caps = Caps(speed=True, langs=("en", "hi", "hinglish"))
        self.calls = []

    def voices(self):
        return [VoiceInfo(f"{self.name}:en_f", "En F", "female", ("en", "hinglish"), self.name),
                VoiceInfo(f"{self.name}:en_m", "En M", "male", ("en", "hinglish"), self.name),
                VoiceInfo(f"{self.name}:hi_f", "Hi F", "female", ("hi",), self.name),
                VoiceInfo(f"{self.name}:hi_m", "Hi M", "male", ("hi",), self.name)]

    def synth(self, text, voice, lang, speed, style):
        self.calls.append((text, voice, lang, speed, style))
        if self.fail:
            raise self.fail
        sr = 24000
        t = np.arange(int(sr * len(text) / 15 / speed)) / sr
        return (0.3 * np.sin(2 * np.pi * 220 * t)).astype(np.float32), sr


def make(tmp_path, engines, **env):
    app = create_app(make_settings(tmp_path))
    app.state.tts.engines = engines
    c = client_for(app)
    register(c)
    return app, c


def wav_info(data):
    with wave.open(io.BytesIO(data)) as w:
        return w.getframerate(), w.getnframes() / w.getframerate()


def test_text_preparation_and_language():
    md = "## What is AI?\n**Artificial Intelligence** (AI) is a field of computer science.\n\n```python\nprint(1)\n```\n- It learns from data.\n| a | b |\n|---|---|"
    s = speakable(md)
    assert "**" not in s and "##" not in s and "print(1)" not in s and "code omitted" in s
    parts = sentences("AI means machines that learn. It is everywhere today! क्या यह अच्छा है? हाँ।")
    assert parts == ["AI means machines that learn. It is everywhere today!", "क्या यह अच्छा है? हाँ।"]   # tiny bits joined
    assert detect_lang("What is Artificial Intelligence?") == "en"
    assert detect_lang("कृत्रिम बुद्धिमत्ता एक तकनीक है।") == "hi"
    assert detect_lang("AI यानी Artificial Intelligence एक technology है जो machines को सिखाती है।") == "hi"
    assert detect_lang("AI ek technology hai jo machines ko smart banati hai") == "hinglish"
    long = "word " * 120
    assert all(len(p) <= 240 for p in sentences(long))


def test_speak_english_hindi_hinglish_and_cache(tmp_path):
    eng = ToneEngine()
    app, c = make(tmp_path, [eng])
    cat = c.get("/api/tts/voices").json()
    assert cat["available"] and cat["defaults"]["hi"]["male"] == "kokoro:hi_m" and {l["code"] for l in cat["languages"]} >= {"en", "hi"}
    r = c.post("/api/tts", json={"text": "Artificial Intelligence is the science of making machines think."})
    assert r.status_code == 200 and r.headers["content-type"] == "audio/wav"
    assert r.headers["x-tts-lang"] == "en" and r.headers["x-tts-voice"] == "kokoro:en_f" and r.headers["x-tts-cache"] == "miss"
    sr, secs = wav_info(r.content)
    assert sr == 24000 and secs > 2
    r2 = c.post("/api/tts", json={"text": "Artificial Intelligence is the science of making machines think."})
    assert r2.headers["x-tts-cache"] == "hit" and r2.content == r.content and len(eng.calls) == 1
    r = c.post("/api/tts", json={"text": "कृत्रिम बुद्धिमत्ता मशीनों को सोचना सिखाती है।", "gender": "male"})
    assert r.headers["x-tts-lang"] == "hi" and r.headers["x-tts-voice"] == "kokoro:hi_m"
    r = c.post("/api/tts", json={"text": "AI ek technology hai jo machines ko smart banati hai.", "speed": 1.4})
    assert r.headers["x-tts-lang"] == "hinglish" and eng.calls[-1][2:4] == ("hinglish", 1.4)
    r = c.post("/api/tts", json={"text": "Hello there, how are you?", "voice": "kokoro:hi_f"})   # Hindi voice for English text
    assert r.headers["x-tts-voice"] == "kokoro:en_f"                                            # → right-language voice
    r = c.post("/api/tts", json={"text": "**Bold** text with `code`", "lang": "en"})
    assert eng.calls[-1][0] == "Bold text with code"


def test_errors_limits_and_fallback(tmp_path, monkeypatch):
    monkeypatch.setenv("ZC_TTS_RATE", "120/3600")
    app, c = make(tmp_path, [ToneEngine(fail=TTSError("boom", "engine_failed", retryable=True)), ToneEngine("gemini")])
    r = c.post("/api/tts", json={"text": "Fallback works when the first engine fails."})
    assert r.status_code == 200 and r.headers["x-tts-engine"] == "gemini"
    assert c.post("/api/tts", json={"text": "```\ncode only\n```"}).status_code in (200, 400)
    assert c.post("/api/tts", json={"text": "   "}).status_code == 422
    assert c.post("/api/tts", json={"text": "x" * 1500}).status_code == 413
    r = c.post("/api/tts", json={"text": "This one is long enough to go past the tiny test limit of characters per hour."})
    assert r.status_code == 429 and r.headers["x-tts-error"] == "rate_limited"
    app2, c2 = make(tmp_path / "n", [])
    r = c2.post("/api/tts", json={"text": "hello"})
    assert r.status_code == 503 and "ZC_TTS_ENGINES=none" in r.json()["detail"]
    assert c2.get("/api/tts/voices").json()["available"] is False
    anon = client_for(app2)
    assert anon.post("/api/tts", json={"text": "hi"}).status_code == 401


def test_kokoro_reports_missing_setup(tmp_path):
    from app.tts.engines import KokoroEngine
    e = KokoroEngine(str(tmp_path))
    assert e.unavailable_reason and ("kokoro-onnx" in e.unavailable_reason or "app.tts.download" in e.unavailable_reason)


class FakeHosted(BaseHTTPRequestHandler):
    seen: list = []

    def do_POST(self):
        raw = self.rfile.read(int(self.headers["Content-Length"]))
        FakeHosted.seen.append((self.path, dict(self.headers), json.loads(raw)))
        pcm = (np.sin(np.arange(24000) / 24000 * 2 * np.pi * 200) * 8000).astype("<i2").tobytes()
        if ":generateContent" in self.path:
            body = json.dumps({"candidates": [{"content": {"parts": [{"inlineData": {"mimeType": "audio/L16;codec=pcm;rate=24000",
                                                                                  "data": base64.b64encode(pcm).decode()}}]}}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
        else:
            b = io.BytesIO()
            with wave.open(b, "wb") as w:
                w.setnchannels(1), w.setsampwidth(2), w.setframerate(24000), w.writeframes(pcm)
            body = b.getvalue()
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


@pytest.fixture
def hosted(monkeypatch):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), FakeHosted)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    FakeHosted.seen = []
    monkeypatch.setenv("GEMINI_API_KEY", "g-key")
    monkeypatch.setenv("ZC_GEMINI_BASE_URL", base)
    monkeypatch.setenv("OPENAI_API_KEY", "o-key")
    monkeypatch.setenv("ZC_OPENAI_BASE_URL", base + "/v1")
    yield
    srv.shutdown()
    srv.server_close()


def test_gemini_and_openai_wire_format(tmp_path, hosted):
    from app.tts.engines import GeminiTTSEngine, OpenAITTSEngine
    app, c = make(tmp_path, [GeminiTTSEngine(), OpenAITTSEngine()])
    r = c.post("/api/tts", json={"text": "AI ek technology hai jo machines ko smart banati hai.", "voice": "gemini:Puck",
                                 "style": "cheerfully", "speed": 1.2})
    assert r.status_code == 200 and wav_info(r.content) == (24000, 1.0)
    path, headers, body = FakeHosted.seen[0]
    assert path == "/v1beta/models/gemini-2.5-flash-preview-tts:generateContent" and headers["x-goog-api-key"] == "g-key"
    assert body["generationConfig"]["responseModalities"] == ["AUDIO"]
    assert body["generationConfig"]["speechConfig"]["voiceConfig"]["prebuiltVoiceConfig"]["voiceName"] == "Puck"
    t = body["contents"][0]["parts"][0]["text"]
    assert t.startswith("Say cheerfully, at a brisk pace, as natural Hinglish") and t.endswith("smart banati hai.")
    r = c.post("/api/tts", json={"text": "Hello world, this is OpenAI speaking.", "voice": "openai:coral", "speed": 0.8})
    path, headers, body = FakeHosted.seen[1]
    assert path == "/v1/audio/speech" and headers["Authorization"] == "Bearer o-key"
    assert body == {"model": "gpt-4o-mini-tts", "input": "Hello world, this is OpenAI speaking.", "voice": "coral",
                    "response_format": "wav", "speed": 0.8}
    assert r.headers["x-tts-voice"] == "openai:coral"
    genders = {v["id"]: v["gender"] for v in c.get("/api/tts/voices").json()["voices"]}
    assert genders["gemini:Kore"] == "female" and genders["gemini:Puck"] == "male" and genders["openai:coral"] == "unspecified"
