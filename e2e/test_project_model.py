"""Projects (an app, a website, a game…) are written with the strongest coding model on the user's AI service: the chat
switches to it, says so, and keeps it for the follow-ups. A model the user picked, and ordinary questions, stay as they are."""
import json

from playwright.sync_api import expect

from test_book_ui import GEMINI, BookAI
from test_camera_pdf_read import HTML, wait_reply

SITE = """# Sweet Crumbs bakery

**`index.html`**
```html
<!doctype html><title>Sweet Crumbs</title><h1>Sweet Crumbs</h1>
```
Tap “View site” to see it.
"""


class Service(BookAI):
    """An AI service listing several models; remembers which model each request asked for."""

    def __init__(self, models, replies):
        super().__init__(replies)
        self.models, self.bodies = models, []

    def handle(self, route):
        req = route.request
        cors = {"access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS"}
        if req.method == "OPTIONS":
            return route.fulfill(status=204, headers=cors)
        if req.url.endswith("/models"):
            return route.fulfill(status=200, headers=cors, content_type="application/json", body=json.dumps({"data": [{"id": m} for m in self.models]}))
        self.bodies.append(json.loads(req.post_data))
        return super().handle(route)


def open_service(browser, url, ai, default):
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    settings = {"server_url": url, "api_key": "test-key", "default_model": default}
    ctx.add_init_script(f"localStorage.setItem('zc.local.settings', {json.dumps(json.dumps(settings))});")
    ctx.route(url + "/**", ai.handle)
    p = ctx.new_page()
    errors = []
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.goto(HTML.as_uri())
    expect(p.get_by_label("Model")).to_have_value(default)
    return ctx, p, errors


def ask(p, text, n):
    box = p.locator("#composer-input")
    box.fill(text)
    box.press("Enter")
    wait_reply(p, n)


GEMINI_MODELS = ["gemini-2.5-flash", "gemini-3.8-flash", "gemini-3.8-flash-lite", "gemini-3.1-pro-preview"]


def test_project_written_with_the_strongest_coder(browser):
    ai = Service(GEMINI_MODELS, ["Plants make food from light.", SITE, "Add a menu section under the hero."])
    ctx, p, errors = open_service(browser, GEMINI, ai, "srv:gemini-2.5-flash")
    ask(p, "Explain photosynthesis simply", 1)                         # an ordinary question: the chat's own model
    assert ai.bodies[-1]["model"] == "gemini-2.5-flash"
    expect(p.get_by_label("Model")).to_have_value("srv:gemini-2.5-flash")
    ask(p, "Make a website for a small bakery", 2)                     # a project: the strongest coder on the service
    assert ai.bodies[-1]["model"] == "gemini-3.8-flash", ai.bodies[-1]["model"]
    expect(p.get_by_label("Model")).to_have_value("srv:gemini-3.8-flash")    # shown at the top
    expect(p.locator(".toast")).to_contain_text("Writing this project with Gemini 3.8 Flash, a stronger coding model.")
    expect(p.locator("article.msg-assistant").last.locator(".code-block")).to_have_count(1)
    ask(p, "how do I add a menu to it?", 3)                           # follow-ups keep it
    assert ai.bodies[-1]["model"] == "gemini-3.8-flash"
    assert not errors, errors
    ctx.close()


def test_a_model_the_user_picked_stays(browser):
    ai = Service(GEMINI_MODELS, [SITE])
    ctx, p, errors = open_service(browser, GEMINI, ai, "srv:gemini-2.5-flash")
    p.get_by_label("Model").select_option("srv:gemini-3.8-flash-lite")
    ask(p, "Make a website for a small bakery", 1)
    assert ai.bodies[-1]["model"] == "gemini-3.8-flash-lite"
    expect(p.get_by_label("Model")).to_have_value("srv:gemini-3.8-flash-lite")
    expect(p.locator(".toast")).to_have_count(0)
    assert not errors, errors
    ctx.close()


def test_openrouter_free_key_gets_the_best_free_coder(browser):
    url = "https://openrouter.ai/api/v1"
    ai = Service(["openrouter/free", "nvidia/nemotron-3-ultra:free", "openai/gpt-oss-120b:free", "google/gemma-4-31b-it:free",
                  "anthropic/claude-opus-5.5", "google/gemini-3.8-flash"], [SITE])
    ctx, p, errors = open_service(browser, url, ai, "srv:openrouter/free")
    ask(p, "build a snake game in html", 1)
    assert ai.bodies[-1]["model"] == "nvidia/nemotron-3-ultra:free", ai.bodies[-1]["model"]   # free key: free models only
    expect(p.locator(".toast")).to_contain_text("Writing this project with Nemotron 3 Ultra")
    assert not errors, errors
    ctx.close()
