"""Making pictures in the phone app (the standalone build in the APK), with stand-ins for the image services:
Pollinations (free, no key) and Gemini (the user's key). Checks what the app asks the services for and what the
chat shows."""
import base64
import io
import json
import urllib.parse
from pathlib import Path

from PIL import Image
from playwright.sync_api import expect

from test_camera_pdf_read import FakeAI, wait_reply

ROOT = Path(__file__).resolve().parents[1]
HTML = ROOT / "frontend" / "dist-standalone" / "zenvqo-chat.html"
SHOTS = Path(__file__).parent / "screenshots"
CORS = {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS"}
GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai"


def png(rgb, size=(256, 256), fmt="PNG"):
    b = io.BytesIO()
    Image.new("RGB", size, rgb).save(b, fmt)
    return b.getvalue()


class Pollinations:
    def __init__(self, busy_first=False):
        self.calls, self.busy_first = [], busy_first

    def handle(self, route):
        u = urllib.parse.urlparse(route.request.url)
        prompt = urllib.parse.unquote(u.path.split("/prompt/", 1)[1])
        q = dict(urllib.parse.parse_qsl(u.query))
        self.calls.append({"prompt": prompt, **q})
        if self.busy_first and len(self.calls) == 1:
            return route.fulfill(status=429, headers={**CORS, "retry-after": "1"}, body="Too many requests")
        colour = (220, 30, 30) if "red" in prompt else (20, 20, 60) if "night" in prompt else (200, 200, 200)
        route.fulfill(status=200, headers=CORS, content_type="image/jpeg", body=png(colour, (int(q.get("width", 512)) // 4, int(q.get("height", 512)) // 4), "JPEG"))


class Gemini:
    def __init__(self, mode="ok"):
        self.calls, self.mode = [], mode

    def handle(self, route):
        if route.request.method == "OPTIONS":
            return route.fulfill(status=204, headers=CORS)
        body = json.loads(route.request.post_data)
        self.calls.append(body)
        if self.mode == "quota":
            return route.fulfill(status=429, headers=CORS, content_type="application/json", body=json.dumps(
                {"error": {"code": 429, "message": "Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-2.5-flash-image", "status": "RESOURCE_EXHAUSTED"}}))
        img = base64.b64encode(png((20, 180, 40))).decode()
        route.fulfill(status=200, headers=CORS, content_type="application/json", body=json.dumps(
            {"candidates": [{"content": {"parts": [{"text": "Here it is"}, {"inlineData": {"mimeType": "image/png", "data": img}}]}, "finishReason": "STOP"}]}))


def app(browser, settings, ai=None, polli=None, gem=None):
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    ctx.add_init_script(f"localStorage.setItem('zc.local.settings', {json.dumps(json.dumps(settings))});")
    polli = polli or Pollinations()
    ctx.route("https://image.pollinations.ai/**", polli.handle)
    if gem:
        ctx.route("https://generativelanguage.googleapis.com/v1beta/models/**", gem.handle)
    if ai:
        ctx.route(GEMINI_BASE + "/**", ai.handle)
        ctx.route("http://fake-ai.test/v1/**", ai.handle)
    p = ctx.new_page()
    errors = []
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.goto(HTML.as_uri())
    expect(p.locator("#composer-input")).to_be_visible()
    return p, errors, polli


def say(p, text, n):
    p.locator("#composer-input").fill(text)
    p.locator("#composer-input").press("Enter")
    wait_reply(p, n)
    return p.locator("article.msg-assistant").last


def image_colour(p, reply):
    src = reply.locator("img").first.get_attribute("src")
    assert src and src.startswith("data:image/"), src
    im = Image.open(io.BytesIO(base64.b64decode(src.split(",", 1)[1]))).convert("RGB")
    return im.getpixel((im.width // 2, im.height // 2)), im.size


def test_free_images_in_the_demo_then_change_and_regenerate(browser):
    p, errors, polli = app(browser, {"default_model": "echo"})
    reply = say(p, "Generate an image of a red apple on a wooden table in 16:9", 1)
    expect(reply.locator("img").first).to_be_visible()
    expect(reply).to_contain_text("Here is your image of a red apple on a wooden table")
    call = polli.calls[0]
    assert call["prompt"] == "a red apple on a wooden table" and call["model"] == "flux" and call["safe"] == "true"
    assert (call["width"], call["height"]) == ("1024", "576") and call["seed"].isdigit()
    (r, g, b), size = image_colour(p, reply)
    assert r > 180 and g < 80 and size == (256, 144)
    SHOTS.mkdir(exist_ok=True)
    reply.screenshot(path=str(SHOTS / "image-free.png"))
    # a change to the picture the app made: re-imagined from its description, with a note saying so
    reply2 = say(p, "make it night time", 2)
    expect(reply2.locator("img").first).to_be_visible()
    assert polli.calls[1]["prompt"] == "a red apple on a wooden table, night time"
    assert polli.calls[1]["width"] == "1024" and polli.calls[1]["height"] == "576"            # same shape as the original
    expect(reply2).to_contain_text("new version made from the original description")
    # regenerate: a fresh picture with a new seed
    reply2.get_by_role("button", name="Regenerate").click()
    wait_reply(p, 2)
    expect(p.locator("article.msg-assistant").last.locator("img").first).to_be_visible()
    assert len(polli.calls) == 3 and polli.calls[2]["seed"] != polli.calls[1]["seed"]
    # ordinary chat still goes to the model, and graphs aren't mistaken for pictures
    say(p, "plot y = x^2", 3)
    assert len(polli.calls) == 3
    assert not errors, errors


def test_gemini_key_without_image_quota_falls_back(browser):
    gem = Gemini("quota")
    p, errors, polli = app(browser, {"server_url": GEMINI_BASE, "api_key": "AIza-test-1234567890", "default_model": "srv:gemini-2.5-flash"},
                           ai=FakeAI("Hi."), gem=gem)
    reply = say(p, "Create a picture of a lighthouse on a cliff", 1)
    expect(reply.locator("img").first).to_be_visible()
    expect(reply).to_contain_text("Your Gemini key can't make images")
    assert len(gem.calls) == 1 and len(polli.calls) == 1
    say(p, "Create a picture of a sailing boat", 2)
    assert len(gem.calls) == 1, "a key known to have no image quota isn't asked again"
    assert len(polli.calls) == 2
    assert not errors, errors


def test_gemini_makes_and_edits_including_your_photo(browser, tmp_path):
    gem = Gemini("ok")
    p, errors, polli = app(browser, {"server_url": GEMINI_BASE, "api_key": "AIza-test-abcdefgh", "default_model": "srv:gemini-2.5-flash"},
                           ai=FakeAI("Hi."), gem=gem)
    reply = say(p, "Generate an image of a cat astronaut", 1)
    expect(reply.locator("img").first).to_be_visible()
    (r, g, b), _ = image_colour(p, reply)
    assert g > 150 and not polli.calls
    parts = gem.calls[0]["contents"][0]["parts"]
    assert parts[0]["text"].startswith("Generate an image: a cat astronaut") and gem.calls[0]["generationConfig"]["imageConfig"]["aspectRatio"] == "1:1"
    # your own photo: remove its background
    photo = tmp_path / "me.png"
    photo.write_bytes(png((10, 10, 200)))
    p.locator("form.composer input[type=file]").set_input_files(str(photo))
    p.locator("#composer-input").fill("remove the background")
    expect(p.get_by_role("button", name="Send message")).to_be_enabled(timeout=5_000)
    p.locator("#composer-input").press("Enter")
    wait_reply(p, 2)
    reply2 = p.locator("article.msg-assistant").last
    expect(reply2.locator("img").first).to_be_visible()
    expect(reply2).to_contain_text("without the background")
    edit = gem.calls[1]["contents"][0]["parts"]
    assert edit[0]["text"].startswith("Remove the background completely")
    sent = Image.open(io.BytesIO(base64.b64decode(edit[1]["inlineData"]["data"]))).convert("RGB")
    assert sent.getpixel((5, 5))[2] > 150, "the user's own photo is what Gemini edits"
    assert not errors, errors


def test_free_service_cannot_edit_your_photo_and_says_how(browser, tmp_path):
    p, errors, polli = app(browser, {"default_model": "echo"})
    photo = tmp_path / "me.png"
    photo.write_bytes(png((10, 10, 200)))
    p.locator("form.composer input[type=file]").set_input_files(str(photo))
    p.locator("#composer-input").fill("remove the background")
    expect(p.get_by_role("button", name="Send message")).to_be_enabled(timeout=5_000)
    p.locator("#composer-input").press("Enter")
    wait_reply(p, 1)
    expect(p.locator("article.msg-assistant").last).to_contain_text("Changing your own photos needs an image editor")
    assert not polli.calls
    assert not errors, errors


def test_safety_busy_service_and_model_marker(browser):
    ai = FakeAI("[[image: a blue whale swimming under the sea, sunlight from above]]\nHere you go — a whale for you!")
    polli = Pollinations(busy_first=True)
    p, errors, _ = app(browser, {"server_url": "http://fake-ai.test/v1", "api_key": "k", "default_model": "srv:vision-1"}, ai=ai, polli=polli)
    refused = say(p, "generate an image of a nude woman", 1)
    expect(refused).to_contain_text("I can't create sexual or nude images")
    assert not polli.calls and not ai.requests
    # the model asks for a picture itself; the free service is busy once and the app waits and retries
    reply = say(p, "show me what a blue whale looks like", 2)
    expect(reply.locator("img").first).to_be_visible(timeout=20_000)
    expect(reply).to_contain_text("Here you go — a whale for you!")
    expect(reply).not_to_contain_text("[[image")
    assert len(polli.calls) == 2 and polli.calls[1]["prompt"] == "a blue whale swimming under the sea, sunlight from above"
    system = ai.requests[0]["messages"][0]["content"]
    assert "[[image:" in system
    assert not errors, errors
