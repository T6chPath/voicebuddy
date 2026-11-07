"""Local image provider — runs on your own CPU (or GPU if present). No API key, nothing leaves the machine.

  text→image, image→image, variations, style:  diffusers + a Stable Diffusion checkpoint (default stabilityai/sd-turbo)
  remove / replace background:                 rembg (U²-Net, MIT) — cut-out is pixel-exact, not repainted
  inpaint / remove object (needs a mask):      OpenCV fill + masked image→image, blended back with a feathered mask
  output check:                                 optional NSFW image classifier (Falconsai/nsfw_image_detection)

Install:   pip install -r requirements-images.txt
Pre-fetch: python -m app.images.local --download          (~2.6 GB for sd-turbo, ~170 MB for u2net)
"""
from __future__ import annotations

import asyncio
import gc
import logging
import math
import os
import random
import threading
import time

import numpy as np
from PIL import Image, ImageFilter

from .base import ImageError, Inputs, Produced, Progress
from .spec import STYLES, ImageRequest, Op, size_for

log = logging.getLogger("zenvqo.images.local")
COLOR_WORDS = {"white": (255, 255, 255), "black": (0, 0, 0), "grey": (128, 128, 128), "gray": (128, 128, 128),
               "red": (220, 38, 38), "green": (22, 163, 74), "blue": (37, 99, 235), "yellow": (250, 204, 21),
               "pink": (236, 72, 153), "purple": (147, 51, 234), "orange": (249, 115, 22), "transparent": None}


def _have(mod: str) -> bool:
    try:
        __import__(mod)
        return True
    except Exception:          # noqa: BLE001 — broken installs count as missing
        return False


