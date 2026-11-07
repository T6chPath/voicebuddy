"""Hosted image providers. Keys come from server environment variables only and are never sent to the browser.

Gemini  POST {base}/v1beta/models/{model}:generateContent        header x-goog-api-key
        generationConfig.responseModalities ["TEXT","IMAGE"], imageConfig.aspectRatio; images come back as inlineData.
        Google's pricing page lists image output as paid-tier only for the Gemini image models — a free AI Studio key
        gets a quota error, which is reported as such.
OpenAI  POST {base}/images/generations (JSON) and {base}/images/edits (multipart, optional PNG mask whose transparent
        pixels mark the area to change). GPT image models return b64_json.
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
import random

from PIL import Image

from .base import ImageError, Inputs, Produced, Progress
from .safety import SafetyBlocked
from .spec import STYLES, ImageRequest, Op

log = logging.getLogger("zenvqo.images.hosted")
RETRY_STATUS = {429, 500, 502, 503, 504}


def _png(im: Image.Image) -> bytes:
    b = io.BytesIO()
    im.save(b, "PNG")
    return b.getvalue()


async def _post(send, label: str, attempts: int = 3):
    """Call `send()` → httpx.Response with retries on rate limits / server errors / timeouts."""
    import httpx
    delay = 1.5
    for i in range(attempts):
        try:
            r = await send()
        except httpx.TimeoutException as e:
            if i == attempts - 1:
                raise ImageError(f"{label} took too long to answer. Try again.", "timeout", retryable=True) from e
        except httpx.HTTPError as e:
            if i == attempts - 1:
                raise ImageError(f"Couldn't reach {label}. Check the server's internet connection.", "unreachable",
                                 retryable=True) from e
        else:
            if r.status_code not in RETRY_STATUS or i == attempts - 1 or _quota_zero(r):
                return r
            ra = r.headers.get("retry-after")
            delay = min(float(ra), 10.0) if ra and ra.replace(".", "", 1).isdigit() else delay
        await asyncio.sleep(delay + random.random() * 0.3)
        delay *= 2
    raise AssertionError("unreachable")


def _quota_zero(r) -> bool:
    return r.status_code == 429 and ("limit: 0" in r.text or "free_tier" in r.text.lower())


class GeminiProvider:
    name = "gemini"
    negative_prompt = False
    seed = False
    ops: set[Op] = {"generate", "edit", "variations", "style", "inpaint", "remove_object", "remove_background", "replace_background"}

    def __init__(self):
        self.model = os.environ.get("ZC_GEMINI_IMAGE_MODEL", "gemini-2.5-flash-image")
        self.base = os.environ.get("ZC_GEMINI_BASE_URL", "https://generativelanguage.googleapis.com").rstrip("/")
        self.key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or ""
        self.unavailable_reason = None if self.key else "GEMINI_API_KEY is not set on the server."

    def _instruction(self, req: ImageRequest, has_mask: bool) -> str:
        style = STYLES.get(req.style, ("", ""))[0]
        avoid = f" Avoid: {req.negative_prompt}." if req.negative_prompt else ""
        p = req.prompt.strip()
        if req.op == "generate":
            return f"Generate an image: {req.styled_prompt()}.{avoid}"
        if req.op == "style":
            return f"Redraw this image in this style: {style or p}. Keep the same subject and composition.{avoid}"
        if req.op == "variations":
            return f"Create a new variation of this image: same subject and style, different details and composition. {p}{avoid}"
        if req.op == "remove_background":
            return "Remove the background completely. Put the subject alone on a plain pure white background. Do not change the subject."
        if req.op == "replace_background":
            return f"Replace the background with: {req.background or p}. Keep the subject exactly as it is.{avoid}"
        if req.op == "remove_object":
            where = " The second image is a mask: remove only what is under the white area." if has_mask else ""
            return f"Remove {p or 'the marked object'} from this image and fill the area so it looks natural. Change nothing else.{where}"
        where = " The second image is a mask: change only the area under the white part, keep everything else identical." if has_mask else ""
        return f"Edit this image: {p}.{(' Style: ' + style + '.') if style else ''}{avoid}{where}"

    async def run(self, req: ImageRequest, inp: Inputs, progress: Progress) -> list[Produced]:
        import httpx
        parts: list[dict] = [{"text": self._instruction(req, inp.mask is not None)}]
        for im in (inp.source, inp.mask):
            if im is not None:
                parts.append({"inlineData": {"mimeType": "image/png", "data": base64.b64encode(_png(im)).decode()}})
        cfg: dict = {"responseModalities": ["TEXT", "IMAGE"]}
        if req.op == "generate":
            cfg["imageConfig"] = {"aspectRatio": req.aspect_ratio}
        body = {"contents": [{"role": "user", "parts": parts}], "generationConfig": cfg}
        url = f"{self.base}/v1beta/models/{self.model}:generateContent"
        notes = []
        if req.negative_prompt:
            notes.append("Gemini has no negative-prompt setting, so it was added to the instructions as “avoid …”.")
        if req.seed is not None:
            notes.append("Gemini doesn't support seeds, so the same prompt can give a different image.")
        if inp.mask is not None:
            notes.append("Gemini follows masks approximately (it's given the mask as a second picture).")
        if req.op == "remove_background":
            notes.append("Gemini can't make transparent images, so the subject is on white.")
        out: list[Produced] = []
        async with httpx.AsyncClient(timeout=httpx.Timeout(120, connect=10)) as c:
            for i in range(req.n):
                progress(i / req.n, f"Gemini is drawing image {i + 1} of {req.n}…" if req.n > 1 else "Gemini is drawing…")
                r = await _post(lambda: c.post(url, json=body, headers={"x-goog-api-key": self.key}), "Gemini")
                out.append(Produced(self._parse(r), None, notes if i == 0 else []))
        return out

    def _parse(self, r) -> Image.Image:
        try:
            j = r.json()
        except json.JSONDecodeError:
            j = {}
        if r.status_code != 200:
            msg = (j.get("error") or {}).get("message", "") if isinstance(j, dict) else ""
            if r.status_code == 429 and _quota_zero(r):
                raise ImageError("Your Gemini key has no image-generation quota. Google only offers the Gemini image "
                                 "models on the paid tier — enable billing for the key's project in Google AI Studio, "
                                 "or switch the server to the local model.", "quota", status=402)
            if r.status_code == 429:
                raise ImageError("Gemini's rate limit was reached. Wait a minute and try again.", "rate_limited", True, 429)
            if r.status_code in (401, 403) or "API key not valid" in msg:
                raise ImageError("Gemini rejected the server's API key.", "auth", status=502)
            if r.status_code == 404:
                raise ImageError(f"Gemini doesn't know the model “{self.model}”. Set ZC_GEMINI_IMAGE_MODEL.", "config")
            raise ImageError(f"Gemini returned an error ({r.status_code}). {msg[:200]}".strip(), "provider_error",
                             retryable=r.status_code >= 500)
        if (j.get("promptFeedback") or {}).get("blockReason"):
            raise SafetyBlocked("Gemini declined this request under its safety rules.")
        cands = j.get("candidates") or []
        for cand in cands:
            for part in (cand.get("content") or {}).get("parts") or []:
                data = part.get("inlineData") or part.get("inline_data")
                if data and not part.get("thought") and str(data.get("mimeType", data.get("mime_type", ""))).startswith("image/"):
                    return Image.open(io.BytesIO(base64.b64decode(data["data"]))).convert("RGB")
        reason = (cands[0].get("finishReason") if cands else "") or ""
        if "SAFETY" in reason or "PROHIBITED" in reason or reason in ("BLOCKLIST", "SPII"):
            raise SafetyBlocked("Gemini declined to make this image under its safety rules.")
        text = " ".join(p.get("text", "") for c in cands for p in (c.get("content") or {}).get("parts") or [] if p.get("text"))
        raise ImageError("Gemini answered without an image" + (f": “{text[:160]}”" if text else ".") + " Try rephrasing.",
                         "no_image", retryable=True)


class OpenAIImageProvider:
    name = "openai"
    negative_prompt = False
    seed = False
    ops: set[Op] = {"generate", "edit", "variations", "style", "inpaint", "remove_object", "remove_background", "replace_background"}

    def __init__(self):
        self.model = os.environ.get("ZC_OPENAI_IMAGE_MODEL", "gpt-image-1")
        self.base = os.environ.get("ZC_OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
        self.key = os.environ.get("OPENAI_API_KEY", "")
        self.quality = os.environ.get("ZC_OPENAI_IMAGE_QUALITY", "medium")
        self.unavailable_reason = None if self.key else "OPENAI_API_KEY is not set on the server."

    @staticmethod
    def _size(aspect: str) -> str:
        a, b = (int(x) for x in aspect.split(":"))
        return "1024x1024" if abs(a / b - 1) < 0.15 else ("1536x1024" if a > b else "1024x1536")

    def _prompt(self, req: ImageRequest) -> str:
        p = req.prompt.strip()
        style = STYLES.get(req.style, ("", ""))[0]
        avoid = f" Avoid: {req.negative_prompt}." if req.negative_prompt else ""
        return {
            "generate": f"{req.styled_prompt()}.{avoid}",
            "edit": f"{p}.{(' Style: ' + style + '.') if style else ''}{avoid}",
            "inpaint": f"{p}.{avoid}",
            "style": f"Redraw this image in this style: {style or p}. Keep the subject and composition.{avoid}",
            "variations": f"A new variation of this image with the same subject and style. {p}{avoid}",
            "remove_object": f"Remove {p or 'the object in the masked area'} and fill the area naturally. Change nothing else.",
            "remove_background": "Remove the background entirely and keep the subject exactly as it is, on a transparent background.",
            "replace_background": f"Replace the background with {req.background or p}. Keep the subject exactly as it is.{avoid}",
        }[req.op]

    async def run(self, req: ImageRequest, inp: Inputs, progress: Progress) -> list[Produced]:
        import httpx
        h = {"Authorization": f"Bearer {self.key}"}
        size = self._size(req.aspect_ratio) if req.op == "generate" or inp.source is None else \
            self._size(f"{inp.source.width}:{inp.source.height}" if inp.source.width and inp.source.height else "1:1")
        fields = {"model": self.model, "prompt": self._prompt(req), "n": str(req.n), "size": size, "quality": self.quality}
        if req.op == "remove_background":
            fields["background"] = "transparent"
            fields["output_format"] = "png"
        progress(0.05, "OpenAI is drawing…")
        async with httpx.AsyncClient(timeout=httpx.Timeout(180, connect=10)) as c:
            if req.op == "generate":
                body = {**fields, "n": req.n}
                r = await _post(lambda: c.post(self.base + "/images/generations", json=body, headers=h), "OpenAI")
            else:
                files = [("image", ("image.png", _png(inp.source), "image/png"))]
                if inp.mask is not None:
                    alpha = inp.mask.point(lambda v: 0 if v >= 128 else 255)          # transparent = change
                    m = Image.new("RGBA", inp.source.size, (0, 0, 0, 255))
                    m.putalpha(alpha.resize(inp.source.size))
                    files.append(("mask", ("mask.png", _png(m), "image/png")))
                r = await _post(lambda: c.post(self.base + "/images/edits", data=fields, files=files, headers=h), "OpenAI")
        out = [Produced(im, None, []) for im in self._parse(r)]
        notes = []
        if req.negative_prompt:
            notes.append("OpenAI has no negative-prompt setting, so it was added to the prompt as “avoid …”.")
        if req.seed is not None:
            notes.append("OpenAI image models don't support seeds.")
        if out:
            out[0].notes = notes
        return out

    def _parse(self, r) -> list[Image.Image]:
        try:
            j = r.json()
        except json.JSONDecodeError:
            j = {}
        if r.status_code != 200:
            err = (j.get("error") or {}) if isinstance(j, dict) else {}
            code, msg = err.get("code") or "", err.get("message") or ""
            if code == "moderation_blocked" or "safety system" in msg:
                raise SafetyBlocked("OpenAI declined this image under its safety rules.")
            if r.status_code == 401:
                raise ImageError("OpenAI rejected the server's API key.", "auth")
            if r.status_code == 403 and "verif" in msg.lower():
                raise ImageError("OpenAI requires organization verification before GPT image models can be used.", "auth")
            if r.status_code == 429:
                raise ImageError("OpenAI's rate limit or quota was reached.", "rate_limited", True, 429)
            raise ImageError(f"OpenAI returned an error ({r.status_code}). {msg[:200]}".strip(), "provider_error",
                             retryable=r.status_code >= 500)
        ims = [Image.open(io.BytesIO(base64.b64decode(d["b64_json"]))) for d in j.get("data", []) if d.get("b64_json")]
        if not ims:
            raise ImageError("OpenAI answered without an image.", "no_image", retryable=True)
        return [im.convert("RGBA") if im.mode in ("RGBA", "LA", "P") else im.convert("RGB") for im in ims]
