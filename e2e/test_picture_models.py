"""Picture models: AI models that make pictures, picked in the model menu like a chat model — the free picture AI (the
chat's AI writes the picture, a free service draws it), OpenRouter's picture models, Google's Nano Banana."""
import base64
import json
import re

from playwright.sync_api import expect

from test_camera_pdf_read import FakeAI, wait_reply
from test_images_standalone import CORS, GEMINI_BASE, Gemini, Pollinations, app, png

WRITTEN = "A fluffy orange cat floating among the stars, a red nebula behind it, soft rim light, cinematic digital art."


class WriterAI(FakeAI):
    """A chat AI that answers one-off requests (stream: false) as JSON, like real services do."""

    def handle(self, route):
        req = route.request
        if req.method == "POST" and not req.url.endswith("/models") and json.loads(req.post_data).get("stream") is False:
            self.requests.append(json.loads(req.post_data))
            return route.fulfill(status=200, headers=CORS, content_type="application/json",
                                 body=json.dumps({"choices": [{"message": {"role": "assistant", "content": f'**Prompt:** "{self.reply}"'}}]}))
        return super().handle(route)


def pictures(p):
    return p.locator("article.msg-assistant").last.locator("img")


def test_free_picture_ai_writes_the_picture_and_a_free_service_draws_it(browser):
    ai = WriterAI(WRITTEN)
    p, errors, polli = app(browser, {"server_url": "http://fake-ai.test/v1", "api_key": "k", "default_model": "srv:vision-1"}, ai=ai)
    menu = p.get_by_label("Model")
    expect(menu.locator('optgroup[label="Make pictures"] option[value="img:free"]')).to_have_text("Picture AI — free")
    menu.select_option("img:free")
    box = p.locator("#composer-input")
    expect(box).to_have_attribute("placeholder", "Describe a picture for Picture AI — free to make…")
    box.fill("my cat in space")
    box.press("Enter")
    wait_reply(p, 1)
    reply = p.locator("article.msg-assistant").last
    expect(pictures(p)).to_have_count(1)
    expect(reply).to_contain_text("Here is your image of my cat in space")          # the user's words, not the long prompt
    # the chat's own AI wrote the picture…
    w = ai.requests[0]
    assert w["model"] == "vision-1" and w["stream"] is False
    assert "prompts for an image generator" in w["messages"][0]["content"]
    assert w["messages"][-1]["content"].endswith("The picture to make now: my cat in space")
    # …and the free service drew exactly that
    assert len(polli.calls) == 1 and "fluffy orange cat floating among the stars" in polli.calls[0]["prompt"]
    # a change to it: the same picture, at night (the conversation is the context)
    box.fill("make it at night")
    box.press("Enter")
    wait_reply(p, 2)
    expect(pictures(p)).to_have_count(1)
    assert "night" in polli.calls[-1]["prompt"] and "orange cat" in polli.calls[-1]["prompt"], polli.calls[-1]
    assert not errors, errors


class OpenRouter:
    """OpenRouter's model list and picture models: Nano Banana 2 (pictures and words) and Grok Imagine (pictures only)."""
    MODELS = [
        {"id": "openrouter/free", "name": "Free router", "pricing": {"prompt": "0", "completion": "0"}},
        {"id": "nvidia/nemotron-3-ultra:free", "name": "NVIDIA: Nemotron 3 Ultra", "architecture": {"output_modalities": ["text"]}},
        {"id": "google/gemini-3.1-flash-image", "name": "Google: Nano Banana 2 (Gemini 3.1 Flash Image)", "architecture": {"output_modalities": ["image", "text"]}},
        {"id": "x-ai/grok-imagine-image-quality:free", "name": "xAI: Grok Imagine Image Quality", "architecture": {"output_modalities": ["image"]}},
    ]

    def __init__(self):
        self.calls = []

    def handle(self, route):
        req = route.request
        if req.method == "OPTIONS":
            return route.fulfill(status=204, headers=CORS)
        if req.url.endswith("/models"):
            return route.fulfill(status=200, headers=CORS, content_type="application/json", body=json.dumps({"data": self.MODELS}))
        body = json.loads(req.post_data)
        self.calls.append(body)
        if "grok" in body["model"] and "text" in body.get("modalities", []):
            return route.fulfill(status=400, headers=CORS, content_type="application/json", body=json.dumps({"error": {"message": "output modality text not supported"}}))
        img = "data:image/png;base64," + base64.b64encode(png((30, 90, 200))).decode()
        route.fulfill(status=200, headers=CORS, content_type="application/json", body=json.dumps(
            {"choices": [{"message": {"role": "assistant", "content": "", "images": [{"type": "image_url", "image_url": {"url": img}}]}}]}))


