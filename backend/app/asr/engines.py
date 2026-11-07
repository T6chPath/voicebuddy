"""Speech-to-text engines. Input is always 16 kHz mono float32 PCM held in memory — audio is never written to disk.

  whisper  faster-whisper (CTranslate2) running OpenAI Whisper weights (MIT) on your CPU. Default model "small"
           (good English, usable Hindi); "medium" or "large-v3-turbo" are clearly better at Hindi/Hinglish but slower.
  openai   /v1/audio/transcriptions (gpt-4o-mini-transcribe by default; whisper-1 also works).
  gemini   generateContent with the audio inline, asked for a verbatim transcript.

Languages: "en", "hi", "hinglish" (code-mixed; asked for romanised Hindi + English), "auto" (engine detects).
"""
from __future__ import annotations

import base64
import io
import os
import re
import threading
import wave
import zlib

import numpy as np

SR = 16000
HINGLISH_PROMPT = "Haan, mujhe AI ke baare mein batao. Yeh technology kaise kaam karti hai? Main samajhna chahta hoon."
HINDI_PROMPT = "नमस्ते, मुझे आर्टिफिशियल इंटेलिजेंस के बारे में बताइए।"


class ASRError(RuntimeError):
    def __init__(self, message: str, code: str = "asr_error", status: int = 502, retryable: bool = False):
        super().__init__(message)
        self.code, self.status, self.retryable = code, status, retryable


def to_wav(x: np.ndarray, sr: int = SR) -> bytes:
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    return b.getvalue()


