"""TTS service: choose a voice for each sentence's language, cache results, limit use, fall back between engines.

Config (environment):
  ZC_TTS_ENGINES     auto | none | comma list in priority order ("kokoro,gemini")   — auto = every ready engine, local first
  ZC_TTS_RATE        "<characters>/<seconds>" per user (default 40000/3600)
  ZC_TTS_CACHE_MB    on-disk cache of synthesised sentences (default 200)
  ZC_TTS_MAX_QUEUE   server-wide syntheses waiting or running (default 4)
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import threading
import time
from collections import defaultdict, deque
from pathlib import Path

from .engines import LANG_NAMES, TTSError, VoiceInfo, build_engines, to_wav
from .text import detect_lang, speakable

log = logging.getLogger("zenvqo.tts")
MAX_CHARS = 1200
LABEL = {"kokoro": "local voice (Kokoro)", "gemini": "Gemini", "openai": "OpenAI"}


class CharLimiter:
    def __init__(self, chars: int, window_s: float):
        self.chars, self.window = chars, window_s
        self.hits: dict[str, deque] = defaultdict(deque)
        self.lock = threading.Lock()

    def take(self, key: str, n: int) -> float:
        now = time.monotonic()
        with self.lock:
            q = self.hits[key]
            while q and now - q[0][0] > self.window:
                q.popleft()
            used = sum(c for _, c in q)
            if used + n > self.chars:
                return round(self.window - (now - q[0][0]), 1) if q else self.window
            q.append((now, n))
        return 0.0


class TTSService:
    def __init__(self, data_dir: Path, engines: list | None = None):
        self.engines = build_engines() if engines is None else engines
        self.cache_dir = Path(data_dir) / "tts-cache"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.cache_bytes = int(float(os.environ.get("ZC_TTS_CACHE_MB", "200")) * 1024 * 1024)
        n, _, w = os.environ.get("ZC_TTS_RATE", "40000/3600").partition("/")
        self.limiter = CharLimiter(int(n), float(w or 3600))
        self.max_queue = int(os.environ.get("ZC_TTS_MAX_QUEUE", "4"))
        self.waiting = 0

    def ready(self) -> list:
        return [e for e in self.engines if e.unavailable_reason is None]

    @property
    def available(self) -> bool:
        return bool(self.ready())

    def reason(self) -> str:
        if not self.engines:
            return "Server voices are turned off (ZC_TTS_ENGINES=none)."
        return " ".join(f"{LABEL.get(e.name, e.name)}: {e.unavailable_reason}" for e in self.engines if e.unavailable_reason)

    def voices(self) -> list[VoiceInfo]:
        return [v for e in self.ready() for v in e.voices()]

    def default_voice(self, lang: str, gender: str = "female", engine: str | None = None) -> VoiceInfo | None:
        pool = [v for v in self.voices() if (engine is None or v.engine == engine)]
        for want_gender in (gender, "female", "male", "unspecified"):
            for v in pool:
                if lang in v.langs and v.gender == want_gender:
                    return v
        return pool[0] if pool else None

    def catalog(self) -> dict:
        ready = self.ready()
        return {
            "available": bool(ready),
            "reason": None if ready else self.reason(),
            "engines": [{"name": e.name, "model": e.model, "ready": e.unavailable_reason is None, "reason": e.unavailable_reason,
                         "speed": e.caps.speed, "pitch": e.caps.pitch, "style": e.caps.style, "langs": list(e.caps.langs),
                         "notes": e.caps.notes} for e in self.engines],
            "voices": [{"id": v.id, "label": v.label, "gender": v.gender, "langs": list(v.langs), "engine": v.engine}
                       for v in self.voices()],
            "languages": [{"code": c, "name": n} for c, n in LANG_NAMES.items()
                          if any(c in e.caps.langs for e in ready)],
            "defaults": {lang: {g: (self.default_voice(lang, g).id if self.default_voice(lang, g) else None)
                                for g in ("female", "male")} for lang in ("en", "hi", "hinglish")},
            "max_chars": MAX_CHARS,
        }

    # ---------------- synthesis ----------------
    def _engine(self, name: str):
        return next((e for e in self.ready() if e.name == name), None)

    def plan(self, text: str, voice: str | None, lang: str | None, gender: str) -> tuple[str, list[tuple[object, str]]]:
        """→ (language, [(engine, engine_voice), …] in the order to try)."""
        lang = lang if lang in LANG_NAMES else detect_lang(text)
        order: list[tuple[object, str]] = []
        if voice and ":" in voice:
            ename, vname = voice.split(":", 1)
            e = self._engine(ename)
            known = {v.id: v for v in self.voices()}
            if e and voice in known:
                v = known[voice]
                if lang in v.langs or v.engine != "kokoro":           # Kokoro voices are per language
                    order.append((e, vname))
                gender = v.gender if v.gender != "unspecified" else gender
        for e in self.ready():
            d = self.default_voice(lang, gender, e.name)
            if d and lang in d.langs and (e, d.id.split(":", 1)[1]) not in order:
                order.append((e, d.id.split(":", 1)[1]))
        return lang, order

    def _cache_path(self, *parts) -> Path:
        h = hashlib.sha256(json.dumps(parts, ensure_ascii=False).encode()).hexdigest()
        return self.cache_dir / h[:2] / f"{h}.wav"

    def _prune(self):
        files = sorted(self.cache_dir.glob("*/*.wav"), key=lambda p: p.stat().st_mtime)
        total = sum(p.stat().st_size for p in files)
        while files and total > self.cache_bytes:
            p = files.pop(0)
            total -= p.stat().st_size
            p.unlink(missing_ok=True)

    async def speak(self, uid: str, text: str, voice: str | None = None, lang: str | None = None, speed: float = 1.0,
                    style: str = "", gender: str = "female") -> tuple[bytes, dict]:
        """One sentence (or short passage) → WAV bytes + info headers. Clients split long replies into sentences."""
        clean = speakable(text).strip()
        if not clean:
            raise TTSError("There's nothing to read aloud in this text.", "empty", 400)
        if len(clean) > MAX_CHARS:
            raise TTSError(f"Send at most {MAX_CHARS} characters per request (split long replies into sentences).", "too_long", 413)
        if not self.available:
            raise TTSError("Server voices aren't available: " + self.reason(), "unavailable", 503)
        speed = max(0.5, min(2.0, float(speed or 1.0)))
        style = (style or "")[:120]
        lang, order = self.plan(clean, voice, lang, gender if gender in ("female", "male") else "female")
        if not order:
            raise TTSError(f"No configured voice speaks {LANG_NAMES.get(lang, lang)}.", "no_voice", 400)

        e0, v0 = order[0]
        key = self._cache_path(e0.name, e0.model, v0, lang, round(speed, 2), style, clean)
        if key.is_file():
            key.touch()
            return key.read_bytes(), {"engine": e0.name, "voice": f"{e0.name}:{v0}", "lang": lang, "cache": "hit", "ms": 0}
        wait = self.limiter.take("tts:" + uid, len(clean))
        if wait:
            raise TTSError(f"Speech limit reached — try again in {int(wait // 60) + 1} min.", "rate_limited", 429, True)
        if self.waiting >= self.max_queue:
            raise TTSError("The voice server is busy. Try again in a moment.", "busy", 429, True)
        self.waiting += 1
        t0 = time.monotonic()
        notes, last = [], None
        try:
            for engine, vname in order:
                try:
                    x, sr = await asyncio.to_thread(engine.synth, clean, vname, lang, speed, style if engine.caps.style else "")
                except TTSError as e:
                    last = e
                    log.warning("tts engine %s failed: %s", engine.name, e.code)
                    notes.append(f"{LABEL.get(engine.name, engine.name)} failed")
                    continue
                if len(x) < sr * 0.05:
                    last = TTSError("The voice engine returned no audio.", "no_audio", retryable=True)
                    continue
                wav = to_wav(x, sr)
                path = key if engine is e0 else self._cache_path(engine.name, engine.model, vname, lang, round(speed, 2), style, clean)
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(wav)
                self._prune()
                ms = int((time.monotonic() - t0) * 1000)
                log.info(json.dumps({"event": "tts", "user": uid, "engine": engine.name, "lang": lang, "chars": len(clean),
                                     "ms": ms, "audio_s": round(len(x) / sr, 2)}))
                return wav, {"engine": engine.name, "voice": f"{engine.name}:{vname}", "lang": lang, "cache": "miss", "ms": ms,
                             "fallback": "; ".join(notes)}
            raise last or TTSError("Speech failed.")
        finally:
            self.waiting -= 1
