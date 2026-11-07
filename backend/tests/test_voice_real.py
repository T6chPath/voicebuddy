"""Real speech recognition: Kokoro speaks, the audio streams over the real WebSocket at real-time pace, real Whisper
(faster-whisper) transcribes. Measures accuracy, live captions and latency after the speaker stops.

    pip install -r requirements-tts.txt -r requirements-asr.txt && python -m app.tts.download && python -m app.asr.download
    ZC_REAL_VOICE_TESTS=1 python -m pytest tests/test_voice_real.py -v -s
"""
import json
import os
import re
import time
import unicodedata
import wave
from pathlib import Path

import numpy as np
import pytest
from conftest import client_for, make_settings, register

pytestmark = pytest.mark.skipif(os.environ.get("ZC_REAL_VOICE_TESTS") != "1", reason="set ZC_REAL_VOICE_TESTS=1")
OUT = Path(os.environ.get("ZC_REAL_OUT", "real-out"))
REPORT: dict = {"model": os.environ.get("ZC_ASR_MODEL", "small")}
SR = 16000


@pytest.fixture(scope="module")
def env(tmp_path_factory):
    from app.main import create_app
    from app.tts.engines import KokoroEngine
    OUT.mkdir(parents=True, exist_ok=True)
    app = create_app(make_settings(tmp_path_factory.mktemp("v"), asr_engines="whisper"))
    assert app.state.asr.available, app.state.asr.reason()
    app.state.asr.engines[0].load()                       # model load isn't part of per-turn latency
    c = client_for(app)
    register(c)
    yield c, KokoroEngine()
    (OUT / "voice-report.json").write_text(json.dumps(REPORT, indent=1, ensure_ascii=False))


def say(k, text, voice):
    x, sr = k.synth(text, voice, "en", 1.0, "")
    t = np.arange(int(len(x) * SR / sr)) * sr / SR
    return np.interp(t, np.arange(len(x)), x).astype(np.float32)


def norm(t):
    t = unicodedata.normalize("NFC", t.lower())
    return " ".join(re.sub(r"[।॥!\"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~“”‘’…–—]", " ", t).split())


def edits(a, b):
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for j, y in enumerate(b, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y))
        prev = cur
    return prev[-1]


