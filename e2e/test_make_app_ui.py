"""'Make app': web pages → Android apps, in the phone app build, with a stand-in for the Android side
(window.ZenvqoApk). The real builder is checked in CI with apksigner/aapt2 and on the emulator."""
import json

from playwright.sync_api import expect

from test_camera_pdf_read import FakeAI, open_app, wait_reply

PAGE = """<!doctype html>
<html><head><title>Chai Counter</title></head>
<body><h1>Chai Counter</h1><button onclick="n.textContent=++c">+1</button><span id="n">0</span><script>let c=0</script></body></html>"""

BRIDGE = """
window.__apk = [];
window.ZenvqoApk = {
  status() { return JSON.stringify({ready: true}); },
  build(id, html, name, icon) {
    window.__apk.push({ev: 'build', html, name, icon});
    setTimeout(() => window.__zapk(id, 'built', JSON.stringify({pkg: 'app.zenvqo.web.chaicounter_x', name, size: 123456, saved: 'Downloads/zenvqo/Chai-Counter.apk'})), 300);
  },
  install(id) { window.__apk.push({ev: 'install', id}); setTimeout(() => window.__zapk(id, 'installed', ''), 300); },
  open(id) { window.__apk.push({ev: 'open', id}); },
  share(id) { window.__apk.push({ev: 'share', id}); },
  installed() { return true; },
};
"""


def test_make_app_from_a_page_the_ai_wrote(browser):
    ai = FakeAI("Here is your app:\n\n```html\n" + PAGE + "\n```\n\nTap **Make app** under the code to install it.")
    p, errors = open_app(browser, ai, BRIDGE)
    p.locator("#composer-input").fill("make me a chai counter app")
    p.locator("#composer-input").press("Enter")
    wait_reply(p, 1)
    system = ai.requests[0]["messages"][0]["content"]
    assert "Make app" in system and "self-contained HTML" in system
    expect(p.locator("article.msg-assistant .code-block .hljs-tag").first).to_be_visible()      # HTML is coloured
    p.locator("article.msg-assistant").last.get_by_role("button", name="Make an Android app from this page").click()
    dlg = p.get_by_role("dialog", name="Make an Android app")
    expect(dlg).to_be_visible()
    expect(dlg.get_by_label("App name")).to_have_value("Chai Counter")
    dlg.get_by_role("button", name="Make app").click()
    expect(dlg).to_contain_text("is ready", timeout=5_000)
    expect(dlg).to_contain_text("Downloads/zenvqo/Chai-Counter.apk")
    built = p.evaluate("window.__apk")[0]
    assert built["name"] == "Chai Counter" and "Chai Counter" in built["html"] and 'name="viewport"' in built["html"]
    dlg.get_by_role("button", name="Install").click()
    expect(dlg).to_contain_text("is installed", timeout=5_000)
    dlg.get_by_role("button", name="Open app").click()
    assert [x["ev"] for x in p.evaluate("window.__apk")] == ["build", "install", "open"]
    assert not errors, errors


def test_convert_an_attached_html_file(browser, tmp_path):
    ai = FakeAI("ok")
    p, errors = open_app(browser, ai, BRIDGE)
    f = tmp_path / "counter.html"
    f.write_text(PAGE)
    p.locator("form.composer input[type=file]").set_input_files(str(f))
    p.locator("#composer-input").fill("convert this html to apk")
    expect(p.get_by_role("button", name="Send message")).to_be_enabled(timeout=5_000)
    p.locator("#composer-input").press("Enter")
    dlg = p.get_by_role("dialog", name="Make an Android app")
    expect(dlg).to_be_visible()
    expect(dlg.get_by_label("App name")).to_have_value("Chai Counter")
    dlg.get_by_label("App name").fill("My Counter")
    dlg.get_by_role("button", name="Make app").click()
    expect(dlg).to_contain_text("My Counter is ready", timeout=5_000)
    assert not ai.requests, "the page goes to the app maker, not to the AI"
    assert not errors, errors


def test_outside_the_android_app_it_says_where_it_works(browser):
    ai = FakeAI("```html\n" + PAGE + "\n```")
    p, errors = open_app(browser, ai)
    p.locator("#composer-input").fill("make an app")
    p.locator("#composer-input").press("Enter")
    wait_reply(p, 1)
    p.get_by_role("button", name="Make an Android app from this page").click()
    dlg = p.get_by_role("dialog", name="Make an Android app")
    expect(dlg.get_by_role("alert")).to_contain_text("zenvqo Android app")
    expect(dlg.get_by_role("button", name="Make app")).to_be_disabled()
    assert not errors, errors


def test_plus_menu_in_the_message_box(browser):
    ai = FakeAI("ok")
    p, errors = open_app(browser, ai)
    plus = p.get_by_role("button", name="Add photos, files and more")
    expect(p.get_by_role("button", name="Start voice conversation")).to_be_visible()          # the mic stays outside
    expect(p.get_by_role("menu")).to_be_hidden()
    plus.click()
    menu = p.get_by_role("menu", name="Add to your message")
    expect(menu).to_be_visible()
    names = [x.strip().split("\n")[0] for x in menu.get_by_role("menuitem").all_inner_texts()]
    assert names[:2] == ["Camera", "Photos & files"], names
    expect(menu.get_by_role("menuitem").first).to_be_focused()
    p.keyboard.press("ArrowDown")
    expect(menu.get_by_role("menuitem", name="Attach files")).to_be_focused()
    p.keyboard.press("Escape")
    expect(menu).to_be_hidden()
    expect(plus).to_be_focused()
    plus.click()
    p.get_by_role("menuitem", name="Create image").click()
    expect(p.locator(".mode-chip")).to_contain_text("Image")
    expect(p.locator("#composer-input")).to_have_attribute("placeholder", "Describe the image to create…")
    p.get_by_role("button", name="Cancel image mode").click()
    expect(p.locator(".mode-chip")).to_have_count(0)
    plus.click()
    p.mouse.click(5, 5)                                                                          # tapping elsewhere closes it
    expect(p.get_by_role("menu")).to_be_hidden()
    assert not errors, errors
