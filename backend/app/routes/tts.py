"""Text-to-speech API. Keys for hosted engines stay in the server's environment.

GET  /api/tts/voices                                    → engines, voices (with gender), languages, defaults, or why not
POST /api/tts {text, voice?, lang?, speed?, style?, gender?}  → audio/wav for one sentence
     headers: X-TTS-Engine, X-TTS-Voice, X-TTS-Lang, X-TTS-Cache, X-TTS-Ms
"""
from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import Field

from ..deps import current_user
from ..schemas import Strict
from ..tts.engines import TTSError
from ..tts.service import TTSService

router = APIRouter(prefix="/api/tts", tags=["tts"])


class SpeakIn(Strict):
    text: str = Field(min_length=1, max_length=4000)
    voice: str | None = Field(default=None, max_length=80)
    lang: Literal["en", "hi", "hinglish", "es", "fr", "it", "pt"] | None = None
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    style: str = Field(default="", max_length=120)
    gender: Literal["female", "male"] = "female"


def svc_of(request: Request) -> TTSService:
    return request.app.state.tts


@router.get("/voices")
def voices(user: dict = Depends(current_user), svc: TTSService = Depends(svc_of)):
    return svc.catalog()


@router.post("")
async def speak(body: SpeakIn, user: dict = Depends(current_user), svc: TTSService = Depends(svc_of)):
    try:
        wav, info = await svc.speak(user["id"], body.text, body.voice, body.lang, body.speed, body.style, body.gender)
    except TTSError as e:
        raise HTTPException(e.status, str(e), headers={"X-TTS-Error": e.code}) from e
    return Response(wav, media_type="audio/wav", headers={
        "X-TTS-Engine": info["engine"], "X-TTS-Voice": info["voice"], "X-TTS-Lang": info["lang"],
        "X-TTS-Cache": info["cache"], "X-TTS-Ms": str(info["ms"]), "Cache-Control": "private, max-age=86400",
        "Access-Control-Expose-Headers": "X-TTS-Engine, X-TTS-Voice, X-TTS-Lang, X-TTS-Cache, X-TTS-Ms"})
