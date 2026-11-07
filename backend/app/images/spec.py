"""What an image request can ask for, independent of which provider runs it."""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Literal

Op = Literal["generate", "edit", "variations", "style", "inpaint", "remove_object", "remove_background", "replace_background"]
OPS: tuple[Op, ...] = ("generate", "edit", "variations", "style", "inpaint", "remove_object", "remove_background", "replace_background")
NEEDS_SOURCE = set(OPS) - {"generate"}
NEEDS_PROMPT = {"generate", "edit", "inpaint", "replace_background"}

# Style presets: words added to the prompt, and things to steer away from (where negative prompts work).
STYLES: dict[str, tuple[str, str]] = {
    "none": ("", ""),
    "photorealistic": ("photorealistic, natural lighting, sharp focus, high detail, 35mm photograph",
                       "cartoon, illustration, painting, drawing, cgi, lowres, blurry"),
    "anime": ("anime style, cel shading, clean line art, vibrant colors, detailed anime illustration",
              "photorealistic, photo, 3d render, lowres, blurry"),
    "3d": ("3d render, octane render, soft global illumination, physically based materials, highly detailed",
           "flat, sketch, painting, lowres, blurry"),
    "cinematic": ("cinematic film still, dramatic lighting, shallow depth of field, anamorphic, color graded",
                  "cartoon, flat lighting, lowres, blurry"),
    "cartoon": ("cartoon style, bold outlines, flat colors, playful, clean vector look",
                "photorealistic, photo, lowres, blurry"),
    "digital-art": ("digital art, concept art, trending on artstation, highly detailed, vivid colors",
                    "photo, lowres, blurry"),
    "illustration": ("illustration, storybook art, textured brush strokes, soft colors",
                     "photo, 3d render, lowres, blurry"),
    "logo": ("minimal vector logo, flat design, simple shapes, centered, plain background, crisp edges",
             "photo, photorealistic, clutter, gradient noise, lowres"),
}
STYLE_ALIASES = {
    "realistic": "photorealistic", "photo": "photorealistic", "photograph": "photorealistic", "real": "photorealistic",
    "3d render": "3d", "3-d": "3d", "render": "3d", "movie": "cinematic", "film": "cinematic",
    "cartoonish": "cartoon", "comic": "cartoon", "digital art": "digital-art", "digital": "digital-art",
    "concept art": "digital-art", "illustrated": "illustration", "drawing": "illustration", "manga": "anime",
}
ASPECTS = ("1:1", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "4:5", "5:4", "21:9")
FORMATS = ("png", "jpeg", "webp")


def norm_style(s: str | None) -> str:
    s = (s or "none").strip().lower()
    s = STYLE_ALIASES.get(s, s)
    return s if s in STYLES else "none"


@dataclass
class ImageRequest:
    op: Op
    prompt: str = ""
    negative_prompt: str = ""
    style: str = "none"
    aspect_ratio: str = "1:1"
    resolution: int = 512                 # length of the longer side, before provider rounding
    seed: int | None = None
    n: int = 1
    output_format: str = "png"
    strength: float = 0.6                 # img2img: how far to move away from the source (0..1)
    source_id: str | None = None          # file id of the image to change
    mask_id: str | None = None            # file id of a mask: white = change, black = keep
    background: str = ""                  # replace_background: what goes behind the subject
    context_prompt: str = ""              # prompt that made the source image (helps models that repaint, like local SD)
    notes: list[str] = field(default_factory=list)   # limitations reported back to the user

    def clamp(self, max_n: int, max_res: int) -> "ImageRequest":
        r = replace(self)
        r.style = norm_style(r.style)
        r.aspect_ratio = r.aspect_ratio if r.aspect_ratio in ASPECTS else "1:1"
        r.resolution = max(256, min(int(r.resolution or 512), max_res))
        r.n = max(1, min(int(r.n or 1), max_n))
        r.output_format = (r.output_format or "png").lower().replace("jpg", "jpeg")
        if r.output_format not in FORMATS:
            r.output_format = "png"
        r.strength = max(0.1, min(float(r.strength), 1.0))
        r.prompt, r.negative_prompt, r.background = r.prompt[:2000], r.negative_prompt[:1000], r.background[:500]
        r.context_prompt = r.context_prompt[:1000]
        if r.seed is not None:
            r.seed = int(r.seed) % (2**32)
        return r

    def styled_prompt(self) -> str:
        add = STYLES.get(self.style, ("", ""))[0]
        return f"{self.prompt}, {add}" if add and self.prompt else (self.prompt or add)

    def styled_negative(self) -> str:
        parts = [self.negative_prompt, STYLES.get(self.style, ("", ""))[1]]
        return ", ".join(p for p in parts if p)


def size_for(aspect: str, longest: int, multiple: int = 64) -> tuple[int, int]:
    a, b = (int(x) for x in aspect.split(":"))
    if a >= b:
        w, h = longest, longest * b / a
    else:
        w, h = longest * a / b, longest
    rnd = lambda v: max(multiple, int(round(v / multiple)) * multiple)  # noqa: E731
    return rnd(w), rnd(h)
