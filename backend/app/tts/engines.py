"""Speech engines. Each turns one sentence into mono float32 PCM.

  kokoro   Kokoro-82M (Apache-2.0 weights) through the kokoro-onnx package — runs on your CPU, no key, nothing leaves
           the machine. English (US/UK), Hindi, Spanish, French, Italian, Portuguese voices. Speed: yes. Pitch, emotion: no.
  gemini   Gemini API TTS (generateContent with responseModalities AUDIO, 24 kHz 16-bit PCM back). Prebuilt voices,
           many languages incl. Hindi and Indian English; delivery can be steered with a natural-language instruction.
  openai   /v1/audio/speech (gpt-4o-mini-tts by default). Speed, and tone through `instructions`.

Pitch is not offered by any of these; the device engines in the browser/Android app have it.
"""
from __future__ import annotations

import base64
import io
import json
import os
import re
import threading
import wave
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np


class TTSError(RuntimeError):
    def __init__(self, message: str, code: str = "tts_error", status: int = 502, retryable: bool = False):
        super().__init__(message)
        self.code, self.status, self.retryable = code, status, retryable


@dataclass(frozen=True)
class VoiceInfo:
    id: str                 # "<engine>:<engine voice>"
    label: str
    gender: str             # "female" | "male" | "unspecified" (never guessed)
    langs: tuple[str, ...]  # app language codes this voice is meant for
    engine: str


@dataclass
class Caps:
    speed: bool = False
    pitch: bool = False
    style: bool = False     # natural-language delivery control ("cheerful", "calm")
    langs: tuple[str, ...] = ()
    notes: list[str] = field(default_factory=list)


LANG_NAMES = {"en": "English", "hi": "Hindi", "hinglish": "Hinglish", "es": "Spanish", "fr": "French", "it": "Italian",
              "pt": "Portuguese"}


