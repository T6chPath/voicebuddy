"""Crop, resize and rotate a photo before asking about it: straight after taking it with the camera, and later by tapping it
in the message box. The fake camera shows a red circle top-left and "ZENVQO 42" in the middle (1280×720)."""
from pathlib import Path

from playwright.sync_api import expect

from test_camera_pdf_read import SHOTS, FakeAI, camera_browser, decode, open_app, user_parts, wait_reply  # noqa: F401

FILES = Path(__file__).parent / "files"


def drag(p, handle, dx, dy):
    b = handle.bounding_box()
    x, y = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
    p.mouse.move(x, y)
    p.mouse.down()
    p.mouse.move(x + dx / 2, y + dy / 2, steps=4)
    p.mouse.move(x + dx, y + dy, steps=4)
    p.mouse.up()


def take_photo(p):
    p.get_by_role("button", name="Add photos, files and more").click()
    p.get_by_role("menuitem", name="Take a photo").click()
    dialog = p.get_by_role("dialog", name="Take a photo")
    shutter = dialog.get_by_role("button", name="Take photo")
    expect(shutter).to_be_enabled(timeout=10_000)
    shutter.click()
    expect(dialog.get_by_role("img", name="The photo you took")).to_be_visible()
    return dialog


def test_crop_the_photo_to_just_the_question(camera_browser):
    ai = FakeAI("The circle is red.")
    p, errors = open_app(camera_browser, ai)
    dialog = take_photo(p)
    size = dialog.locator(".crop-size")
    expect(size).to_have_text("1280 × 720")
    stage = dialog.locator(".crop-stage").bounding_box()
    # drag the bottom-right corner to the middle: only the top-left quarter (the red circle) stays
    drag(p, dialog.locator('[data-handle="se"]'), -stage["width"] / 2, -stage["height"] / 2)
    expect(size).to_have_text("640 × 360")
    SHOTS.mkdir(exist_ok=True)
    p.screenshot(path=str(SHOTS / "camera-crop.png"))
    # drag the frame itself: it moves but keeps its size, and can't leave the photo
    drag(p, dialog.locator(".crop-frame"), -500, -500)
    expect(size).to_have_text("640 × 360")
    dialog.get_by_role("button", name="Use photo").click()
    expect(dialog).to_be_hidden()
    p.locator("#composer-input").fill("What colour is the circle?")
    expect(p.get_by_role("button", name="Send message")).to_be_enabled(timeout=5_000)
    p.locator("#composer-input").press("Enter")
    wait_reply(p, 1)
    text, images = user_parts(ai.requests[-1])
    assert text.startswith("What colour is the circle?") and len(images) == 1
    img = decode(images[0])
    assert abs(img.size[0] - 640) <= 2 and abs(img.size[1] - 360) <= 2, img.size
    r, g, b = img.getpixel((160, 160))
    assert r > 180 and g < 90 and b < 90, (r, g, b)                      # the circle is in the cropped photo
    r, g, b = img.getpixel((600, 340))
    assert r > 200 and g > 200 and b > 200, (r, g, b)                     # the text ("ZENVQO 42") was cropped away
    assert not errors, errors


def test_square_shape_rotate_and_start_over(camera_browser):
    ai = FakeAI("ok")
    p, errors = open_app(camera_browser, ai)
    dialog = take_photo(p)
    size = dialog.locator(".crop-size")
    dialog.get_by_role("radio", name="Square").click()
    expect(size).to_have_text("720 × 720")
    expect(dialog.locator('[data-handle="n"]')).to_have_count(0)          # a fixed shape is resized from its corners
    drag(p, dialog.locator('[data-handle="se"]'), -80, -10)
    w, h = [int(v) for v in size.inner_text().split(" × ")]
    assert w == h and w < 720, (w, h)
    dialog.get_by_role("button", name="Rotate").click()
    expect(size).to_have_text("720 × 1280")
    expect(dialog.get_by_role("radio", name="Free")).to_have_attribute("aria-checked", "true")
    dialog.get_by_role("button", name="Start over").click()
    expect(size).to_have_text("1280 × 720")
    dialog.get_by_role("button", name="Retake").click()                    # back to the live camera
    expect(dialog.get_by_role("button", name="Take photo")).to_be_enabled(timeout=10_000)
    assert not errors, errors


def test_tap_a_photo_in_the_message_box_to_crop_it(camera_browser):
    ai = FakeAI("ok")
    p, errors = open_app(camera_browser, ai)
    p.locator("form.composer input[type=file]").set_input_files(str(FILES / "red.jpg"))
    card = p.get_by_role("button", name="Crop or rotate red.jpg")
    expect(card).to_be_visible(timeout=5_000)
    card.click()
    crop = p.get_by_role("dialog", name="Crop photo")
    expect(crop).to_be_visible()
    crop.get_by_role("radio", name="Square").click()
    crop.get_by_role("button", name="Done").click()
    expect(crop).to_be_hidden()
    expect(p.get_by_role("button", name="Crop or rotate red-crop.jpg")).to_be_visible()
    expect(p.locator(".att-list.pending .file-card")).to_have_count(1)
    expect(p.get_by_role("button", name="Send message")).to_be_enabled(timeout=5_000)
    p.locator("#composer-input").press("Enter")
    wait_reply(p, 1)
    _, images = user_parts(ai.requests[-1])
    img = decode(images[0])
    assert len(images) == 1 and img.size[0] == img.size[1], img.size
    # Cancel leaves the photo as it was
    p.locator("form.composer input[type=file]").set_input_files(str(FILES / "red.jpg"))
    p.get_by_role("button", name="Crop or rotate red.jpg").click()
    p.get_by_role("dialog", name="Crop photo").get_by_role("button", name="Cancel").click()
    expect(p.get_by_role("button", name="Crop or rotate red.jpg")).to_be_visible()
    assert not errors, errors
