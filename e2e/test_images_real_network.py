"""The real free image service (Pollinations), from the app page itself — run where there is internet:
    ZC_REAL_NETWORK=1 python -m pytest e2e/test_images_real_network.py
"""
import base64
import io
import json
import os
from pathlib import Path

import pytest
from PIL import Image, ImageStat
from playwright.sync_api import expect

from test_camera_pdf_read import wait_reply

HTML = Path(__file__).resolve().parents[1] / "frontend" / "dist-standalone" / "zenvqo-chat.html"
SHOTS = Path(__file__).parent / "screenshots"
pytestmark = pytest.mark.skipif(os.environ.get("ZC_REAL_NETWORK") != "1", reason="needs internet (ZC_REAL_NETWORK=1)")


def test_real_free_image_from_the_app(browser):
    ctx = browser.new_context(viewport={"width": 390, "height": 844})
    ctx.add_init_script(f"localStorage.setItem('zc.local.settings', {json.dumps(json.dumps({'default_model': 'echo'}))});")
    p = ctx.new_page()
    errors = []
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.goto(HTML.as_uri())
    p.locator("#composer-input").fill("Generate an image of a single red apple on a plain white plate, studio photo")
    p.locator("#composer-input").press("Enter")
    wait_reply(p, 1)
    reply = p.locator("article.msg-assistant").last
    expect(reply.locator("img").first).to_be_visible(timeout=150_000)
    src = reply.locator("img").first.get_attribute("src")
    im = Image.open(io.BytesIO(base64.b64decode(src.split(",", 1)[1]))).convert("RGB")
    print("real image:", im.size, "mean colour", [round(x) for x in ImageStat.Stat(im).mean])
    assert min(im.size) >= 512, im.size
    stat = ImageStat.Stat(im)
    assert max(stat.stddev) > 20, "a real picture, not a flat colour"
    r, g, b = stat.mean
    reds = sum(1 for x in range(0, im.width, 8) for y in range(0, im.height, 8) if (lambda c: c[0] > 140 and c[1] < 90 and c[2] < 90)(im.getpixel((x, y))))
    print("red pixels sampled:", reds)
    assert reds > 30, "a red apple should show up as red"
    SHOTS.mkdir(exist_ok=True)
    im.save(SHOTS / "real-free-image.jpg")
    reply.screenshot(path=str(SHOTS / "real-free-image-chat.png"))
    assert not errors, errors
