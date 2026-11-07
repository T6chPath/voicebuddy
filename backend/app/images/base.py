from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Protocol

from PIL import Image

from .spec import ImageRequest, Op

Progress = Callable[[float, str], None]          # (fraction 0..1, status text)


class ImageError(RuntimeError):
    def __init__(self, message: str, code: str = "image_error", retryable: bool = False, status: int = 502):
        super().__init__(message)
        self.code, self.retryable, self.status = code, retryable, status


@dataclass
class Produced:
    image: Image.Image
    seed: int | None = None
    notes: list[str] = field(default_factory=list)


@dataclass
class Inputs:
    source: Image.Image | None = None          # RGB
    mask: Image.Image | None = None            # L, 255 = change


class ImageProvider(Protocol):
    name: str
    model: str
    ops: set[Op]
    negative_prompt: bool
    seed: bool
    unavailable_reason: str | None              # None = ready

    async def run(self, req: ImageRequest, inp: Inputs, progress: Progress) -> list[Produced]: ...
