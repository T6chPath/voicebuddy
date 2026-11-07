"""Image service: picks a provider per operation, enforces limits, stores results, logs, falls back.

Config (environment):
  ZC_IMAGE_PROVIDERS   auto | none | comma list in priority order, e.g. "local,gemini"   (default auto:
                       local if its packages are installed, then gemini if GEMINI_API_KEY, then openai if OPENAI_API_KEY)
  ZC_IMAGE_RATE        "<requests>/<seconds>" per user, default 30/3600
  ZC_IMAGE_MAX_QUEUE   requests allowed to wait or run at once, server-wide (default 3)
  ZC_IMAGE_MAX_N       images per request (default 4)      ZC_IMAGE_MAX_RES  longest side (default 1024)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from pathlib import Path

from ..db import Database, new_id, now
from ..files import store
from ..security import RateLimiter
from . import codec
from .base import ImageError, ImageProvider, Inputs, Progress
from .safety import SafetyBlocked, check_prompt
from .spec import ASPECTS, FORMATS, NEEDS_PROMPT, NEEDS_SOURCE, OPS, STYLES, ImageRequest

log = logging.getLogger("zenvqo.images")
FALLBACK_CODES = {"quota", "auth", "unreachable", "config", "timeout", "rate_limited", "provider_error", "no_image",
                  "busy", "oom", "local_failed", "unsupported", "safety_unavailable"}
LABEL = {"local": "local model", "gemini": "Gemini", "openai": "OpenAI"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL, conversation_id TEXT, op TEXT NOT NULL, prompt TEXT NOT NULL,
  params TEXT NOT NULL, parent_id TEXT, provider TEXT NOT NULL, model TEXT NOT NULL, seed INTEGER,
  width INTEGER NOT NULL, height INTEGER NOT NULL, created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS images_user ON images(user_id, created_at);
"""


def build_providers(spec: str | None = None) -> list[ImageProvider]:
    spec = (spec if spec is not None else os.environ.get("ZC_IMAGE_PROVIDERS", "auto")).strip().lower()
    if spec in ("none", "off", ""):
        return []
    from .hosted import GeminiProvider, OpenAIImageProvider
    from .local import LocalProvider
    make = {"local": LocalProvider, "gemini": GeminiProvider, "openai": OpenAIImageProvider}
    if spec == "auto":
        out = [p for p in (LocalProvider(), GeminiProvider(), OpenAIImageProvider()) if p.unavailable_reason is None]
        return out or [LocalProvider()]           # keeps the "why not" reason visible
    out = []
    for name in [x.strip() for x in spec.split(",") if x.strip()]:
        if name not in make:
            raise ValueError(f"Unknown image provider '{name}' in ZC_IMAGE_PROVIDERS")
        out.append(make[name]())
    return out


