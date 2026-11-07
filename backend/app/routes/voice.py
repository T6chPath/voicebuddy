"""Voice input: streaming speech recognition over a WebSocket, with a plain HTTP upload as fallback.

GET  /api/voice/config                         → what's available (engines, live captions, limits) or why not
POST /api/voice/transcribe?lang=auto  (WAV)    → {text, lang, confidence, engine, ms, audio_s}      — fallback path
WS   /api/voice/ws                             → streaming session (same-origin, signed-in only; wss:// behind HTTPS)

WebSocket protocol — client → server:
  {"type":"start","lang":"auto|en|hi|hinglish"}   begin an utterance (client VAD detected speech)
  <binary> 16 kHz mono PCM16 little-endian frames (any size, typically 20–60 ms)
  {"type":"end"}                                   end of utterance (client VAD detected silence) → final transcript
  {"type":"cancel"}                                drop the current utterance
  {"type":"ping"}
server → client:
  {"type":"ready","partials":bool,"engine":…,"max_seconds":…}
  {"type":"partial","text":…}                      live caption while the person is still speaking
  {"type":"final","text":…,"lang":…,"confidence":…,"engine":…,"ms":{"decode":…,"after_end":…},"audio_s":…}
  {"type":"error","code":…,"message":…,"retryable":bool}   ·   {"type":"pong"}
"""
from __future__ import annotations

import asyncio
import json
import time

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Request
from starlette.websockets import WebSocket, WebSocketDisconnect

from ..asr.engines import SR, ASRError, decode_wav
from ..asr.service import ASRService
from ..db import now
from ..deps import current_user
from ..security import COOKIE, token_hash

router = APIRouter(prefix="/api/voice", tags=["voice"])
MAX_UPLOAD = 6 * 1024 * 1024
LANGS = {"auto", "en", "hi", "hinglish"}


def svc_of(request: Request) -> ASRService:
    return request.app.state.asr


@router.get("/config")
def config(user: dict = Depends(current_user), svc: ASRService = Depends(svc_of)):
    return svc.config()


@router.post("/transcribe")
async def transcribe(request: Request, lang: str = "auto", user: dict = Depends(current_user), svc: ASRService = Depends(svc_of)):
    data = await request.body()
    if len(data) > MAX_UPLOAD:
        raise HTTPException(413, "That recording is too long.")
    try:
        audio = decode_wav(data)
        return await svc.transcribe(user["id"], audio, lang if lang in LANGS else "auto")
    except ASRError as e:
        raise HTTPException(e.status, str(e), headers={"X-ASR-Error": e.code}) from e


def ws_user(ws: WebSocket) -> dict | None:
    tok = ws.cookies.get(COOKIE)
    if not tok:
        return None
    row = ws.app.state.db.one("SELECT u.id, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?",
                              (token_hash(tok),))
    return row if row and row["expires_at"] > now() else None


def origin_ok(ws: WebSocket) -> bool:
    """Browsers always send Origin on WebSocket handshakes: refuse other sites (cross-site WebSocket hijacking)."""
    origin = ws.headers.get("origin")
    if not origin:
        return True                                     # non-browser client; the session cookie still has to be valid
    host = ws.headers.get("host", "")
    return origin in ws.app.state.settings.allowed_origins or origin.split("://", 1)[-1] == host


async def voice_ws(ws: WebSocket):
    svc: ASRService = ws.app.state.asr
    user = ws_user(ws)
    if not origin_ok(ws):
        await ws.close(code=4403)
        return
    if not user:
        await ws.close(code=4401)
        return
    uid = user["id"]
    if svc.sessions[uid] >= 2:
        await ws.close(code=4429)
        return
    await ws.accept()
    svc.sessions[uid] += 1
    send_lock = asyncio.Lock()

    async def send(obj):
        async with send_lock:
            await ws.send_text(json.dumps(obj, ensure_ascii=False))

    chunks: list[np.ndarray] = []
    n_samples, lang, collecting, utt = 0, "auto", False, 0
    partial_task: asyncio.Task | None = None
    last_partial = 0.0

    async def run_partial(my: int, audio: np.ndarray):
        text = await svc.partial(audio, lang)
        if text and my == utt and collecting:
            await send({"type": "partial", "text": text})

    async def finish():
        nonlocal chunks, n_samples, collecting, partial_task
        collecting = False
        t_end = time.monotonic()
        if partial_task and not partial_task.done():
            partial_task.cancel()
        audio = np.concatenate(chunks) if chunks else np.zeros(0, np.float32)
        chunks, n_samples = [], 0
        try:
            res = await svc.transcribe(uid, audio, lang)
            res["ms"] = {"decode": res["ms"], "after_end": int((time.monotonic() - t_end) * 1000)}
            await send({"type": "final", **res})
        except ASRError as e:
            await send({"type": "error", "code": e.code, "message": str(e), "retryable": e.retryable})

    if not svc.available:
        await send({"type": "error", "code": "unavailable", "message": "Server speech recognition isn't available: " + svc.reason(),
                    "retryable": False})
    else:
        await send({"type": "ready", "partials": svc.partials(), "engine": svc.ready()[0].name, "max_seconds": svc.max_s})
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg.get("bytes") is not None:
                if not collecting:
                    continue
                b = msg["bytes"]
                x = np.frombuffer(b[: len(b) // 2 * 2], dtype="<i2").astype(np.float32) / 32768
                chunks.append(x)
                n_samples += len(x)
                if n_samples / SR > svc.max_s:
                    await send({"type": "error", "code": "too_long", "message": f"Stopped listening after {int(svc.max_s)} seconds.",
                                "retryable": False})
                    await finish()
                    continue
                t = time.monotonic()
                if (svc.partials() and n_samples > SR and t - last_partial >= svc.partial_every
                        and (partial_task is None or partial_task.done())):
                    last_partial = t
                    partial_task = asyncio.create_task(run_partial(utt, np.concatenate(chunks)))
                continue
            try:
                m = json.loads(msg.get("text") or "{}")
            except json.JSONDecodeError:
                continue
            kind = m.get("type")
            if kind == "start":
                utt += 1
                chunks, n_samples, collecting, last_partial = [], 0, True, time.monotonic()
                lang = m.get("lang") if m.get("lang") in LANGS else "auto"
            elif kind == "end" and collecting:
                await finish()
            elif kind == "cancel":
                utt += 1
                chunks, n_samples, collecting = [], 0, False
            elif kind == "ping":
                await send({"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        svc.sessions[uid] -= 1
        if partial_task and not partial_task.done():
            partial_task.cancel()
