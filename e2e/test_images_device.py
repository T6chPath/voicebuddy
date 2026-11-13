"""Pictures made on the phone itself (Android app: window.ZenvqoImageGen runs stable-diffusion.cpp). Here a stand-in
plays the phone's engine; it records what the app asks for and answers with a plain-colour PNG. The real engine
is checked on the emulator (e2e/android) and by the zenvqo-image-engine workflow."""
import json
import re

from playwright.sync_api import expect

from test_camera_pdf_read import wait_reply
from test_images_features import img_of, photo_file, send_with_photo
from test_images_standalone import Pollinations, say

from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
HTML = ROOT / "frontend" / "dist-standalone" / "zenvqo-chat.html"

FAKE = """
window.__fake = { calls: [], files: %(files)s, fail: %(fail)s, stall: %(stall)s };
window.ZenvqoImageGen = {
  info: () => JSON.stringify({ engine: true, abi: "arm64-v8a", cores: 8, ramMB: 6144, availMB: 3000, freeMB: 20000,
                               files: window.__fake.files, downloading: null, busy: false }),
  download: (name, url, exp) => {
    window.__fake.calls.push({ download: name, url });
    let d = 0;
    const t = setInterval(() => {
      d += exp / 4;
      window.__zig("dl", { name, done: Math.min(d, exp), total: exp });
      if (d >= exp) { clearInterval(t); window.__fake.files[name] = exp; window.__zig("dlend", { name }); }
    }, 60);
    return true;
  },
  cancelDownload() {}, remove(n) { delete window.__fake.files[n]; return true; },
  generate(id, json) {
    const a = JSON.parse(json);
    window.__fake.calls.push(a);
    setTimeout(() => {
      if (window.__fake.stall) { window.__zig("gen", { id, phase: "load", step: 0, steps: 0 }); return; }   // then nothing: stuck
      if (window.__fake.fail) { window.__zig("generr", { id, error: "boom", log: ["x"] }); return; }
      window.__zig("gen", { id, phase: "sample", step: 1, steps: 2 });
      const c = document.createElement("canvas"); c.width = a.width; c.height = a.height;
      const x = c.getContext("2d"); x.fillStyle = a.init ? "rgb(30,200,60)" : "rgb(220,30,30)"; x.fillRect(0, 0, c.width, c.height);
      const b64 = c.toDataURL("image/png").split(",")[1];
      window.__zig("img", { id, chunk: b64.slice(0, 500) });
      window.__zig("img", { id, chunk: b64.slice(500) });
      window.__zig("genend", { id, ms: 5 });
    }, 150);
    return true;
  },
  cancel(id) { window.__fake.calls.push({ cancel: id }); },
};
"""
MODEL = {"sd_turbo-q4_0.gguf": 1700 * 1048576, "taesd.safetensors": 10 * 1048576}
SDXS_FILE, SDXS_MB = "sdxs512-dreamshaper-sdxs-q8_0.gguf", 652


def phone(browser, settings, files=None, fail=False, stall=False, extra=""):
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    ctx.add_init_script(f"localStorage.setItem('zc.local.settings', {json.dumps(json.dumps(settings))}); window.__zcPolliGap = 0;" + extra
                        + FAKE % {"files": json.dumps(files or {}), "fail": "true" if fail else "false", "stall": "true" if stall else "false"})
    polli = Pollinations()
    ctx.route("https://image.pollinations.ai/**", polli.handle)
    p = ctx.new_page()
    errors = []
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.goto(HTML.as_uri())
    expect(p.locator("#composer-input")).to_be_visible()
    return p, errors, polli


def calls(p):
    return p.evaluate("window.__fake.calls")


def test_download_the_model_in_settings(browser):
    p, errors, _ = phone(browser, {"default_model": "echo"})
    p.get_by_role("button", name="Open conversations").click()
    p.get_by_role("button", name="Settings", exact=True).click()
    panel = p.locator("fieldset.device-pictures")
    expect(panel).to_contain_text("Pictures on this phone")
    expect(panel).to_contain_text("6.0 GB memory")
    fastest = panel.locator("li").first                                    # the fastest model comes first
    expect(fastest).to_contain_text("SDXS — fastest")
    expect(fastest).to_contain_text("A picture in about 5–10 seconds")
    fastest.get_by_role("button", name="Download").click()
    expect(fastest.locator("progress")).to_be_visible()
    expect(fastest).to_contain_text("Downloaded", timeout=10_000)
    downloads = [c for c in calls(p) if "download" in c]
    assert [d["download"] for d in downloads] == [SDXS_FILE, "taesd.safetensors"]
    assert downloads[0]["url"].startswith("https://github.com/T6chPath/voicebuddy/releases/download/zenvqo-image-engine/")
    expect(panel.get_by_label("Quality")).to_have_count(0)                 # it always draws in one step
    # SD-Turbo too: then both can be chosen, and SD-Turbo has quality steps
    small = panel.locator("li").filter(has_text="SD-Turbo — small")
    small.get_by_role("button", name="Download").click()
    expect(small).to_contain_text("Downloaded", timeout=10_000)
    expect(panel.get_by_label("Model to use")).to_have_value("sd-turbo-small")
    expect(panel.get_by_label("Quality")).to_have_value("fast")
    panel.get_by_label("Model to use").select_option("sdxs")
    p.get_by_role("button", name="Save").click()
    expect(p.get_by_text("Saved", exact=True)).to_be_visible()
    saved = json.loads(p.evaluate("localStorage.getItem('zc.local.settings')"))
    assert saved["device_model"] == "sdxs" and saved["image_engine"] == "auto"
    assert not errors, errors