class LocalProvider:
    name = "local"

    def __init__(self, model: str | None = None, device: str | None = None):
        self.model = model or os.environ.get("ZC_LOCAL_IMAGE_MODEL", "stabilityai/sd-turbo")
        self.turbo = "turbo" in self.model.lower()
        self.steps = int(os.environ.get("ZC_LOCAL_STEPS", "4" if self.turbo else "25"))
        self.guidance = float(os.environ.get("ZC_LOCAL_GUIDANCE", "0" if self.turbo else "7"))
        self.rembg_model = os.environ.get("ZC_LOCAL_REMBG_MODEL", "u2net")
        self.nsfw_check = os.environ.get("ZC_LOCAL_NSFW_CHECK", "1") == "1"
        self.nsfw_model = os.environ.get("ZC_LOCAL_NSFW_MODEL", "Falconsai/nsfw_image_detection")
        self.idle_s = float(os.environ.get("ZC_LOCAL_IDLE_UNLOAD_S", "900"))
        self._device = device or os.environ.get("ZC_LOCAL_DEVICE", "")
        self.negative_prompt = self.guidance > 1          # turbo models ignore negative prompts (guidance 0)
        self.seed = True
        self._lock = threading.Lock()                     # one inference at a time: CPU/RAM bound
        self._t2i = self._i2i = self._rembg = self._nsfw = None
        self._last_used = 0.0
        self._timer: threading.Timer | None = None

        has_sd = _have("torch") and _have("diffusers") and _have("transformers")
        has_rembg = _have("rembg")
        self.ops: set[Op] = set()
        if has_sd:
            self.ops |= {"generate", "edit", "variations", "style"}
            if _have("cv2"):
                self.ops |= {"inpaint", "remove_object"}
        if has_rembg:
            self.ops.add("remove_background")
            if has_sd:
                self.ops.add("replace_background")
        missing = [m for m, ok in (("torch", _have("torch")), ("diffusers", _have("diffusers")),
                                   ("transformers", _have("transformers")), ("rembg", has_rembg)) if not ok]
        self.unavailable_reason = None if self.ops else (
            "The local image model isn't installed on the server (missing: " + ", ".join(missing) +
            "). Run: pip install -r requirements-images.txt")
        self.missing = missing

    # ---------------- model loading ----------------
    def device(self) -> str:
        if self._device:
            return self._device
        import torch
        return "cuda" if torch.cuda.is_available() else "cpu"

    def _load_sd(self):
        if self._t2i is None:
            import torch
            from diffusers import AutoPipelineForImage2Image, AutoPipelineForText2Image
            dev = self.device()
            dtype = torch.float16 if dev == "cuda" else torch.float32
            t0 = time.monotonic()
            try:
                pipe = AutoPipelineForText2Image.from_pretrained(self.model, torch_dtype=dtype, variant="fp16")
            except (OSError, ValueError):                      # checkpoint without an fp16 variant
                pipe = AutoPipelineForText2Image.from_pretrained(self.model, torch_dtype=dtype)
            if hasattr(pipe, "safety_checker"):
                pipe.safety_checker = None                     # replaced by our own prompt + output checks
            pipe.set_progress_bar_config(disable=True)
            pipe = pipe.to(dev)
            if dev == "cpu":
                pipe.enable_attention_slicing()
            self._t2i = pipe
            self._i2i = AutoPipelineForImage2Image.from_pipe(pipe)
            log.info("loaded %s on %s in %.1fs", self.model, dev, time.monotonic() - t0)
        return self._t2i, self._i2i

    def _load_rembg(self):
        if self._rembg is None:
            from rembg import new_session
            self._rembg = new_session(self.rembg_model)
        return self._rembg

    def _check_output(self, im: Image.Image):
        if not self.nsfw_check:
            return
        if self._nsfw is None:
            try:
                from transformers import pipeline
                self._nsfw = pipeline("image-classification", model=self.nsfw_model, device=-1)
            except Exception as e:      # noqa: BLE001
                raise ImageError("The image safety checker couldn't be loaded, so the image wasn't returned. "
                                 "Run `python -m app.images.local --download` with internet access "
                                 "(or set ZC_LOCAL_NSFW_CHECK=0 to turn the check off).", "safety_unavailable") from e
        scores = {r["label"].lower(): r["score"] for r in self._nsfw(im.convert("RGB"))}
        if scores.get("nsfw", 0) >= 0.7:
            from .safety import SafetyBlocked
            raise SafetyBlocked("The generated image was flagged as unsafe and was not shown.")

    def _touch(self):
        self._last_used = time.monotonic()
        if self._timer:
            self._timer.cancel()
        if self.idle_s > 0:
            self._timer = threading.Timer(self.idle_s + 1, self._maybe_unload)
            self._timer.daemon = True
            self._timer.start()

    def _maybe_unload(self):
        if time.monotonic() - self._last_used >= self.idle_s and self._lock.acquire(blocking=False):
            try:
                self._t2i = self._i2i = None
                gc.collect()
                log.info("unloaded idle image model")
            finally:
                self._lock.release()

    # ---------------- running ----------------
    async def run(self, req: ImageRequest, inp: Inputs, progress: Progress) -> list[Produced]:
        if req.op not in self.ops:
            raise ImageError(f"The local image model can't do “{req.op.replace('_', ' ')}”.", "unsupported", status=400)
        cancel = threading.Event()
        loop = asyncio.get_running_loop()

        def prog(frac: float, text: str):
            loop.call_soon_threadsafe(progress, frac, text)

        try:
            return await asyncio.to_thread(self._run_sync, req, inp, prog, cancel)
        except asyncio.CancelledError:
            cancel.set()              # the thread stops at the next denoising step
            raise

    def _run_sync(self, req: ImageRequest, inp: Inputs, prog, cancel: threading.Event) -> list[Produced]:
        if not self._lock.acquire(timeout=600):
            raise ImageError("The image model is busy. Try again in a minute.", "busy", retryable=True, status=429)
        try:
            self._touch()
            if req.op != "remove_background":
                prog(0.02, "Loading the image model…" if self._t2i is None else "Starting…")
            out = getattr(self, "_op_" + req.op)(req, inp, prog, cancel)
            for p in out:
                if req.op != "remove_background":
                    self._check_output(p.image)
            return out
        except ImageError:
            raise
        except Exception as e:      # noqa: BLE001
            from .safety import SafetyBlocked
            if isinstance(e, SafetyBlocked):
                raise
            if cancel.is_set():
                raise ImageError("Stopped.", "cancelled") from e
            if "out of memory" in str(e).lower() or isinstance(e, MemoryError):
                raise ImageError("The server ran out of memory. Try a smaller size or one image at a time.", "oom",
                                 retryable=True) from e
            log.exception("local image op failed")
            raise ImageError("The local image model failed. Check the server log.", "local_failed", retryable=True) from e
        finally:
            self._touch()
            self._lock.release()

    def _gen(self, seed: int | None):
        import torch
        s = seed if seed is not None else random.randrange(2**32)
        return torch.Generator("cpu").manual_seed(s), s

    def _callback(self, prog, cancel, base: float, span: float, total: int, label: str):
        def cb(pipe, step, _t, kw):
            if cancel.is_set():
                pipe._interrupt = True
            prog(base + span * (step + 1) / max(1, total), label)
            return kw
        return cb

    def _t2i_one(self, prompt: str, neg: str, w: int, h: int, seed, prog, cancel, base, span, label) -> Produced:
        t2i, _ = self._load_sd()
        g, s = self._gen(seed)
        kw = dict(prompt=prompt, width=w, height=h, num_inference_steps=self.steps, guidance_scale=self.guidance,
                  generator=g, callback_on_step_end=self._callback(prog, cancel, base, span, self.steps, label))
        if self.negative_prompt and neg:
            kw["negative_prompt"] = neg
        im = t2i(**kw).images[0]
        if cancel.is_set():
            raise ImageError("Stopped.", "cancelled")
        return Produced(im, s)

    def _i2i_one(self, src: Image.Image, prompt: str, neg: str, strength: float, seed, prog, cancel, base, span, label) -> Produced:
        _, i2i = self._load_sd()
        steps = max(self.steps, math.ceil(1 / strength)) if self.turbo else self.steps
        g, s = self._gen(seed)
        kw = dict(prompt=prompt, image=src, strength=strength, num_inference_steps=steps, guidance_scale=self.guidance,
                  generator=g, callback_on_step_end=self._callback(prog, cancel, base, span, max(1, int(steps * strength)), label))
        if self.negative_prompt and neg:
            kw["negative_prompt"] = neg
        im = i2i(**kw).images[0]
        if cancel.is_set():
            raise ImageError("Stopped.", "cancelled")
        return Produced(im, s)

    def _work_size(self, im: Image.Image, longest: int) -> tuple[int, int]:
        a = im.width / im.height
        if a >= 1:
            w, h = longest, longest / a
        else:
            w, h = longest * a, longest
        return max(64, int(w) // 8 * 8), max(64, int(h) // 8 * 8)

    def _notes(self, req: ImageRequest) -> list[str]:
        n = []
        if req.negative_prompt and not self.negative_prompt:
            n.append(f"{self.model.split('/')[-1]} ignores negative prompts, so “{req.negative_prompt[:60]}” wasn't applied.")
        return n

    def _op_generate(self, req, inp, prog, cancel):
        w, h = size_for(req.aspect_ratio, req.resolution, 8)
        out = []
        for i in range(req.n):
            seed = None if req.seed is None else req.seed + i
            p = self._t2i_one(req.styled_prompt(), req.styled_negative(), w, h, seed, prog, cancel,
                              i / req.n, 1 / req.n, f"Generating image {i + 1} of {req.n}" if req.n > 1 else "Generating")
            p.notes = self._notes(req) if i == 0 else []
            out.append(p)
        return out

    def _i2i_many(self, req, src, prompt, strength, prog, cancel, label):
        w, h = self._work_size(src, min(req.resolution, 768))
        work = src.resize((w, h), Image.LANCZOS)
        out = []
        for i in range(req.n):
            seed = None if req.seed is None else req.seed + i
            p = self._i2i_one(work, prompt, req.styled_negative(), strength, seed, prog, cancel, i / req.n, 1 / req.n,
                              f"{label} {i + 1} of {req.n}" if req.n > 1 else label)
            p.notes = self._notes(req) if i == 0 else []
            out.append(p)
        return out

    @staticmethod
    def _with_context(req) -> str:
        """SD isn't instruction-tuned: describe the whole wanted picture (old prompt + the change)."""
        return ", ".join(x for x in (req.context_prompt, req.styled_prompt()) if x)

    def _op_edit(self, req, inp, prog, cancel):
        out = self._i2i_many(req, inp.source, self._with_context(req), req.strength, prog, cancel, "Editing")
        out[0].notes.append("The local model edits by repainting the whole picture. For a precise change, "
                            "paint over the area with Edit → Mask.")
        return out

    def _op_style(self, req, inp, prog, cancel):
        prompt = ", ".join(x for x in (req.context_prompt, STYLES[req.style][0]) if x) or req.styled_prompt() or "the same scene"
        return self._i2i_many(req, inp.source, prompt, max(req.strength, 0.55), prog, cancel, "Restyling")

    def _op_variations(self, req, inp, prog, cancel):
        return self._i2i_many(req, inp.source, self._with_context(req), min(req.strength, 0.5), prog, cancel, "Variation")

    def _masked(self, req, inp, prompt, prog, cancel, label) -> list[Produced]:
        import cv2
        src, mask = inp.source, inp.mask
        rgb = np.array(src)
        m = np.array(mask)
        filled = cv2.inpaint(rgb, (m > 127).astype(np.uint8) * 255, 7, cv2.INPAINT_TELEA)   # neutral fill first
        pre = Image.fromarray(filled)
        w, h = self._work_size(src, min(req.resolution, 768))
        feather = mask.filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.GaussianBlur(6))
        out = []
        for i in range(req.n):
            seed = None if req.seed is None else req.seed + i
            p = self._i2i_one(pre.resize((w, h), Image.LANCZOS), prompt, req.styled_negative(), max(req.strength, 0.6),
                              seed, prog, cancel, i / req.n, 1 / req.n, label)
            painted = p.image.resize(src.size, Image.LANCZOS)
            p.image = Image.composite(painted, src, feather)          # outside the mask stays pixel-identical
            p.notes = self._notes(req) if i == 0 else []
            out.append(p)
        return out

    def _op_inpaint(self, req, inp, prog, cancel):
        if inp.mask is None:
            raise ImageError("Paint the area to change first (Edit → Mask), then send the instruction.", "mask_required", status=400)
        return self._masked(req, inp, req.styled_prompt(), prog, cancel, "Inpainting")

    def _op_remove_object(self, req, inp, prog, cancel):
        if inp.mask is None:
            raise ImageError("The local model needs to know where the object is: tap Edit → Mask, paint over it, "
                             "then say “remove it”.", "mask_required", status=400)
        prompt = "empty background, seamless continuation of the surroundings, nothing there"
        return self._masked(req, inp, prompt, prog, cancel, "Removing")

    def _cutout(self, src: Image.Image) -> Image.Image:
        from rembg import remove
        return remove(src, session=self._load_rembg())

    def _op_remove_background(self, req, inp, prog, cancel):
        prog(0.1, "Finding the subject…")
        cut = self._cutout(inp.source)
        prog(1.0, "Done")
        return [Produced(cut, None, ["Background removed — the result has a transparent background (PNG/WebP)."])]

    def _op_replace_background(self, req, inp, prog, cancel):
        prog(0.05, "Finding the subject…")
        cut = self._cutout(inp.source)
        want = (req.background or req.prompt).strip()
        key = want.lower().replace("plain ", "").replace("solid ", "").replace(" background", "").strip()
        if key in COLOR_WORDS:
            color = COLOR_WORDS[key]
            if color is None:
                return [Produced(cut, None, ["Background removed (transparent)."])]
            bg = Image.new("RGB", cut.size, color)
            out = [Produced(bg, None, [])]
        else:
            w, h = self._work_size(cut, min(req.resolution, 768))
            out = []
            for i in range(req.n):
                seed = None if req.seed is None else req.seed + i
                prompt = ", ".join(x for x in (want, "background scenery, no people", STYLES[req.style][0]) if x)
                p = self._t2i_one(prompt, req.styled_negative(), w, h, seed, prog, cancel,
                                  0.1 + 0.9 * i / req.n, 0.9 / req.n, "Painting the new background")
                p.image = p.image.resize(cut.size, Image.LANCZOS)
                out.append(p)
        for p in out:
            bg = p.image.convert("RGBA")
            bg.alpha_composite(cut)
            p.image = bg.convert("RGB")
        out[0].notes.append("The subject is kept exactly; only the background was replaced (lighting isn't re-matched).")
        return out


def _download():
    p = LocalProvider()
    print("model:", p.model, "device:", p.device() if not p.missing or "torch" not in p.missing else "-")
    if p.missing:
        print("missing packages:", ", ".join(p.missing))
    if {"generate"} <= p.ops:
        p._load_sd()
        print("diffusion model ready")
    if "remove_background" in p.ops:
        p._load_rembg()
        print("background-removal model ready")
    if p.nsfw_check and "transformers" not in p.missing:
        p._check_output(Image.new("RGB", (64, 64), (128, 128, 128)))
        print("safety checker ready")


if __name__ == "__main__":
    import sys
    if "--download" in sys.argv:
        _download()
    else:
        print(__doc__)
