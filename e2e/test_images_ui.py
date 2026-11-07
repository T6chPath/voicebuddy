"""Image features in the real browser UI.

ZC_E2E_IMAGES=fake (default): quick drawing provider, checks every control.
ZC_E2E_IMAGES=real          : the server's real model (CI sets ZC_IMAGE_PROVIDERS=local) — runs the two success criteria
                              and saves screenshots of the real results."""
import io
import os
from pathlib import Path

import pytest
from conftest import start_server
from PIL import Image
from playwright.sync_api import expect

REAL = os.environ.get("ZC_E2E_IMAGES") == "real"
SHOTS = Path(os.environ.get("ZC_REAL_OUT") or Path(__file__).parent / "screenshots")
T = 600_000 if REAL else 20_000
fake_only = pytest.mark.skipif(REAL, reason="UI-control test; uses the quick drawing provider")


@pytest.fixture(scope="module")
def image_server(tmp_path_factory):
    env = {"ZC_E2E_IMAGES": "real" if REAL else "fake", "ZC_IMAGE_PROVIDERS": os.environ.get("ZC_IMAGE_PROVIDERS", "local") if REAL else "none"}
    base, proc = start_server(tmp_path_factory, "e2e_image_app:create", env)
    yield base
    proc.terminate()
    proc.wait(10)


@pytest.fixture
def pg(browser, image_server, request):
    mobile = "mobile" in request.node.name
    ctx = browser.new_context(base_url=image_server, viewport={"width": 390, "height": 844} if mobile else {"width": 1280, "height": 900},
                              is_mobile=mobile, has_touch=mobile, device_scale_factor=2 if mobile else 1)
    p = ctx.new_page()
    p.errors = []
    p.on("pageerror", lambda e: p.errors.append(str(e)))
    p.goto("/")
    p.get_by_role("button", name="Create an account").click()
    p.get_by_label("Name").fill("Asha")
    p.get_by_label("Email").fill(f"asha{abs(hash(request.node.name))}@example.com")
    p.get_by_label("Password").fill("correct horse battery")
    p.get_by_role("button", name="Create account").click()
    expect(p.get_by_role("heading", name="How can I help?")).to_be_visible()
    yield p
    ctx.close()


def send(p, text):
    box = p.get_by_label("Message", exact=True)
    box.fill(text)
    box.press("Enter")


def wait_images(p, count):
    imgs = p.locator("article.msg-assistant .img-card img")
    expect(imgs).to_have_count(count, timeout=T)
    expect(p.locator("article.msg-assistant").last).to_have_attribute("aria-busy", "false", timeout=T)
    for i in range(count):
        p.wait_for_function("img => img.complete && img.naturalWidth > 0", arg=imgs.nth(i).element_handle(), timeout=T)
    return imgs


def test_generate_from_text_shows_image(pg):
    send(pg, "Generate an image of a futuristic city at sunset")
    expect(pg.locator(".tool-card")).to_be_visible(timeout=10_000)                 # progress card while it works
    imgs = wait_images(pg, 1)
    reply = pg.locator("article.msg-assistant").last
    expect(reply).to_contain_text("futuristic city at sunset")
    expect(reply.locator(".img-num")).to_have_text("#1")
    dl = reply.get_by_role("link", name="Download")
    assert dl.get_attribute("href").endswith("?download=1")
    with pg.expect_download() as d:
        dl.click()
    data = Path(d.value.path()).read_bytes()
    assert Image.open(io.BytesIO(data)).size[0] >= 256
    pg.screenshot(path=str(SHOTS / ("ui-generate-real.png" if REAL else "ui-generate.png")), full_page=False)
    reply.get_by_role("button", name="Open image #1 full size").click()
    expect(pg.get_by_role("dialog", name="Image viewer")).to_be_visible()
    pg.keyboard.press("Escape")
    expect(pg.get_by_role("dialog", name="Image viewer")).to_have_count(0)
    send(pg, "make it night time")                                                  # multi-turn edit
    wait_images(pg, 2)
    expect(pg.locator("article.msg-assistant").last).to_contain_text("edited image")
    assert pg.errors == []