def test_the_fastest_model_draws_and_sd_turbo_changes_photos(browser, tmp_path):
    """SDXS draws new pictures in one step with its own tiny decoder; changing a photo uses SD-Turbo when it's there."""
    files = {**MODEL, SDXS_FILE: SDXS_MB * 1048576}
    p, errors, polli = phone(browser, {"default_model": "echo", "device_model": "sdxs", "device_quality": "best"}, files)
    reply = say(p, "Generate an image of a red apple on a wooden table", 1)
    expect(reply.locator("img").first).to_be_visible()
    a = calls(p)[0]
    assert a["model"] == SDXS_FILE and a["steps"] == 1 and a["cfg"] == 1, a       # one step, whatever the quality setting
    edit = send_with_photo(p, photo_file(tmp_path), "turn this into anime style", 2)
    expect(edit.locator("img").first).to_be_visible()
    assert calls(p)[1]["model"] == "sd_turbo-q4_0.gguf"
    assert not polli.calls
    assert not errors, errors


def test_pictures_are_made_on_the_phone(browser):
    p, errors, polli = phone(browser, {"default_model": "echo", "device_model": "sd-turbo-small"}, MODEL)
    reply = say(p, "Generate an image of a red apple on a wooden table", 1)
    expect(reply.locator("img").first).to_be_visible()
    a = calls(p)[0]
    assert a["model"] == "sd_turbo-q4_0.gguf" and a["taesd"] == "taesd.safetensors"
    assert a["prompt"].startswith("a red apple on a wooden table") and a["steps"] == 1 and a["cfg"] == 1
    assert (a["width"], a["height"]) == (512, 512) and "init" not in a
    assert not polli.calls, "nothing goes to the online service"
    im = img_of(reply).convert("RGB")
    assert im.getpixel((5, 5))[0] > 200
    # wide pictures keep about the same area
    say(p, "Generate an image of a mountain lake in 16:9", 2)
    b = calls(p)[1]
    assert b["width"] > b["height"] and b["width"] % 64 == 0 and b["height"] % 64 == 0
    # exact words still go on top
    poster = say(p, 'Create a poster with the text "Grand Opening"', 3)
    expect(poster).to_contain_text('The words "Grand Opening" were set on the picture by the app')
    assert "no text" in calls(p)[2]["prompt"]
    assert not polli.calls
    assert not errors, errors


def test_your_photo_is_really_edited_on_the_phone(browser, tmp_path):
    p, errors, polli = phone(browser, {"default_model": "echo", "device_model": "sd-turbo-small"}, MODEL)
    reply = send_with_photo(p, photo_file(tmp_path), "turn this into anime style", 1)
    expect(reply.locator("img").first).to_be_visible()
    a = calls(p)[0]
    assert a["init"].startswith("data:image/png;base64,") and abs(a["strength"] - 0.75) < 1e-6 and a["steps"] >= 2
    assert "anime" in a["prompt"]
    expect(reply).to_contain_text("Changed on your phone")
    assert not polli.calls
    # expanding: the picture with a mask of the new area, then the original is kept exactly
    w0, h0 = img_of(reply).size
    reply.get_by_role("button", name="Expand the image").click()
    wait_reply(p, 2)
    wide = p.locator("article.msg-assistant").last
    expect(wide.locator("img").first).to_be_visible()
    b = calls(p)[1]
    assert "mask" in b and "init" in b
    w1, h1 = img_of(wide).size
    assert w1 > w0 and h1 > h0
    assert not polli.calls
    assert not errors, errors


def test_falls_back_online_or_says_what_to_do(browser):
    p, errors, polli = phone(browser, {"default_model": "echo", "device_model": "sd-turbo-small"}, MODEL, fail=True)
    reply = say(p, "Generate an image of a red apple", 1)
    expect(reply.locator("img").first).to_be_visible()
    expect(reply).to_contain_text("didn't work this time, so the free online service made it")
    assert len(polli.calls) == 1
    # only on this phone, no model yet: says how to get it, never goes online
    p2, errors2, polli2 = phone(browser, {"default_model": "echo", "image_engine": "device"})
    r2 = say(p2, "Generate an image of a red apple", 1)
    expect(r2).to_contain_text("Settings → Pictures on this phone")
    assert not polli2.calls
    assert not errors and not errors2, (errors, errors2)


BETTER = {"sd_turbo-f16-q8_0.gguf": 2020 * 1048576, "taesd.safetensors": 10 * 1048576}