def test_openrouter_picture_models_in_the_model_menu(browser):
    orr = OpenRouter()
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    settings = {"server_url": "https://openrouter.ai/api/v1", "api_key": "k", "default_model": "srv:openrouter/free"}
    ctx.add_init_script(f"localStorage.setItem('zc.local.settings', {json.dumps(json.dumps(settings))});")
    ctx.route("https://openrouter.ai/api/v1/**", orr.handle)
    polli = Pollinations()
    ctx.route("https://image.pollinations.ai/**", polli.handle)
    p = ctx.new_page()
    errors = []
    p.on("pageerror", lambda e: errors.append(str(e)))
    from test_images_standalone import HTML
    p.goto(HTML.as_uri())
    menu = p.get_by_label("Model")
    group = menu.locator('optgroup[label="Make pictures"]')
    expect(group.locator("option")).to_have_text(["Grok Imagine Image Quality (free)", "Nano Banana 2 (Gemini 3.1 Flash Image)", "Picture AI — free"])
    expect(menu.locator('option[value="srv:nvidia/nemotron-3-ultra:free"]')).to_have_count(1)        # chat models stay chat models
    menu.select_option("srv:x-ai/grok-imagine-image-quality:free")
    p.locator("#composer-input").fill("a lighthouse at dusk")
    p.locator("#composer-input").press("Enter")
    wait_reply(p, 1)
    expect(pictures(p)).to_have_count(1)
    assert [c["modalities"] for c in orr.calls] == [["image", "text"], ["image"]]          # a pictures-only model: asked again
    assert orr.calls[-1]["model"] == "x-ai/grok-imagine-image-quality:free" and orr.calls[-1]["image_config"] == {"aspect_ratio": "1:1"}
    assert "a lighthouse at dusk" in json.dumps(orr.calls[-1]["messages"])
    assert polli.calls == []                                                                # the picture model made it
    assert not errors, errors
    ctx.close()


class GeminiChat(FakeAI):
    MODELS = ["gemini-3.8-flash", "gemini-3.1-flash-image", "gemini-3.1-flash-lite-image"]

    def handle(self, route):
        if route.request.url.endswith("/models"):
            return route.fulfill(status=200, headers=CORS, content_type="application/json", body=json.dumps({"data": [{"id": m} for m in self.MODELS]}))
        return super().handle(route)


class GeminiUrls(Gemini):
    def __init__(self, mode="ok"):
        super().__init__(mode)
        self.urls = []

    def handle(self, route):
        self.urls.append(route.request.url)
        return super().handle(route)


def test_nano_banana_on_a_free_key_falls_back_to_the_free_picture_ai(browser):
    gem = GeminiUrls("quota")
    p, errors, polli = app(browser, {"server_url": GEMINI_BASE, "api_key": "free-key", "default_model": "srv:gemini-3.8-flash"},
                           ai=GeminiChat("ok"), gem=gem)
    menu = p.get_by_label("Model")
    expect(menu.locator('optgroup[label="Make pictures"] option')).to_have_text(["Nano Banana 2", "Nano Banana 2 Lite", "Picture AI — free"])
    menu.select_option("srv:gemini-3.1-flash-image")
    p.locator("#composer-input").fill("a red apple on a table")
    p.locator("#composer-input").press("Enter")
    wait_reply(p, 1)
    expect(pictures(p)).to_have_count(1)
    assert gem.urls and "/models/gemini-3.1-flash-image:generateContent" in gem.urls[0]
    reply = p.locator("article.msg-assistant").last
    expect(reply).to_contain_text("Nano Banana 2 couldn't make this picture")
    expect(reply).to_contain_text("billing")
    expect(reply).to_contain_text("The free picture AI made it instead")
    assert len(polli.calls) == 1 and "red apple" in polli.calls[0]["prompt"]
    assert not errors, errors
