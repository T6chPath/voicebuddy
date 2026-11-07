from __future__ import annotations

import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$")


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class RegisterIn(Strict):
    email: str = Field(max_length=254)
    name: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=8, max_length=200)

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        v = v.lower()
        if not EMAIL.match(v):
            raise ValueError("enter a valid email address")
        return v


class LoginIn(Strict):
    email: str = Field(max_length=254)
    password: str = Field(min_length=1, max_length=200)

    @field_validator("email")
    @classmethod
    def _lower(cls, v: str) -> str:
        return v.lower()


class UserOut(BaseModel):
    id: str
    email: str
    name: str


class SettingsIn(Strict):
    theme: Literal["system", "light", "dark"] = "system"
    default_model: str = Field(default="zenvqo-local", max_length=64)
    temperature: float = Field(default=0.7, ge=0, le=2)
    system_prompt: str = Field(default="", max_length=4000)
    font_size: Literal["small", "medium", "large"] = "medium"
    send_on_enter: bool = True
    show_timestamps: bool = False


class ConversationIn(Strict):
    title: str | None = Field(default=None, max_length=120)
    model: str | None = Field(default=None, max_length=64)


class ConversationPatch(Strict):
    title: str | None = Field(default=None, min_length=1, max_length=120)
    pinned: bool | None = None
    model: str | None = Field(default=None, max_length=64)


class ImageOptionsIn(Strict):
    """Explicit image controls from the UI. op=None lets the assistant decide from the text."""
    op: Literal["generate", "edit", "variations", "style", "inpaint", "remove_object", "remove_background",
                "replace_background"] | None = None
    style: str | None = Field(default=None, max_length=32)
    aspect_ratio: str | None = Field(default=None, max_length=8)
    resolution: int | None = Field(default=None, ge=256, le=2048)
    n: int | None = Field(default=None, ge=1, le=8)
    seed: int | None = Field(default=None, ge=0, le=2**32 - 1)
    negative_prompt: str | None = Field(default=None, max_length=1000)
    output_format: Literal["png", "jpeg", "webp"] | None = None
    strength: float | None = Field(default=None, ge=0.1, le=1.0)
    source_id: str | None = Field(default=None, max_length=64)
    mask_id: str | None = Field(default=None, max_length=64)


class MessageIn(Strict):
    content: str = Field(min_length=1, max_length=32000)
    model: str | None = Field(default=None, max_length=64)
    file_ids: list[str] = Field(default_factory=list, max_length=5)
    image: ImageOptionsIn | None = None
