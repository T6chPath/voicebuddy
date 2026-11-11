"""The full set of picture features in the phone app, on the free route (no image key): exact text, background
removal/replacement on your own photo, object removal with the brush, expand, enlarge, image-to-image and
references through the chat model's eyes, and keeping the same character. Image services are stand-ins."""
import base64
import io
import json

from PIL import Image, ImageDraw
from playwright.sync_api import expect

from test_camera_pdf_read import wait_reply
from test_images_standalone import Gemini, Pollinations, app, say

CORS = {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS"}


class VisionAI:
    """An OpenAI-compatible chat model that can see: answers 'describe this picture' requests (stream: false)."""

    def __init__(self, describe="a small orange fox wearing a blue scarf, sitting in a meadow"):
        self.requests, self.describe = [], describe

    def handle(self, route):
        req = route.request
        if req.method == "OPTIONS":
            return route.fulfill(status=204, headers=CORS)
        if req.url.endswith("/models"):
            return route.fulfill(status=200, headers=CORS, content_type="application/json", body=json.dumps({"data": [{"id": "vision-1"}]}))
        body = json.loads(req.post_data)
        self.requests.append(body)
        if body.get("stream") is False:
            return route.fulfill(status=200, headers=CORS, content_type="application/json",
                                 body=json.dumps({"choices": [{"message": {"content": self.describe}}]}))
        route.fulfill(status=200, headers=CORS, content_type="text/event-stream",
                      body='data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n')


def img_of(reply, i=0):
    src = reply.locator("img").nth(i).get_attribute("src")
    assert src and src.startswith("data:image/"), src
    return Image.open(io.BytesIO(base64.b64decode(src.split(",", 1)[1])))


def photo_file(tmp_path, bg=(10, 10, 200), fg=(220, 30, 30), name="me.png"):
    im = Image.new("RGB", (240, 240), bg)
    ImageDraw.Draw(im).rectangle((80, 80, 160, 160), fill=fg)
    path = tmp_path / name
    im.save(path)
    return path


def send_with_photo(p, path, text, n):
    p.locator("form.composer input[type=file]").set_input_files(str(path))
    p.locator("#composer-input").fill(text)
    expect(p.get_by_role("button", name="Send message")).to_be_enabled(timeout=5_000)
    p.locator("#composer-input").press("Enter")
    wait_reply(p, n)
    return p.locator("article.msg-assistant").last


def test_exact_text_on_posters_and_logos(browser):
    p, errors, polli = app(browser, {"default_model": "echo"})
    reply = say(p, 'Create a poster with the text "Grand Opening"', 1)
    expect(reply.locator("img").first).to_be_visible()
    assert "no text" in polli.calls[0]["prompt"], "the service draws no letters; the app sets the words itself"
    expect(reply).to_contain_text('The words "Grand Opening" were set on the picture by the app')
    im = img_of(reply).convert("RGB")
    colours = {im.getpixel((x, y)) for x in range(0, im.width, 4) for y in range(0, im.height, 4)}
    assert len(colours) > 20, "words were drawn on the plain stand-in picture"
    logo = say(p, "design a logo for a coffee shop called Bean There", 2)
    expect(logo.locator("img").first).to_be_visible()
    assert "logo" in polli.calls[1]["prompt"] and "Bean There" not in polli.calls[1]["prompt"]
    expect(logo).to_contain_text('"Bean There"')
    assert not errors, errors


def test_background_removal_and_replacement_on_your_photo(browser, tmp_path):
    p, errors, polli = app(browser, {"default_model": "echo"})
    reply = send_with_photo(p, photo_file(tmp_path), "remove the background", 1)
    expect(reply.locator("img").first).to_be_visible()
    cut = img_of(reply).convert("RGBA")
    assert cut.getpixel((5, 5))[3] == 0, "background is transparent"
    r, g, b, a = cut.getpixel((cut.width // 2, cut.height // 2))
    assert a == 255 and r > 180 and b < 80, "the subject stays"
    assert not polli.calls, "done on the phone, nothing sent anywhere"
    expect(reply).to_contain_text("without the background")
    # new background: the service draws only the scenery, the app puts the subject on it
    reply2 = send_with_photo(p, photo_file(tmp_path, name="me2.png"), "replace the background with a sunny beach", 2)
    expect(reply2.locator("img").first).to_be_visible()
    assert len(polli.calls) == 1 and "beach" in polli.calls[0]["prompt"]
    im = img_of(reply2).convert("RGB")
    assert im.getpixel((5, 5))[2] < 120 and im.getpixel((5, 5))[0] > 200, "beach colours behind"
    assert im.getpixel((im.width // 2, im.height // 2))[0] > 180, "subject kept"
    assert not errors, errors


def test_expand_and_enlarge_buttons(browser):
    p, errors, polli = app(browser, {"default_model": "echo"})
    reply = say(p, "Generate an image of a red apple on a wooden table", 1)
    expect(reply.locator("img").first).to_be_visible()
    w0, h0 = img_of(reply).size
    reply.get_by_role("button", name="Expand the image").click()
    wait_reply(p, 2)
    wide = p.locator("article.msg-assistant").last
    expect(wide.locator("img").first).to_be_visible()
    expect(wide).to_contain_text("expanded image")
    w1, h1 = img_of(wide).size
    assert w1 > w0 and h1 > h0
    assert len(polli.calls) == 2 and "wide view" in polli.calls[1]["prompt"]
    wide.get_by_role("button", name="Make larger").click()
    wait_reply(p, 3)
    big = p.locator("article.msg-assistant").last
    expect(big.locator("img").first).to_be_visible()
    assert max(img_of(big).size) == 2048
    assert len(polli.calls) == 2, "enlarging is done on the phone"
    expect(big).to_contain_text("larger version")
    assert not errors, errors


def test_same_character_in_a_new_scene(browser):
    p, errors, polli = app(browser, {"default_model": "echo"})
    first = say(p, "Generate an image of a fox wizard", 1)
    expect(first.locator("img").first).to_be_visible()
    second = say(p, "now show him at the beach", 2)
    expect(second.locator("img").first).to_be_visible()
    c1, c2 = polli.calls
    assert "at the beach" in c2["prompt"] and "fox wizard" in c2["prompt"]
    assert c2["seed"] == c1["seed"], "same settings, so the character stays the same"
    expect(second).to_contain_text("Kept the same character")
    assert not errors, errors


def test_photo_to_new_style_and_reference_through_the_models_eyes(browser, tmp_path):
    ai = VisionAI()
    p, errors, polli = app(browser, {"server_url": "http://fake-ai.test/v1", "api_key": "k", "default_model": "srv:vision-1"}, ai=ai)
    reply = send_with_photo(p, photo_file(tmp_path), "turn this into anime style", 1)
    expect(reply.locator("img").first).to_be_visible()
    look = [r for r in ai.requests if r.get("stream") is False]
    assert look and any(part.get("type") == "image_url" for part in look[0]["messages"][0]["content"])
    assert "orange fox wearing a blue scarf" in polli.calls[0]["prompt"] and "anime" in polli.calls[0]["prompt"]
    expect(reply).to_contain_text("redrawn from a description of your picture")
    # a reference picture: same character, new scene
    ai.describe = "a tall robot with round yellow eyes and a red antenna"
    reply2 = send_with_photo(p, photo_file(tmp_path, name="robot.png"), "use this as a reference and draw the same character as an astronaut", 2)
    expect(reply2.locator("img").first).to_be_visible()
    last = polli.calls[-1]["prompt"]
    assert "astronaut" in last and "round yellow eyes" in last
    assert not errors, errors


def test_object_removal_with_the_brush(browser):
    p, errors, polli = app(browser, {"default_model": "echo"})
    reply = say(p, "Generate an image of a red apple on a wooden table", 1)
    expect(reply.locator("img").first).to_be_visible()
    reply.get_by_role("button", name="Paint an area to change").click()
    canvas = p.locator("dialog canvas").first
    expect(canvas).to_be_visible()
    box = canvas.bounding_box()
    p.mouse.move(box["x"] + box["width"] * 0.3, box["y"] + box["height"] * 0.5)
    p.mouse.down()
    for k in range(10):
        p.mouse.move(box["x"] + box["width"] * (0.3 + k * 0.04), box["y"] + box["height"] * 0.5, steps=2)
    p.mouse.up()
    remove = p.get_by_role("button", name="Remove painted area")
    expect(remove).to_be_enabled()
    remove.click()
    wait_reply(p, 2)
    out = p.locator("article.msg-assistant").last
    expect(out.locator("img").first).to_be_visible()
    expect(out).to_contain_text("with that removed")
    assert len(polli.calls) == 1, "filled on the phone"
    assert not errors, errors


def test_gemini_gets_references_and_exact_words(browser, tmp_path):
    gem = Gemini()
    p, errors, polli = app(browser, {"server_url": "https://generativelanguage.googleapis.com/v1beta/openai", "api_key": "AIza-test", "default_model": "echo"}, gem=gem)
    reply = send_with_photo(p, photo_file(tmp_path), "use this as a reference and draw the same character as an astronaut", 1)
    expect(reply.locator("img").first).to_be_visible()
    parts = gem.calls[0]["contents"][0]["parts"]
    assert "Keep the character" in parts[0]["text"] and any("inlineData" in x for x in parts[1:])
    reply2 = say(p, 'Create a poster with the text "Grand Opening"', 2)
    expect(reply2.locator("img").first).to_be_visible()
    assert 'show the text "Grand Opening" exactly' in gem.calls[1]["contents"][0]["parts"][0]["text"]
    reply3 = say(p, "make it 16:9", 3)
    expect(reply3.locator("img").first).to_be_visible()
    cfg = gem.calls[2]["generationConfig"]["imageConfig"]["aspectRatio"]
    assert cfg == "16:9" and "Extend the scene" in gem.calls[2]["contents"][0]["parts"][0]["text"]
    assert not polli.calls
    assert not errors, errors


def test_openai_key_edits_your_photo_with_an_upload(browser, tmp_path):
    calls = []

    def handle(route):
        req = route.request
        if req.method == "OPTIONS":
            return route.fulfill(status=204, headers=CORS)
        if req.url.endswith("/models"):
            return route.fulfill(status=200, headers=CORS, content_type="application/json", body=json.dumps({"data": [{"id": "gpt-4o-mini"}]}))
        calls.append((req.url, req.headers.get("content-type", ""), req.post_data_buffer or b""))
        b = io.BytesIO()
        Image.new("RGB", (64, 64), (30, 200, 60)).save(b, "PNG")
        route.fulfill(status=200, headers=CORS, content_type="application/json",
                      body=json.dumps({"data": [{"b64_json": base64.b64encode(b.getvalue()).decode()}]}))

    ctx_settings = {"server_url": "https://api.openai.com/v1", "api_key": "sk-test", "default_model": "echo"}
    p, errors, polli = app(browser, ctx_settings)
    p.context.route("https://api.openai.com/v1/**", handle)
    reply = send_with_photo(p, photo_file(tmp_path), "turn this into anime style", 1)
    expect(reply.locator("img").first).to_be_visible()
    url, ctype, body = calls[-1]
    assert url.endswith("/images/edits") and ctype.startswith("multipart/form-data; boundary=")
    assert b'name="image[]"' in body and b"\x89PNG" in body and b"gpt-image-1" in body, "the photo itself is uploaded as bytes"
    assert not polli.calls
    assert not errors, errors