def decode_wav(data: bytes) -> np.ndarray:
    """WAV (16-bit PCM, any rate, mono/stereo) → 16 kHz mono float32."""
    try:
        with wave.open(io.BytesIO(data)) as w:
            sr, sw, ch, n = w.getframerate(), w.getsampwidth(), w.getnchannels(), w.getnframes()
            raw = w.readframes(n)
    except (wave.Error, EOFError) as e:
        raise ASRError("Send audio as 16-bit PCM WAV.", "bad_audio", 415) from e
    if sw != 2:
        raise ASRError("Send audio as 16-bit PCM WAV.", "bad_audio", 415)
    x = np.frombuffer(raw[: len(raw) // (2 * ch) * 2 * ch], dtype="<i2").astype(np.float32) / 32768
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return resample(x, sr)


def resample(x: np.ndarray, sr: int) -> np.ndarray:
    if sr == SR or len(x) == 0:
        return x.astype(np.float32)
    t = np.arange(int(len(x) * SR / sr)) * sr / SR
    return np.interp(t, np.arange(len(x)), x).astype(np.float32)


# ---------------- cleanup ----------------
HALLUCINATIONS = [re.compile(p, re.I) for p in (
    r"thank(s| you) (so much )?for watching", r"please subscribe", r"subtitles? (by|from)", r"amara\.org",
    r"^\s*(you|bye|thank you\.?)\s*$", r"like and subscribe", r"^\s*\[(music|silence|blank_audio)\]\s*$",
    r"^\s*(धन्यवाद|शुक्रिया)[।.!\s]*$", r"सब्सक्राइब")]


def collapse_repeats(text: str) -> tuple[str, bool]:
    words, changed = text.split(), False
    for n in (1, 2, 3, 4):
        out, i = [], 0
        while i < len(words):
            gram, reps = words[i:i + n], 1
            while words[i + reps * n:i + (reps + 1) * n] == gram:
                reps += 1
            if reps > 3:
                changed = True
            out += gram * min(reps, 3)
            i += n * reps
        words = out
    return " ".join(words), changed


def clean(text: str, speech_s: float) -> tuple[str, str]:
    """→ (text, confidence 'ok'|'low'|'empty'). Drops the classic Whisper hallucinations on near-silent audio."""
    t = " ".join((text or "").split())
    if not t:
        return "", "empty"
    if speech_s < 1.5 and any(p.search(t) for p in HALLUCINATIONS):
        return "", "empty"
    t, looped = collapse_repeats(t)
    b = t.encode()
    ratio = len(b) / max(1, len(zlib.compress(b)))
    return t, "low" if looped or (len(b) > 60 and ratio > 2.4) else "ok"


def level_db(x: np.ndarray) -> float:
    return float(10 * np.log10(np.mean(x.astype(np.float64) ** 2) + 1e-12)) if len(x) else -120.0


# ---------------- engines ----------------
class WhisperEngine:
    name = "whisper"

    def __init__(self):
        self.model_name = os.environ.get("ZC_ASR_MODEL", "small")
        self.model = f"faster-whisper {self.model_name}"
        self.device = os.environ.get("ZC_ASR_DEVICE", "cpu")
        self.compute = os.environ.get("ZC_ASR_COMPUTE", "int8")
        self.partials = os.environ.get("ZC_ASR_PARTIALS", "1") == "1"
        self._m = None
        self._lock = threading.Lock()
        try:
            import faster_whisper  # noqa: F401
            self.unavailable_reason = None
        except Exception:      # noqa: BLE001
            self.unavailable_reason = "faster-whisper isn't installed on the server (pip install -r requirements-asr.txt)."

    def load(self):
        if self._m is None:
            from faster_whisper import WhisperModel
            self._m = WhisperModel(self.model_name, device=self.device, compute_type=self.compute)
        return self._m

    def transcribe(self, audio: np.ndarray, lang: str, partial: bool = False) -> tuple[str, str]:
        kw = dict(beam_size=1 if partial else 5, vad_filter=False, condition_on_previous_text=False, without_timestamps=True)
        if lang == "en":
            kw["language"] = "en"
        elif lang == "hi":
            kw.update(language="hi", initial_prompt=HINDI_PROMPT)
        elif lang == "hinglish":
            kw.update(language="en", initial_prompt=HINGLISH_PROMPT)      # nudges Whisper to write Hindi words in Latin letters
        with self._lock:                                                   # CPU bound; one decode at a time
            try:
                segs, info = self.load().transcribe(audio, **kw)
                text = " ".join(s.text.strip() for s in segs)
            except Exception as e:     # noqa: BLE001
                raise ASRError("Speech recognition failed on the server.", "engine_failed", retryable=True) from e
        detected = lang if lang in ("en", "hi", "hinglish") else ("hi" if info.language == "hi" else info.language or "en")
        return text, detected


class OpenAIASREngine:
    name = "openai"
    partials = False

    def __init__(self):
        self.model = os.environ.get("ZC_OPENAI_ASR_MODEL", "gpt-4o-mini-transcribe")
        self.base = os.environ.get("ZC_OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
        self.key = os.environ.get("OPENAI_API_KEY", "")
        self.unavailable_reason = None if self.key else "OPENAI_API_KEY is not set on the server."

    def transcribe(self, audio: np.ndarray, lang: str, partial: bool = False) -> tuple[str, str]:
        import httpx
        data = {"model": self.model, "response_format": "json"}
        if lang in ("en", "hi"):
            data["language"] = lang
        if lang == "hinglish":
            data["prompt"] = HINGLISH_PROMPT
        try:
            r = httpx.post(self.base + "/audio/transcriptions", data=data, files={"file": ("speech.wav", to_wav(audio), "audio/wav")},
                           headers={"Authorization": f"Bearer {self.key}"}, timeout=60)
        except httpx.HTTPError as e:
            raise ASRError("Couldn't reach OpenAI for transcription.", "unreachable", retryable=True) from e
        if r.status_code == 429:
            raise ASRError("OpenAI's transcription limit was reached.", "rate_limited", 429, True)
        if r.status_code != 200:
            raise ASRError(f"OpenAI transcription failed ({r.status_code}).", "provider_error", retryable=r.status_code >= 500)
        return r.json().get("text", ""), lang if lang != "auto" else "auto"


class GeminiASREngine:
    name = "gemini"
    partials = False

    def __init__(self):
        self.model = os.environ.get("ZC_GEMINI_ASR_MODEL", "gemini-2.5-flash")
        self.base = os.environ.get("ZC_GEMINI_BASE_URL", "https://generativelanguage.googleapis.com").rstrip("/")
        self.key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or ""
        self.unavailable_reason = None if self.key else "GEMINI_API_KEY is not set on the server."

    def transcribe(self, audio: np.ndarray, lang: str, partial: bool = False) -> tuple[str, str]:
        import httpx
        how = {"en": "The speech is English.", "hi": "The speech is Hindi; write it in Devanagari.",
               "hinglish": "The speech mixes Hindi and English; write Hindi words in Latin letters (Hinglish)."}.get(lang, "")
        prompt = ("Transcribe this audio verbatim. Output only the words spoken, nothing else. "
                  f"{how} If there is no speech, output nothing.")
        body = {"contents": [{"parts": [{"text": prompt}, {"inlineData": {"mimeType": "audio/wav", "data": base64.b64encode(to_wav(audio)).decode()}}]}],
                "generationConfig": {"temperature": 0}}
        try:
            r = httpx.post(f"{self.base}/v1beta/models/{self.model}:generateContent", json=body,
                           headers={"x-goog-api-key": self.key}, timeout=60)
        except httpx.HTTPError as e:
            raise ASRError("Couldn't reach Gemini for transcription.", "unreachable", retryable=True) from e
        if r.status_code == 429:
            raise ASRError("Gemini's limit was reached.", "rate_limited", 429, True)
        if r.status_code != 200:
            raise ASRError(f"Gemini transcription failed ({r.status_code}).", "provider_error", retryable=r.status_code >= 500)
        parts = [p.get("text", "") for c in r.json().get("candidates") or [] for p in (c.get("content") or {}).get("parts") or []]
        return " ".join(parts).strip(), lang if lang != "auto" else "auto"


def build_engines(spec: str | None = None) -> list:
    spec = (spec if spec is not None else os.environ.get("ZC_ASR_ENGINES", "auto")).strip().lower()
    if spec in ("none", "off", ""):
        return []
    make = {"whisper": WhisperEngine, "openai": OpenAIASREngine, "gemini": GeminiASREngine}
    if spec == "auto":
        out = [e for e in (WhisperEngine(), OpenAIASREngine(), GeminiASREngine()) if e.unavailable_reason is None]
        return out or [WhisperEngine()]
    out = []
    for n in (x.strip() for x in spec.split(",") if x.strip()):
        if n not in make:
            raise ValueError(f"Unknown ASR engine '{n}' in ZC_ASR_ENGINES")
        out.append(make[n]())
    return out
