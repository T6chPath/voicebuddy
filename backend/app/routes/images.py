"""Image API outside chat (scripts, other apps). Chat uses the same service through tool calls.

GET  /api/images/capabilities           → what's configured and why something isn't
POST /api/images  {op, prompt, …}       → {"images": [attachment…], "notes": [...]}   (blocks until done)
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import Field

from ..deps import current_user
from ..images.base import ImageError
from ..images.safety import SafetyBlocked
from ..images.service import ImageService
from ..images.spec import ImageRequest
from ..schemas import ImageOptionsIn

router = APIRouter(prefix="/api/images", tags=["images"])


class ImageJobIn(ImageOptionsIn):
    op: str = Field(default="generate", max_length=32)  # type: ignore[assignment]
    prompt: str = Field(default="", max_length=2000)
    background: str = Field(default="", max_length=500)


def svc_of(request: Request) -> ImageService:
    return request.app.state.images


@router.get("/capabilities")
def capabilities(user: dict = Depends(current_user), svc: ImageService = Depends(svc_of)):
    return svc.capabilities()


@router.post("")
async def create(body: ImageJobIn, user: dict = Depends(current_user), svc: ImageService = Depends(svc_of)):
    d = body.model_dump(exclude_none=True)
    req = ImageRequest(op=d.get("op", "generate"), prompt=d.get("prompt", ""), negative_prompt=d.get("negative_prompt", ""),
                       style=d.get("style", "none"), aspect_ratio=d.get("aspect_ratio", "1:1"), resolution=d.get("resolution", 512),
                       seed=d.get("seed"), n=d.get("n", 1), output_format=d.get("output_format", "png"),
                       strength=d.get("strength", 0.6), source_id=d.get("source_id"), mask_id=d.get("mask_id"),
                       background=d.get("background", ""))
    try:
        images, notes = await svc.run(user["id"], None, req, lambda f, t: None)
    except SafetyBlocked as e:
        raise HTTPException(422, str(e)) from e
    except ImageError as e:
        raise HTTPException(e.status if 400 <= e.status < 600 else 502, str(e)) from e
    return {"images": images, "notes": notes}
