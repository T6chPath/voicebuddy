"""Real voices: Kokoro-82M through the real API, checked by listening — a Whisper model transcribes each clip and the
transcript must match the text. Slow and needs ≈2 GB of models, so it only runs when asked:

    pip install -r requirements-tts.txt faster-whisper && python -m app.tts.download
    ZC_REAL_TTS_TESTS=1 python -m pytest tests/test_tts_real.py -v -s

Clips and a report are written to $ZC_REAL_OUT (default ./real-out) so a person can listen too."""
import io
import json
import os
import re
import time
import unicodedata
import wave
from pathlib import Path

import numpy as np
import pytest
from conftest import client_for, make_settings, new_conv, register, send

pytestmark = pytest.mark.skipif(os.environ.get("ZC_REAL_TTS_TESTS") != "1", reason="set ZC_REAL_TTS_TESTS=1")
OUT = Path(os.environ.get("ZC_REAL_OUT", "real-out"))
REPORT: dict = {}


@pytest.fixture(scope="module")
def c(tmp_path_factory):
    from app.main import create_app
    OUT.mkdir(parents=True, exist_ok=True)
    app = create_app(make_settings(tmp_path_factory.mktemp("tts"), tts_engines="kokoro"))
    cat = app.state.tts.catalog()
    assert cat["available"], cat["reason"]
    client = client_for(app)
    register(client)
    yield client
    (OUT / "tts-report.json").write_text(json.dumps(REPORT, indent=1, ensure_ascii=False))


@pytest.fixture(scope="module")
def asr():
    from faster_whisper import WhisperModel
    return WhisperModel(os.environ.get("ZC_TEST_WHISPER", "medium"), device="cpu", compute_type="int8")


def norm(t: str) -> str:
    t = unicodedata.normalize("NFC", t.lower())
    t = re.sub(r"[।॥!\"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~“”‘’…–—]", " ", t)
    return " ".join(t.split())


def edits(a, b) -> int:
    prev = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for j, y in enumerate(b, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x != y))
        prev = cur
    return prev[-1]


def speak(c, name, text, **kw):
    t0 = time.monotonic()
    r = c.post("/api/tts", json={"text": text, **kw})
    ms = int((time.monotonic() - t0) * 1000)
    assert r.status_code == 200, r.text
    (OUT / f"{name}.wav").write_bytes(r.content)
    with wave.open(io.BytesIO(r.content)) as w:
        sr, n = w.getframerate(), w.getnframes()
        x = np.frombuffer(w.readframes(n), dtype="<i2").astype(np.float32) / 32768
    secs = n / sr
    REPORT[name] = {"text": text, "voice": r.headers["x-tts-voice"], "lang": r.headers["x-tts-lang"], "synth_ms": ms,
                    "audio_s": round(secs, 2), "real_time_factor": round(ms / 1000 / secs, 3), "rms": round(float(np.sqrt((x ** 2).mean())), 4)}
    return OUT / f"{name}.wav", r


def hear(asr, path, lang=None):
    segs, info = asr.transcribe(str(path), language=lang, beam_size=5, vad_filter=False)
    return " ".join(s.text.strip() for s in segs), info.language


def test_success_criterion_what_is_ai(c, asr):
    cid = new_conv(c)
    _, ev = send(c, cid, "What is Artificial Intelligence?")
    reply = "".join(d["text"] for e, d in ev if e == "delta")
    assert "What is Artificial Intelligence?" in reply
    first = reply.split("\n")[0]                                  # "You said: **What is Artificial Intelligence?**"
    path, r = speak(c, "01-what-is-ai-reply", first)
    heard, lang = hear(asr, path, "en")
    REPORT["01-what-is-ai-reply"]["heard"] = heard
    assert r.headers["x-tts-lang"] == "en" and "artificial intelligence" in norm(heard)