class ImageService:
    def __init__(self, db: Database, data_dir: Path, providers: list[ImageProvider] | None = None):
        self.db, self.data_dir = db, Path(data_dir)
        self.providers = build_providers() if providers is None else providers
        db.conn().executescript(SCHEMA)
        n, _, w = os.environ.get("ZC_IMAGE_RATE", "30/3600").partition("/")
        self.limiter = RateLimiter(limit=int(n), window_s=float(w or 3600))
        self.queue = asyncio.Semaphore(int(os.environ.get("ZC_IMAGE_MAX_QUEUE", "3")))
        self.queue_size = int(os.environ.get("ZC_IMAGE_MAX_QUEUE", "3"))
        self.waiting = 0
        self.active_users: set[str] = set()
        self.max_n = int(os.environ.get("ZC_IMAGE_MAX_N", "4"))
        self.max_res = int(os.environ.get("ZC_IMAGE_MAX_RES", "1024"))

    # ---------------- what's available ----------------
    def ready(self) -> list[ImageProvider]:
        return [p for p in self.providers if p.unavailable_reason is None]

    @property
    def available(self) -> bool:
        return bool(self.ready())

    def unavailable_reason(self) -> str:
        if not self.providers:
            return "Image generation is turned off on this server (ZC_IMAGE_PROVIDERS=none)."
        return " ".join(f"{LABEL.get(p.name, p.name)}: {p.unavailable_reason}" for p in self.providers if p.unavailable_reason)

    def candidates(self, op: str) -> list[ImageProvider]:
        return [p for p in self.ready() if op in p.ops]

    def capabilities(self) -> dict:
        ready = self.ready()
        return {
            "available": bool(ready),
            "reason": None if ready else self.unavailable_reason(),
            "providers": [{"name": p.name, "model": p.model, "ready": p.unavailable_reason is None,
                           "reason": p.unavailable_reason, "ops": sorted(p.ops), "negative_prompt": p.negative_prompt,
                           "seed": p.seed} for p in self.providers],
            "ops": sorted({op for p in ready for op in p.ops}, key=OPS.index),
            "styles": list(STYLES), "aspect_ratios": list(ASPECTS), "formats": list(FORMATS),
            "max_n": self.max_n, "max_resolution": self.max_res,
        }

    # ---------------- running ----------------
    async def run(self, uid: str, cid: str | None, req: ImageRequest, progress: Progress,
                  user_text: str = "") -> tuple[list[dict], list[str]]:
        """→ (stored image attachments, notes). Raises ImageError / SafetyBlocked with user-facing messages."""
        req = req.clamp(self.max_n, self.max_res)
        if req.mask_id and req.op in ("edit", "style"):
            req.op = "inpaint"
        if req.op not in OPS:
            raise ImageError("Unknown image operation.", "bad_request", status=400)
        if req.op in NEEDS_PROMPT and not (req.prompt or req.background):
            raise ImageError("Describe what you want in the image.", "bad_request", status=400)
        src_row = mask_row = None
        if req.op in NEEDS_SOURCE:
            if not req.source_id:
                raise ImageError("Attach an image (or generate one) first, then ask for the change.", "no_source", status=400)
            src_row = self._file(uid, req.source_id)
        if req.mask_id:
            mask_row = self._file(uid, req.mask_id)
        check_prompt(" ".join((user_text, req.prompt, req.background)), editing_photo=src_row is not None)

        cands = self.candidates(req.op)
        if not cands:
            if not self.available:
                raise ImageError("Image tools aren't available: " + self.unavailable_reason(), "unavailable", status=503)
            names = ", ".join(LABEL.get(p.name, p.name) for p in self.ready())
            hint = " Install the local image packages (requirements-images.txt) for background removal." \
                if req.op in ("remove_background", "replace_background") else ""
            raise ImageError(f"None of the configured image providers ({names}) can {req.op.replace('_', ' ')}.{hint}",
                             "unsupported", status=400)

        wait = self.limiter.check("img:" + uid)
        if wait:
            raise ImageError(f"Image limit reached — try again in {int(wait // 60) + 1} min.", "rate_limited", True, 429)
        if uid in self.active_users:
            raise ImageError("Your previous image is still being made. Wait for it to finish.", "busy", True, 429)
        if self.waiting >= self.queue_size:
            raise ImageError("The image server is busy. Try again shortly.", "busy", True, 429)

        inp = Inputs()
        try:
            if src_row:
                inp.source = codec.load(Path(src_row["path"]).read_bytes(), "RGB")
            if mask_row and inp.source is not None:
                inp.mask = codec.load_mask(Path(mask_row["path"]).read_bytes(), inp.source.size)
        except codec.BadImage as e:
            raise ImageError(str(e), "bad_image", status=400) from e

        self.waiting += 1
        self.active_users.add(uid)
        t0 = time.monotonic()
        notes: list[str] = []
        try:
            if self.queue.locked():
                progress(0.0, "Waiting for the image model…")
            async with self.queue:
                produced, used = None, None
                for i, p in enumerate(cands):
                    try:
                        produced, used = await p.run(req, inp, progress), p
                        break
                    except ImageError as e:
                        nxt = cands[i + 1] if i + 1 < len(cands) else None
                        log.warning("image provider %s failed: %s (%s)", p.name, e.code, e)
                        if nxt is None or e.code not in FALLBACK_CODES:
                            raise
                        notes.append(f"{LABEL.get(p.name, p.name)} failed ({e}) — used the {LABEL.get(nxt.name, nxt.name)} instead.")
                        progress(0.0, f"Retrying with the {LABEL.get(nxt.name, nxt.name)}…")
            stored = []
            for k, pr in enumerate(produced or []):
                notes.extend(n for n in pr.notes if n not in notes)
                stored.append(self._save(uid, cid, req, pr, used, k, src_row))
            for att in stored:
                notes.extend(n for n in att.pop("_notes", []) if n not in notes)
            self._log(uid, req, used.name if used else "-", "ok", t0, len(stored))
            return stored, notes
        except SafetyBlocked:
            self._log(uid, req, "-", "blocked", t0, 0)
            raise
        except ImageError as e:
            self._log(uid, req, "-", e.code, t0, 0)
            raise
        finally:
            self.waiting -= 1
            self.active_users.discard(uid)

    def _file(self, uid: str, fid: str) -> dict:
        f = self.db.one("SELECT * FROM files WHERE id = ? AND user_id = ?", (fid, uid))
        if not f or f["kind"] != "image":
            raise ImageError("That image wasn't found. Attach it again.", "no_source", status=400)
        return f

    def _save(self, uid, cid, req: ImageRequest, pr, provider, k: int, src_row) -> dict:
        data, mime, enc_notes = codec.encode(pr.image, req.output_format, provider=provider.name, model=provider.model)
        fid = new_id("fil")
        ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}[mime]
        slug = re.sub(r"[^a-z0-9]+", "-", (req.prompt or req.background or req.op).lower()).strip("-")[:40] or req.op
        name = f"zenvqo-{slug}-{pr.seed if pr.seed is not None else k + 1}.{ext}"
        path = store(self.data_dir, uid, fid, data)
        t = now()
        self.db.run("INSERT INTO files VALUES (?,?,?,?,?,?,?,?,?)", (fid, uid, name, mime, len(data), "image", path, None, t))
        params = {"style": req.style, "aspect_ratio": req.aspect_ratio, "negative_prompt": req.negative_prompt,
                  "strength": req.strength, "n": req.n, "output_format": req.output_format, "background": req.background,
                  "mask": bool(req.mask_id)}
        parent = src_row["id"] if src_row else None
        self.db.run("INSERT INTO images VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (fid, uid, cid, req.op, req.prompt, json.dumps(params), parent, provider.name, provider.model,
                     pr.seed, pr.image.width, pr.image.height, t))
        return {"id": fid, "name": name, "mime": mime, "size": len(data), "kind": "image", "generated": True,
                "width": pr.image.width, "height": pr.image.height,
                "meta": {"op": req.op, "prompt": req.prompt, "seed": pr.seed,
                         "scene": ", ".join(x for x in (req.context_prompt, req.prompt) if x) if req.op != "generate" else req.prompt, "provider": provider.name,
                         "model": provider.model, "parent_id": parent, **params}, "_notes": enc_notes}

    def _log(self, uid, req, provider, status, t0, n):
        log.info(json.dumps({"event": "image", "user": uid, "op": req.op, "provider": provider, "status": status,
                             "n": n, "ms": int((time.monotonic() - t0) * 1000), "res": req.resolution,
                             "aspect": req.aspect_ratio, "prompt_chars": len(req.prompt)}))


def conversation_images(db: Database, uid: str, cid: str) -> list[dict]:
    """Every image in the conversation, oldest first, numbered #1, #2… — used to resolve "it" / "image 2"."""
    out = []
    for r in db.all("SELECT id, role, attachments FROM messages WHERE conversation_id = ? AND user_id = ? ORDER BY created_at",
                    (cid, uid)):
        for a in json.loads(r["attachments"]):
            if a.get("kind") == "image":
                out.append({"id": a["id"], "n": len(out) + 1, "generated": bool(a.get("generated")),
                            "prompt": (a.get("meta") or {}).get("prompt", ""), "name": a.get("name", ""),
                            "scene": (a.get("meta") or {}).get("scene") or (a.get("meta") or {}).get("prompt", ""),
                            "message_id": r["id"]})
    return out