def pcm16_to_float(raw: bytes) -> np.ndarray:
    return np.frombuffer(raw[: len(raw) // 2 * 2], dtype="<i2").astype(np.float32) / 32768.0


def to_wav(x: np.ndarray, sr: int) -> bytes:
    pcm = (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes()
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm)
    return b.getvalue()


def wav_to_float(data: bytes) -> tuple[np.ndarray, int]:
    with wave.open(io.BytesIO(data)) as w:
        sr, sw, ch = w.getframerate(), w.getsampwidth(), w.getnchannels()
        raw = w.readframes(w.getnframes())
    if sw != 2:
        raise TTSError("Unexpected audio format from the speech engine.")
    x = pcm16_to_float(raw)
    return (x.reshape(-1, ch).mean(axis=1) if ch > 1 else x), sr


# ---------------- Kokoro (local) ----------------
KOKORO_VOICES = [
    ("af_heart", "Heart — US English", "female", ("en", "hinglish"), "en-us"),
    ("af_bella", "Bella — US English", "female", ("en", "hinglish"), "en-us"),
    ("af_nicole", "Nicole — US English, soft", "female", ("en", "hinglish"), "en-us"),
    ("am_michael", "Michael — US English", "male", ("en", "hinglish"), "en-us"),
    ("am_fenrir", "Fenrir — US English", "male", ("en", "hinglish"), "en-us"),
    ("bf_emma", "Emma — UK English", "female", ("en", "hinglish"), "en-gb"),
    ("bm_george", "George — UK English", "male", ("en", "hinglish"), "en-gb"),
    ("hf_alpha", "Alpha — Hindi", "female", ("hi",), "hi"),
    ("hf_beta", "Beta — Hindi", "female", ("hi",), "hi"),
    ("hm_omega", "Omega — Hindi", "male", ("hi",), "hi"),
    ("hm_psi", "Psi — Hindi", "male", ("hi",), "hi"),
    ("ef_dora", "Dora — Spanish", "female", ("es",), "es"),
    ("em_alex", "Alex — Spanish", "male", ("es",), "es"),
    ("ff_siwis", "Siwis — French", "female", ("fr",), "fr-fr"),
    ("if_sara", "Sara — Italian", "female", ("it",), "it"),
    ("im_nicola", "Nicola — Italian", "male", ("it",), "it"),
    ("pf_dora", "Dora — Portuguese (BR)", "female", ("pt",), "pt-br"),
    ("pm_alex", "Alex — Portuguese (BR)", "male", ("pt",), "pt-br"),
]


class KokoroEngine:
    name = "kokoro"

    def __init__(self, model_dir: str | None = None):
        d = Path(model_dir or os.environ.get("ZC_KOKORO_DIR", Path.home() / ".cache" / "zenvqo" / "kokoro"))
        self.model_path = Path(os.environ.get("ZC_KOKORO_MODEL", d / "kokoro-v1.0.onnx"))
        self.voices_path = Path(os.environ.get("ZC_KOKORO_VOICES", d / "voices-v1.0.bin"))
        self.model = "kokoro-82m-v1.0"
        self.caps = Caps(speed=True, langs=("en", "hi", "hinglish", "es", "fr", "it", "pt"),
                         notes=["Hinglish in Latin letters is read by an English voice, so Hindi words get an English accent."])
        self._k = None
        self._lock = threading.Lock()
        self._lang = {v[0]: v[4] for v in KOKORO_VOICES}
        try:
            import kokoro_onnx  # noqa: F401
            have = True
        except Exception:      # noqa: BLE001
            have = False
        if not have:
            self.unavailable_reason = "kokoro-onnx isn't installed on the server (pip install -r requirements-tts.txt)."
        elif not (self.model_path.is_file() and self.voices_path.is_file()):
            self.unavailable_reason = (f"Kokoro model files are missing ({self.model_path.name}, {self.voices_path.name}). "
                                       "Run: python -m app.tts.download")
        else:
            self.unavailable_reason = None

    def voices(self) -> list[VoiceInfo]:
        return [VoiceInfo(f"kokoro:{v}", label, g, langs, "kokoro") for v, label, g, langs, _ in KOKORO_VOICES]

    def _load(self):
        if self._k is None:
            from kokoro_onnx import Kokoro
            self._k = Kokoro(str(self.model_path), str(self.voices_path))
        return self._k

    def synth(self, text: str, voice: str, lang: str, speed: float, style: str) -> tuple[np.ndarray, int]:
        if voice not in self._lang:
            raise TTSError(f"Unknown Kokoro voice {voice}.", "bad_voice", 400)
        with self._lock:                                   # one synthesis at a time: CPU bound
            try:
                samples, sr = self._load().create(text, voice=voice, speed=max(0.5, min(2.0, speed)), lang=self._lang[voice])
            except Exception as e:     # noqa: BLE001
                raise TTSError("The local voice engine failed on this text.", "engine_failed", retryable=True) from e
        return np.asarray(samples, dtype=np.float32).reshape(-1), int(sr)


# ---------------- hosted ----------------
GEMINI_VOICES = [  # gender as listed in Google's Gemini-TTS voice table
    ("Kore", "female"), ("Aoede", "female"), ("Leda", "female"), ("Zephyr", "female"), ("Sulafat", "female"),
    ("Vindemiatrix", "female"), ("Achernar", "female"),
    ("Puck", "male"), ("Charon", "male"), ("Fenrir", "male"), ("Orus", "male"), ("Achird", "male"), ("Algenib", "male"),
    ("Umbriel", "male"),
]
OPENAI_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"]


def _http():
    import httpx
    return httpx


class GeminiTTSEngine:
    name = "gemini"

    def __init__(self):
        self.model = os.environ.get("ZC_GEMINI_TTS_MODEL", "gemini-2.5-flash-preview-tts")
        self.base = os.environ.get("ZC_GEMINI_BASE_URL", "https://generativelanguage.googleapis.com").rstrip("/")
        self.key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or ""
        self.caps = Caps(style=True, langs=("en", "hi", "hinglish", "es", "fr", "it", "pt"),
                         notes=["Speed is requested in words (\"slightly faster\"), not as an exact number."])
        self.unavailable_reason = None if self.key else "GEMINI_API_KEY is not set on the server."

    def voices(self) -> list[VoiceInfo]:
        langs = self.caps.langs
        return [VoiceInfo(f"gemini:{v}", f"{v} — Gemini", g, langs, "gemini") for v, g in GEMINI_VOICES]

    @staticmethod
    def prompt(text: str, lang: str, speed: float, style: str) -> str:
        how = []
        if style:
            how.append(style.strip().rstrip("."))
        if speed >= 1.15:
            how.append("at a brisk pace")
        elif speed <= 0.85:
            how.append("slowly and clearly")
        if lang == "hinglish":
            how.append("as natural Hinglish with Indian pronunciation")
        elif lang == "hi":
            how.append("in natural Hindi, pronouncing English words the way Indian speakers do")
        return f"Say {', '.join(how)}: {text}" if how else text

    def synth(self, text: str, voice: str, lang: str, speed: float, style: str) -> tuple[np.ndarray, int]:
        httpx = _http()
        body = {"contents": [{"parts": [{"text": self.prompt(text, lang, speed, style)}]}],
                "generationConfig": {"responseModalities": ["AUDIO"],
                                     "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}}}}
        url = f"{self.base}/v1beta/models/{self.model}:generateContent"
        try:
            r = httpx.post(url, json=body, headers={"x-goog-api-key": self.key}, timeout=60)
        except httpx.TimeoutException as e:
            raise TTSError("Gemini took too long to speak.", "timeout", retryable=True) from e
        except httpx.HTTPError as e:
            raise TTSError("Couldn't reach Gemini from the server.", "unreachable", retryable=True) from e
        if r.status_code == 429:
            raise TTSError("Gemini's speech limit was reached. Try again in a minute.", "rate_limited", 429, True)
        if r.status_code in (401, 403):
            raise TTSError("Gemini rejected the server's API key.", "auth")
        if r.status_code != 200:
            raise TTSError(f"Gemini speech failed ({r.status_code}).", "provider_error", retryable=r.status_code >= 500)
        j = r.json()
        for cand in j.get("candidates") or []:
            for part in (cand.get("content") or {}).get("parts") or []:
                d = part.get("inlineData") or part.get("inline_data")
                if d and d.get("data"):
                    mime = d.get("mimeType") or d.get("mime_type") or ""
                    m = re.search(r"rate=(\d+)", mime)
                    raw = base64.b64decode(d["data"])
                    if raw[:4] == b"RIFF":
                        return wav_to_float(raw)
                    return pcm16_to_float(raw), int(m.group(1)) if m else 24000
        raise TTSError("Gemini answered without audio.", "no_audio", retryable=True)


class OpenAITTSEngine:
    name = "openai"

    def __init__(self):
        self.model = os.environ.get("ZC_OPENAI_TTS_MODEL", "gpt-4o-mini-tts")
        self.base = os.environ.get("ZC_OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
        self.key = os.environ.get("OPENAI_API_KEY", "")
        self.caps = Caps(speed=True, style=self.model.startswith("gpt-"), langs=("en", "hi", "hinglish", "es", "fr", "it", "pt"))
        self.unavailable_reason = None if self.key else "OPENAI_API_KEY is not set on the server."

    def voices(self) -> list[VoiceInfo]:
        return [VoiceInfo(f"openai:{v}", f"{v.capitalize()} — OpenAI", "unspecified", self.caps.langs, "openai") for v in OPENAI_VOICES]

    def synth(self, text: str, voice: str, lang: str, speed: float, style: str) -> tuple[np.ndarray, int]:
        httpx = _http()
        body = {"model": self.model, "input": text, "voice": voice, "response_format": "wav", "speed": max(0.25, min(4.0, speed))}
        instr = [style] if style and self.caps.style else []
        if lang == "hinglish" and self.caps.style:
            instr.append("This is Hinglish (Hindi in English letters): pronounce it like a native Hindi speaker.")
        if instr:
            body["instructions"] = " ".join(instr)
        try:
            r = httpx.post(self.base + "/audio/speech", json=body, headers={"Authorization": f"Bearer {self.key}"}, timeout=60)
        except httpx.HTTPError as e:
            raise TTSError("Couldn't reach OpenAI from the server.", "unreachable", retryable=True) from e
        if r.status_code == 429:
            raise TTSError("OpenAI's speech limit was reached.", "rate_limited", 429, True)
        if r.status_code == 401:
            raise TTSError("OpenAI rejected the server's API key.", "auth")
        if r.status_code != 200:
            raise TTSError(f"OpenAI speech failed ({r.status_code}).", "provider_error", retryable=r.status_code >= 500)
        return wav_to_float(r.content)


def build_engines(spec: str | None = None) -> list:
    spec = (spec if spec is not None else os.environ.get("ZC_TTS_ENGINES", "auto")).strip().lower()
    if spec in ("none", "off", ""):
        return []
    make = {"kokoro": KokoroEngine, "gemini": GeminiTTSEngine, "openai": OpenAITTSEngine}
    if spec == "auto":
        out = [e for e in (KokoroEngine(), GeminiTTSEngine(), OpenAITTSEngine()) if e.unavailable_reason is None]
        return out or [KokoroEngine()]
    out = []
    for n in (x.strip() for x in spec.split(",") if x.strip()):
        if n not in make:
            raise ValueError(f"Unknown TTS engine '{n}' in ZC_TTS_ENGINES")
        out.append(make[n]())
    return out


def _json_default(o):
    return list(o) if isinstance(o, tuple) else str(o)


def describe(engines) -> str:
    return json.dumps([{"name": e.name, "ready": e.unavailable_reason is None} for e in engines], default=_json_default)
