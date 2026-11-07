"""Speech recognition service: engine fallback, limits, partial (live) transcripts, content-free logging.

Config (environment):
  ZC_ASR_ENGINES      auto | none | comma list ("whisper,openai")    auto = every ready engine, local Whisper first
  ZC_ASR_MODEL        faster-whisper model: tiny | base | small (default) | medium | large-v3-turbo | path
  ZC_ASR_RATE         "<seconds of audio>/<window seconds>" per user (default 1800/3600)
  ZC_ASR_MAX_S        longest single utterance in seconds (default 30)
  ZC_ASR_PARTIAL_S    how often to re-decode for live captions while someone speaks (default 1.2; local Whisper only)
Audio stays in memory for the length of one utterance and is never stored.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
import time
from collections import defaultdict, deque

import numpy as np

from .engines import SR, ASRError, build_engines, clean, level_db

log = logging.getLogger("zenvqo.asr")
LABEL = {"whisper": "local Whisper", "openai": "OpenAI", "gemini": "Gemini"}


class SecondsLimiter:
    def __init__(self, seconds: float, window: float):
        self.seconds, self.window = seconds, window
        self.hits: dict[str, deque] = defaultdict(deque)
        self.lock = threading.Lock()

    def take(self, key: str, s: float) -> float:
        now = time.monotonic()
        with self.lock:
            q = self.hits[key]
            while q and now - q[0][0] > self.window:
                q.popleft()
            if sum(x for _, x in q) + s > self.seconds:
                return round(self.window - (now - q[0][0]), 1) if q else self.window
            q.append((now, s))
        return 0.0


class ASRService:
    def __init__(self, engines: list | None = None):
        self.engines = build_engines() if engines is None else engines
        n, _, w = os.environ.get("ZC_ASR_RATE", "1800/3600").partition("/")
        self.limiter = SecondsLimiter(float(n), float(w or 3600))
        self.max_s = float(os.environ.get("ZC_ASR_MAX_S", "30"))
        self.partial_every = float(os.environ.get("ZC_ASR_PARTIAL_S", "1.2"))
        self.sessions: dict[str, int] = defaultdict(int)

    def ready(self):
        return [e for e in self.engines if e.unavailable_reason is None]

    @property
    def available(self) -> bool:
        return bool(self.ready())

    def reason(self) -> str:
        if not self.engines:
            return "Server speech recognition is turned off (ZC_ASR_ENGINES=none)."
        return " ".join(f"{LABEL.get(e.name, e.name)}: {e.unavailable_reason}" for e in self.engines if e.unavailable_reason)

    def partials(self) -> bool:
        r = self.ready()
        return bool(r) and bool(getattr(r[0], "partials", False))

    def config(self) -> dict:
        return {"available": self.available, "reason": None if self.available else self.reason(),
                "engines": [{"name": e.name, "model": e.model, "ready": e.unavailable_reason is None, "reason": e.unavailable_reason,
                             "partials": bool(getattr(e, "partials", False))} for e in self.engines],
                "partials": self.partials(), "max_seconds": self.max_s, "sample_rate": SR,
                "languages": ["auto", "en", "hi", "hinglish"], "stores_audio": False}

    async def transcribe(self, uid: str, audio: np.ndarray, lang: str = "auto") -> dict:
        if not self.available:
            raise ASRError("Server speech recognition isn't available: " + self.reason(), "unavailable", 503)
        secs = len(audio) / SR
        if secs < 0.2:
            return {"text": "", "lang": lang, "confidence": "empty", "engine": None, "ms": 0, "audio_s": round(secs, 2)}
        if secs > self.max_s + 1:
            raise ASRError(f"That was longer than {int(self.max_s)} seconds — say it in shorter parts.", "too_long", 413)
        wait = self.limiter.take("asr:" + uid, secs)
        if wait:
            raise ASRError(f"Voice limit reached — try again in {int(wait // 60) + 1} min.", "rate_limited", 429, True)
        if level_db(audio) < -60:
            return {"text": "", "lang": lang, "confidence": "empty", "engine": None, "ms": 0, "audio_s": round(secs, 2)}
        last = None
        t0 = time.monotonic()
        for e in self.ready():
            try:
                text, detected = await asyncio.to_thread(e.transcribe, audio, lang, False)
            except ASRError as err:
                last = err
                log.warning("asr engine %s failed: %s", e.name, err.code)
                continue
            text, conf = clean(text, secs)
            ms = int((time.monotonic() - t0) * 1000)
            log.info(json.dumps({"event": "asr", "user": uid, "engine": e.name, "lang": detected, "audio_s": round(secs, 2),
                                 "ms": ms, "chars": len(text), "confidence": conf}))       # no transcript text in logs
            return {"text": text, "lang": detected, "confidence": conf, "engine": e.name, "ms": ms, "audio_s": round(secs, 2)}
        raise last or ASRError("Speech recognition failed.")

    async def partial(self, audio: np.ndarray, lang: str) -> str | None:
        r = self.ready()
        if not r or not getattr(r[0], "partials", False):
            return None
        try:
            text, _ = await asyncio.to_thread(r[0].transcribe, audio, lang, True)
        except ASRError:
            return None
        return clean(text, len(audio) / SR)[0] or None