def stream(c, audio, lang, name):
    """Send 40 ms frames at real-time pace, like a browser, then 'end'; return final + partials + latency."""
    with wave.open(str(OUT / f"{name}.wav"), "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(SR)
        w.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
    partials = []
    with c.websocket_connect("/api/voice/ws") as ws:
        assert ws.receive_json()["type"] == "ready"
        ws.send_text(json.dumps({"type": "start", "lang": lang}))
        t0 = time.monotonic()
        for i in range(0, len(audio), 640):
            ws.send_bytes((np.clip(audio[i:i + 640], -1, 1) * 32767).astype("<i2").tobytes())
            lag = (i + 640) / SR - (time.monotonic() - t0)
            if lag > 0:
                time.sleep(lag)
        t_end = time.monotonic()
        ws.send_text(json.dumps({"type": "end"}))
        while True:
            m = ws.receive_json()
            if m["type"] == "partial":
                partials.append(m["text"])
            elif m["type"] in ("final", "error"):
                break
    m["client_after_end_ms"] = int((time.monotonic() - t_end) * 1000)
    REPORT[name] = {"lang": lang, "heard": m.get("text"), "detected": m.get("lang"), "partials": partials[-3:],
                    "n_partials": len(partials), "after_end_ms": m["client_after_end_ms"], "decode_ms": (m.get("ms") or {}).get("decode"),
                    "audio_s": m.get("audio_s")}
    return m, partials


def wer(ref, hyp):
    r, h = norm(ref).split(), norm(hyp).split()
    return edits(r, h) / max(1, len(r))


def cer(ref, hyp):
    r, h = norm(ref).replace(" ", ""), norm(hyp).replace(" ", "")
    return edits(list(r), list(h)) / max(1, len(r))


def test_english_question_streamed(env):
    c, k = env
    text = "What is artificial intelligence, and how does it learn from data?"
    m, partials = stream(c, np.concatenate([say(k, text, "am_michael"), np.zeros(SR // 2, np.float32)]), "auto", "asr-01-english")
    REPORT["asr-01-english"]["wer"] = w = round(wer(text, m["text"]), 3)
    assert m["type"] == "final" and w <= 0.2 and m["lang"] == "en"
    assert partials, "live captions arrived while speaking"


def test_english_with_background_noise(env):
    c, k = env
    text = "Please tell me today's weather and a short joke about computers."
    s = say(k, text, "af_heart")
    rng = np.random.default_rng(7)
    noise = rng.normal(0, 1, len(s) + SR).astype(np.float32)
    noise *= np.sqrt(np.mean(s ** 2) / np.mean(noise ** 2)) / (10 ** (10 / 20))       # 10 dB signal-to-noise
    audio = np.concatenate([s, np.zeros(SR, np.float32)]) + noise
    m, _ = stream(c, audio, "en", "asr-02-english-noisy-10db")
    REPORT["asr-02-english-noisy-10db"]["wer"] = w = round(wer(text, m["text"]), 3)
    assert w <= 0.3


def test_hindi(env):
    c, k = env
    text = "कृत्रिम बुद्धिमत्ता कंप्यूटर को सोचने और सीखने की क्षमता देती है।"
    x, sr = k.synth(text, "hf_alpha", "hi", 1.0, "")
    audio = np.interp(np.arange(int(len(x) * SR / sr)) * sr / SR, np.arange(len(x)), x).astype(np.float32)
    m, _ = stream(c, audio, "hi", "asr-03-hindi")
    REPORT["asr-03-hindi"]["cer"] = e = round(cer(text, m["text"]), 3)
    assert e <= 0.5 and re.search(r"[ऀ-ॿ]", m["text"])


def test_mixed_and_hinglish(env):
    c, k = env
    text = "AI यानी Artificial Intelligence एक technology है जो machines को सोचना सिखाती है।"
    x, sr = k.synth(text, "hm_omega", "hi", 1.0, "")
    audio = np.interp(np.arange(int(len(x) * SR / sr)) * sr / SR, np.arange(len(x)), x).astype(np.float32)
    m, _ = stream(c, audio, "auto", "asr-04-mixed-auto")
    n = norm(m["text"])
    REPORT["asr-04-mixed-auto"]["keywords"] = hits = sum(any(w in n for w in ws) for ws in
        (("machine", "मशीन"), ("technology", "टेक्नोलॉजी", "टेक्नॉलजी"), ("सोच", "soch"), ("intelligence", "इंटेलिजेंस")))
    assert hits >= 2
    m2, _ = stream(c, audio, "hinglish", "asr-05-mixed-as-hinglish")
    REPORT["asr-05-mixed-as-hinglish"]["latin_share"] = round(len(re.findall(r"[a-zA-Z]", m2["text"])) / max(1, len(m2["text"].replace(" ", ""))), 2)
    assert m2["text"]


def test_http_fallback_and_latency_summary(env):
    c, k = env
    from app.asr.engines import to_wav
    audio = say(k, "Turn on hands free mode.", "af_heart")
    t = time.monotonic()
    r = c.post("/api/voice/transcribe?lang=en", content=to_wav(audio))
    REPORT["http_fallback"] = {"heard": r.json()["text"], "ms": int((time.monotonic() - t) * 1000)}
    assert r.status_code == 200 and "hands" in norm(r.json()["text"]) and "free" in norm(r.json()["text"])
    lat = [v["after_end_ms"] for k_, v in REPORT.items() if isinstance(v, dict) and "after_end_ms" in v]
    REPORT["after_end_ms_median"] = int(np.median(lat))
