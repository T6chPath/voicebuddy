"""A free pollinations.ai key (Settings → Pictures): pictures made online come from Z-Image Turbo — sharper, closer to the
request, with no wait between pictures. Without a key, or when the key fails, the free service still makes them."""
import json
import urllib.parse

from playwright.sync_api import expect

from test_images_standalone import CORS, HTML, Pollinations, image_colour, png, say


class PollenAPI:
    """gen.pollinations.ai: needs a key; remembers what the app asked for."""

    def __init__(self, mode="ok"):
        self.calls, self.mode = [], mode

    def handle(self, route):
        req = route.request
        if req.method == "OPTIONS":
            return route.fulfill(status=204, headers=CORS)
        u = urllib.parse.urlparse(req.url)
        prompt = urllib.parse.unquote(u.path.split("/image/", 1)[1])
        self.calls.append({"prompt": prompt, "auth": req.headers.get("authorization"), **dict(urllib.parse.parse_qsl(u.query))})
        if self.mode == "badkey":
            return route.fulfill(status=401, headers=CORS, content_type="application/json",
                                 body=json.dumps({"success": False, "error": {"message": "A valid API key is required."}, "status": 401}))
        route.fulfill(status=200, headers=CORS, content_type="image/jpeg", body=png((220, 30, 30), (512, 512), "JPEG"))


def open_app(browser, settings, pollen):
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    ctx.add_init_script(f"localStorage.setItem('zc.local.settings', {json.dumps(json.dumps(settings))}); window.__zcPolliGap = 0;")
    polli = Pollinations()
    ctx.route("https://image.pollinations.ai/**", polli.handle)
    ctx.route("https://gen.pollinations.ai/**", pollen.handle)
    p = ctx.new_page()
    errors = []
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.goto(HTML.as_uri())
    expect(p.locator("#composer-input")).to_be_visible()
    return p, errors, polli


def test_a_key_makes_pictures_with_z_image_turbo(browser):
    pollen = PollenAPI()
    p, errors, polli = open_app(browser, {"default_model": "echo", "pollinations_key": "sk_test_123"}, pollen)
    reply = say(p, "Generate an image of a red apple on a wooden table", 1)
    expect(reply.locator("img").first).to_be_visible()
    c = pollen.calls[0]
    assert c["model"] == "zimage" and c["auth"] == "Bearer sk_test_123", c
    assert c["prompt"].startswith("a red apple on a wooden table")
    assert not polli.calls, "no free-service wait"
    rgb, size = image_colour(p, reply)
    assert rgb[0] > 200 and size == (512, 512)
    # a second picture straight away: no 45-second wait
    say(p, "Generate an image of a red bicycle", 2)
    assert len(pollen.calls) == 2 and not polli.calls
    assert not errors, errors


def test_a_bad_key_falls_back_to_the_free_service(browser):
    pollen = PollenAPI("badkey")
    p, errors, polli = open_app(browser, {"default_model": "echo", "pollinations_key": "sk_wrong"}, pollen)
    reply = say(p, "Generate an image of a red apple", 1)
    expect(reply.locator("img").first).to_be_visible()
    expect(reply).to_contain_text("Z-Image Turbo couldn't make it (pollinations.ai didn't accept the key (check it in Settings → Pictures)), so the free image service made it.")
    assert len(polli.calls) == 1
    assert not errors, errors


def test_the_key_is_set_in_settings(browser):
    pollen = PollenAPI()
    p, errors, _ = open_app(browser, {"default_model": "echo"}, pollen)
    p.get_by_role("button", name="Open conversations").click()
    p.get_by_role("button", name="Settings", exact=True).click()
    field = p.get_by_label("pollinations.ai key (free)")
    expect(field).to_be_visible()
    expect(p.get_by_role("link", name="enter.pollinations.ai")).to_be_visible()
    field.fill("sk_mine")
    p.get_by_role("button", name="Save").click()
    expect(p.get_by_text("Saved", exact=True)).to_be_visible()
    assert json.loads(p.evaluate("localStorage.getItem('zc.local.settings')"))["pollinations_key"] == "sk_mine"
    assert not errors, errors