def test_english(c, asr):
    text = "Artificial intelligence is the ability of computers to learn from data and solve problems."
    path, r = speak(c, "02-english", text)
    heard, _ = hear(asr, path, "en")
    w = edits(norm(text).split(), norm(heard).split()) / len(norm(text).split())
    REPORT["02-english"].update(heard=heard, wer=round(w, 3))
    assert r.headers["x-tts-voice"] == "kokoro:af_heart" and w <= 0.15
    path, r = speak(c, "03-english-male-fast", text, gender="male", speed=1.3)
    heard, _ = hear(asr, path, "en")
    w2 = edits(norm(text).split(), norm(heard).split()) / len(norm(text).split())
    REPORT["03-english-male-fast"].update(heard=heard, wer=round(w2, 3))
    assert r.headers["x-tts-voice"] == "kokoro:am_michael" and w2 <= 0.2
    assert REPORT["03-english-male-fast"]["audio_s"] < REPORT["02-english"]["audio_s"]       # faster really is faster


def test_hindi(c, asr):
    text = "कृत्रिम बुद्धिमत्ता कंप्यूटर को डेटा से सीखने और समस्याएँ हल करने की क्षमता है।"
    path, r = speak(c, "04-hindi", text)
    heard, _ = hear(asr, path, "hi")
    ref, hyp = norm(text).replace(" ", ""), norm(heard).replace(" ", "")
    cer = edits(list(ref), list(hyp)) / len(ref)
    REPORT["04-hindi"].update(heard=heard, cer=round(cer, 3))
    assert r.headers["x-tts-lang"] == "hi" and r.headers["x-tts-voice"] == "kokoro:hf_alpha" and cer <= 0.35
    path, r = speak(c, "05-hindi-male", text, gender="male")
    heard, _ = hear(asr, path, "hi")
    cer2 = edits(list(ref), list(norm(heard).replace(" ", ""))) / len(ref)
    REPORT["05-hindi-male"].update(heard=heard, cer=round(cer2, 3))
    assert r.headers["x-tts-voice"] == "kokoro:hm_omega" and cer2 <= 0.4


def test_mixed_hindi_english(c, asr):
    text = "AI यानी Artificial Intelligence एक ऐसी technology है जो machines को सोचना सिखाती है।"
    path, r = speak(c, "06-hindi-english-mixed", text)
    heard, lang = hear(asr, path)
    REPORT["06-hindi-english-mixed"].update(heard=heard, detected=lang)
    n = norm(heard)
    hits = sum(any(k in n for k in ks) for ks in (("सोच",), ("सिखा", "sikha"), ("मशीन", "machine"), ("टेक्नोलॉजी", "technology", "टेक्नॉलजी")))
    REPORT["06-hindi-english-mixed"]["keywords_heard"] = hits
    assert r.headers["x-tts-lang"] == "hi" and hits >= 2


def test_hinglish_roman(c, asr):
    text = "AI ek technology hai jo machines ko smart banati hai."
    path, r = speak(c, "07-hinglish-roman", text)
    heard, lang = hear(asr, path)
    REPORT["07-hinglish-roman"].update(heard=heard, detected=lang)
    n = norm(heard)
    assert r.headers["x-tts-lang"] == "hinglish" and ("technology" in n or "टेक्नोलॉजी" in n or "machine" in n or "मशीन" in n)


def test_other_language_and_latency(c, asr):
    path, r = speak(c, "08-spanish", "La inteligencia artificial ayuda a las personas cada día.", lang="es")
    heard, lang = hear(asr, path, "es")
    REPORT["08-spanish"].update(heard=heard)
    assert "inteligencia artificial" in norm(heard)
    t0 = time.monotonic()
    speak(c, "09-first-sentence-latency", "Sure, here is a short answer.")
    REPORT["first_sentence_ms"] = int((time.monotonic() - t0) * 1000)
    r = c.post("/api/tts", json={"text": "Sure, here is a short answer."})
    assert r.headers["x-tts-cache"] == "hit"
