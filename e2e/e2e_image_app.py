"""App factory for the browser tests. ZC_E2E_IMAGES=fake swaps in a quick drawing provider (UI tests on machines without
the model); ZC_E2E_IMAGES=real keeps the server's real configuration (ZC_IMAGE_PROVIDERS, e.g. the local SD-Turbo)."""
import asyncio
import os

from PIL import Image, ImageDraw

from app.images.base import Produced
from app.main import create_app


class DrawingProvider:
    name, model = "local", "e2e-drawing"
    ops = {"generate", "edit", "variations", "style", "inpaint", "remove_object", "remove_background", "replace_background"}
    negative_prompt = seed = True
    unavailable_reason = None

    async def run(self, req, inp, progress):
        out = []
        for i in range(req.n):
            for k in range(4):
                progress((i + k / 4) / req.n, f"Generating image {i + 1} of {req.n}")
                await asyncio.sleep(0.15)
            if req.op == "remove_background":
                im = inp.source.convert("RGBA")
                px = im.load()
                for x in range(im.width):
                    for y in range(im.height):
                        if (x - im.width / 2) ** 2 + (y - im.height / 2) ** 2 > (min(im.size) / 3) ** 2:
                            px[x, y] = (0, 0, 0, 0)
            else:
                a, b = (int(v) for v in req.aspect_ratio.split(":"))
                w, h = (inp.source.size if inp.source is not None else ((512, int(512 * b / a)) if a >= b else (int(512 * a / b), 512)))
                im = Image.new("RGB", (w, h))
                d = ImageDraw.Draw(im)
                for y in range(h):
                    d.line([(0, y), (w, y)], fill=(255 - y * 200 // h, 90 + 40 * i, 60 + y * 150 // h))
                if inp.mask is not None:
                    im = Image.composite(Image.new("RGB", im.size, (30, 160, 80)), inp.source, inp.mask)
                d = ImageDraw.Draw(im)
                d.text((12, 12), f"{req.op} · {req.style}", fill="white")
                d.text((12, 30), req.prompt[:60], fill="white")
            out.append(Produced(im, (req.seed or 1000) + i, []))
        return out


def create():
    app = create_app()
    if os.environ.get("ZC_E2E_IMAGES", "fake") == "fake":
        app.state.images.providers = [DrawingProvider()]
    return app