def test_a_stuck_phone_engine_is_stopped(browser):
    """The phone's engine stops showing signs of life (short of memory): the time keeps counting on screen, then the app
    stops it and the free online service makes the picture, saying why and pointing to the smaller model."""
    p, errors, polli = phone(browser, {"default_model": "echo", "device_model": "sd-turbo"}, BETTER, stall=True, extra="window.__zigStallMs = 4000;")
    p.locator("#composer-input").fill("Generate an image of a red apple")
    p.locator("#composer-input").press("Enter")
    busy = p.locator("article.msg-assistant").last
    expect(busy).to_contain_text(re.compile(r"Loading the picture model on your phone… [1-9] s"), timeout=5000)   # counts without news
    reply = say_wait(p, 1)
    expect(reply.locator("img").first).to_be_visible()
    expect(reply).to_contain_text("Your phone ran short of memory making it with SD-Turbo — better detail, so the free online service made it.")
    expect(reply).to_contain_text("SDXS — fastest (Settings → Pictures on this phone) needs less memory.")
    assert any("cancel" in c for c in calls(p)), calls(p)
    assert len(polli.calls) == 1
    # only on this phone: says what happened and what to do, never goes online
    p2, errors2, polli2 = phone(browser, {"default_model": "echo", "device_model": "sd-turbo", "image_engine": "device"}, BETTER, stall=True,
                                extra="window.__zigStallMs = 3000;")
    p2.locator("#composer-input").fill("Generate an image of a red apple")
    p2.locator("#composer-input").press("Enter")
    expect(p2.locator("article.msg-assistant").last).to_contain_text("it made no progress for several minutes", timeout=15_000)
    expect(p2.locator("article.msg-assistant").last).to_contain_text("SDXS — fastest (Settings → Pictures on this phone) needs less memory.")
    assert not polli2.calls
    assert not errors and not errors2, (errors, errors2)


def say_wait(p, n):
    wait_reply(p, n)
    return p.locator("article.msg-assistant").last


def test_a_picture_cut_off_by_closing_the_app_can_be_made_again(browser):
    """Android closed the app while the phone was making a picture (it needs a lot of memory): when the chat opens again
    the picture says it wasn't finished, with Retry — it doesn't load forever."""
    p, errors, polli = phone(browser, {"default_model": "echo", "device_model": "sd-turbo-small"}, MODEL, stall=True)
    p.locator("#composer-input").fill("Generate an image of a red apple")
    p.locator("#composer-input").press("Enter")
    expect(p.locator("article.msg-assistant").last).to_contain_text("Loading the picture model on your phone")
    p.reload()                                                               # the app was closed and opened again
    reply = p.locator("article.msg-assistant").last
    expect(reply).to_contain_text("This wasn't finished: the app was closed")
    expect(reply).to_have_attribute("aria-busy", "false")
    p.evaluate("window.__fake.stall = false")
    reply.get_by_role("button", name="Retry").click()
    wait_reply(p, 1)
    expect(p.locator("article.msg-assistant").last.locator("img").first).to_be_visible()
    assert not polli.calls
    assert not errors, errors


def test_a_slow_phone_draws_smaller_to_stay_under_10_seconds(browser):
    """This phone took 35 s for a full-size picture: the next one is drawn smaller (then enlarged), so it's quick; the
    reply says how long it took and where the time went. "Full size" in Settings keeps 512×512."""
    files = {**MODEL, SDXS_FILE: SDXS_MB * 1048576}
    slow = json.dumps(json.dumps({SDXS_FILE: [[512 * 512, 35000]]}))
    p, errors, polli = phone(browser, {"default_model": "echo", "device_model": "sdxs"}, files,
                             extra=f"localStorage.setItem('zc.phone.speed', {slow});")
    reply = say(p, "Generate an image of a red apple", 1)
    expect(reply.locator("img").first).to_be_visible()
    a = calls(p)[0]
    assert (a["width"], a["height"]) == (256, 256), a
    expect(reply).to_contain_text(re.compile(r"Made on your phone in \d+ s \(getting ready \d+ s, drawing \d+ s, finishing \d+ s\)"))
    expect(reply).to_contain_text("To be quick, your phone drew it at 256×256 and enlarged it.")
    assert img_of(reply).size == (512, 512)
    speed = json.loads(p.evaluate("localStorage.getItem('zc.phone.speed')"))[SDXS_FILE]
    assert speed[-1][0] == 256 * 256 and len(speed) == 2                    # it learns this phone's speed
    # full size, always
    p2, errors2, _ = phone(browser, {"default_model": "echo", "device_model": "sdxs", "device_size": "full"}, files,
                           extra=f"localStorage.setItem('zc.phone.speed', {slow});")
    r2 = say(p2, "Generate an image of a red apple", 1)
    expect(r2.locator("img").first).to_be_visible()
    assert (calls(p2)[0]["width"], calls(p2)[0]["height"]) == (512, 512)
    expect(r2).not_to_contain_text("To be quick")
    assert not polli.calls
    assert not errors and not errors2, (errors, errors2)