def test_upload_and_remove_background(pg, tmp_path):
    f = tmp_path / "photo.png"
    im = Image.new("RGB", (320, 240), (240, 240, 240))
    from PIL import ImageDraw
    ImageDraw.Draw(im).ellipse((100, 60, 220, 180), fill=(220, 30, 30))
    im.save(f)
    pg.locator("input[type=file]").set_input_files(str(f))
    expect(pg.locator(".att-list.pending .chip")).to_contain_text("photo.png")
    send(pg, "Remove the background")
    expect(pg.locator("article.msg-user .img-card img")).to_have_count(1, timeout=10_000)   # upload shown as a picture
    wait_images(pg, 1)
    src = pg.locator("article.msg-assistant .img-card img").first.get_attribute("src")
    r = pg.request.get(src)
    out = Image.open(io.BytesIO(r.body()))
    assert out.mode == "RGBA" and out.getextrema()[3][0] == 0                         # really transparent
    pg.screenshot(path=str(SHOTS / ("ui-remove-bg-real.png" if REAL else "ui-remove-bg.png")))
    assert pg.errors == []


@fake_only
def test_image_settings_and_buttons(pg):
    pg.get_by_role("button", name="Image settings").click()
    panel = pg.get_by_role("dialog", name="Image settings")
    panel.get_by_label("Style").select_option("anime")
    panel.get_by_label("Aspect ratio").select_option("16:9")
    panel.get_by_label("Images").select_option("2")
    panel.get_by_label("Make an image from my next message").check()
    expect(pg.get_by_text("Your next message will create an image")).to_be_visible()
    panel.get_by_role("button", name="Close image settings").click()
    send(pg, "a cat on a scooter")                                                   # no "generate" word: the toggle forces it
    imgs = wait_images(pg, 2)
    box = imgs.first.bounding_box()
    assert 1.6 < box["width"] / box["height"] < 1.9                                  # 16:9 tiles
    expect(pg.locator("article.msg-assistant").last).to_contain_text("2 images")
    expect(pg.get_by_text("Your next message will create an image")).to_have_count(0)
    card = pg.locator("article.msg-assistant").last.locator(".img-card").first
    card.get_by_role("button", name="Make variations").click()
    wait_images(pg, 2 + 2)
    expect(pg.locator("article.msg-user").last).to_contain_text("Make variations of image #1")
    card = pg.locator("article.msg-assistant .img-card").first
    card.get_by_role("button", name="Edit with a message").click()
    expect(pg.get_by_text("Editing image #1")).to_be_visible()
    send(pg, "add a red helmet")
    wait_images(pg, 6)                                                               # the "Images: 2" setting still applies
    expect(pg.locator("article.msg-assistant").last.locator(".img-card img").first).to_have_attribute("alt", "Generated image: add a red helmet")
    assert pg.errors == []


@fake_only
def test_mask_painting_inpaint(pg):
    send(pg, "generate an image of a living room")
    wait_images(pg, 1)
    pg.locator("article.msg-assistant .img-card").first.get_by_role("button", name="Paint an area to change").click()
    dlg = pg.get_by_role("dialog", name="Paint the area to change")
    expect(dlg).to_be_visible()
    apply = dlg.get_by_role("button", name="Remove painted area")
    expect(apply).to_be_disabled()
    canvas = dlg.locator("canvas")
    pg.wait_for_function("c => c.width > 0", arg=canvas.element_handle())
    b = canvas.bounding_box()
    pg.mouse.move(b["x"] + b["width"] * 0.3, b["y"] + b["height"] * 0.5)
    pg.mouse.down()
    pg.mouse.move(b["x"] + b["width"] * 0.7, b["y"] + b["height"] * 0.5, steps=8)
    pg.mouse.up()
    dlg.get_by_label("What should go there?").fill("a green sofa")
    pg.screenshot(path=str(SHOTS / "ui-mask-editor.png"))
    dlg.get_by_role("button", name="Replace painted area").click()
    wait_images(pg, 2)
    expect(pg.locator("article.msg-user").last).to_contain_text("replace the painted area with a green sofa")
    src = pg.locator("article.msg-assistant .img-card img").last.get_attribute("src")
    out = Image.open(io.BytesIO(pg.request.get(src).body())).convert("RGB")
    w, h = out.size
    assert out.getpixel((w // 2, h // 2)) == (30, 160, 80)                            # painted middle replaced
    assert out.getpixel((w // 2, 5)) != (30, 160, 80)                                 # top untouched
    assert pg.errors == []


@fake_only
def test_mobile_image_layout(pg):
    send(pg, "generate an image of mountains")
    wait_images(pg, 1)
    assert pg.evaluate("document.documentElement.scrollWidth - window.innerWidth") <= 0
    pg.get_by_role("button", name="Image settings").click()
    assert pg.evaluate("document.documentElement.scrollWidth - window.innerWidth") <= 0
    pg.screenshot(path=str(SHOTS / "ui-mobile-images.png"))
