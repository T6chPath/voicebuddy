"""'Google Play package': a web page (or an APK made from one) → a folder for Google Play Console, in the phone app build,
with a stand-in for the Android side (window.ZenvqoPlay). The real bundle maker (PlayBundle) is checked in CI with
bundletool, jarsigner and aapt2."""
import io
import json
import re
import zipfile

from playwright.sync_api import expect

from test_camera_pdf_read import FakeAI, open_app, wait_reply

PAGE = """<!doctype html>
<html><head><title>Chai Shop</title><meta name="description" content="Order fresh masala chai and snacks from your phone."></head>
<body><h1>Chai Shop</h1><h2>Masala chai</h2><h2>Fresh snacks</h2><p>Brewed every morning with ginger and cardamom.</p>
<script>localStorage.setItem('cart','[]')</script></body></html>"""

BRIDGE = """
window.__play = []; window.__keys = {};
window.ZenvqoPlay = {
  status() { return JSON.stringify({ready: true, downloads: true}); },
  hasKey(pkg) { return !!window.__keys[pkg]; },
  make(id, json) {
    const a = JSON.parse(json);
    window.__play.push(a);
    setTimeout(() => window.__zplay(id, 'step', 'Taking screenshots…'), 100);
    setTimeout(() => {
      const isNew = !window.__keys[a.pkg]; window.__keys[a.pkg] = 1;
      window.__zplay(id, 'done', JSON.stringify({saved: 'Downloads/zenvqo/' + a.folder + '-Google-Play.zip', size: 2345678, aab: 1234567,
        aabName: a.folder + '.aab', folder: a.folder + '-Google-Play', pkg: a.pkg, versionCode: a.versionCode, versionName: a.versionName,
        shots: 2, newKey: isNew, sha256: 'AB:CD'}));
    }, 600);
  },
  share(id) { window.__play.push({share: id}); },
};
window.ZenvqoApk = { status() { return JSON.stringify({ready: true}); }, build() {}, install() {}, open() {}, share() {}, installed() { return false; } };
"""

LISTING = {"short": "Fresh masala chai and snacks, ordered in seconds", "full": "Chai Shop brings your neighbourhood tea stall to your phone.\n\n• Masala chai\n• Fresh snacks"}


class PlayAI(FakeAI):
    """Streams chat replies; answers the one-off listing request (stream: false) with JSON."""

    def handle(self, route):
        req = route.request
        if req.method == "POST" and not req.url.endswith("/models") and json.loads(req.post_data).get("stream") is False:
            self.requests.append(json.loads(req.post_data))
            body = {"choices": [{"message": {"content": json.dumps(LISTING)}}]}
            return route.fulfill(status=200, headers={"access-control-allow-origin": "*"}, content_type="application/json", body=json.dumps(body))
        return super().handle(route)


def open_play_from_reply(p):
    p.locator("#composer-input").fill("make a chai shop app and put it on the play store")
    p.locator("#composer-input").press("Enter")
    wait_reply(p, 1)
    p.locator("article.msg-assistant").last.get_by_role("button", name="Make an Android app from this page").click()
    p.get_by_role("dialog", name="Make an Android app").get_by_role("button", name=re.compile("^Google Play package")).click()
    dlg = p.get_by_role("dialog", name=re.compile("^Google Play package"))
    expect(dlg).to_be_visible()
    return dlg


def test_web_page_to_google_play_package(browser):
    ai = PlayAI("Here is your app:\n\n```html\n" + PAGE + "\n```\n\nTap **Make app**, then **Google Play**.")
    p, errors = open_app(browser, ai, BRIDGE)
    dlg = open_play_from_reply(p)
    system = ai.requests[0]["messages"][0]["content"]
    assert "Google Play package" in system and "12 testers" in system
    expect(dlg.get_by_label("App name")).to_have_value("Chai Shop")
    expect(dlg.get_by_label("Package name")).to_have_value("com.chaishop.app")
    expect(dlg.get_by_label("Version code")).to_have_value("1")
    expect(dlg.get_by_label("Short description")).to_have_value("Order fresh masala chai and snacks from your phone.")
    expect(dlg.get_by_label("Full description")).to_have_value(re.compile("• Masala chai"))
    # package name rules
    dlg.get_by_label("Package name").fill("com.example.chai")
    expect(dlg).to_contain_text("doesn't accept com.example")
    expect(dlg.get_by_role("button", name="Make package")).to_be_disabled()
    dlg.get_by_label("Package name").fill("com.chaishop.app")
    # the AI writes the listing
    dlg.get_by_role("button", name="Write with AI").click()
    expect(dlg.get_by_label("Short description")).to_have_value(LISTING["short"])
    expect(dlg).to_contain_text("Written by your AI")
    assert "Google Play Store listing" in ai.requests[-1]["messages"][0]["content"]
    dlg.get_by_label("Your email").fill("owner@chaishop.test")
    dlg.get_by_role("button", name="Make package").click()
    expect(dlg).to_contain_text("is ready for Google Play", timeout=5_000)
    expect(dlg).to_contain_text("Downloads/zenvqo/Chai-Shop-Google-Play.zip")
    expect(dlg).to_contain_text("Chai-Shop.aab")
    expect(dlg).to_contain_text("12 testers for 14 days")
    sent = p.evaluate("window.__play")[0]
    assert sent["pkg"] == "com.chaishop.app" and sent["versionCode"] == 1 and sent["versionName"] == "1.0" and sent["name"] == "Chai Shop"
    assert "<h1>Chai Shop</h1>" in sent["html"] and 'name="viewport"' in sent["html"]
    files = sent["files"]
    assert set(files) == {"listing.txt", "privacy-policy.html", "data-safety.txt", "HOW-TO-PUBLISH.txt"}
    assert LISTING["short"] in files["listing.txt"] and "owner@chaishop.test" in files["listing.txt"]
    assert "mailto:owner@chaishop.test" in files["privacy-policy.html"] and "stored only on your device" in files["privacy-policy.html"]
    assert "No. The app keeps everything on the device" in files["data-safety.txt"]
    assert "Chai-Shop.aab" in files["HOW-TO-PUBLISH.txt"] and "STEP BY STEP" in files["HOW-TO-PUBLISH.txt"]
    dlg.get_by_role("button", name="Share").click()
    assert p.evaluate("window.__play")[-1].get("share")
    dlg.get_by_role("button", name="Done").click()
    # the next package for the same app is an update: version 2, same key
    p.locator("article.msg-assistant").last.get_by_role("button", name="Make an Android app from this page").click()
    p.get_by_role("dialog", name="Make an Android app").get_by_role("button", name=re.compile("^Google Play package")).click()
    dlg = p.get_by_role("dialog", name=re.compile("^Google Play package"))
    expect(dlg.get_by_label("Version code")).to_have_value("2")
    expect(dlg.get_by_label("Version name")).to_have_value("1.1")
    expect(dlg).to_contain_text("this will be an update")
    dlg.get_by_role("button", name="Make package").click()
    expect(dlg).to_contain_text("same as before", timeout=5_000)
    second = p.evaluate("window.__play")[-1]
    assert second["versionCode"] == 2 and "THIS IS AN UPDATE" in second["files"]["HOW-TO-PUBLISH.txt"]
    assert not errors, errors


def apk(files):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as z:
        for name, data in files.items():
            z.writestr(name, data)
    return b.getvalue()


def test_attached_apk_to_google_play_package(browser, tmp_path):
    ai = PlayAI("ok")
    p, errors = open_app(browser, ai, BRIDGE)
    made = tmp_path / "Chai-Shop.apk"
    made.write_bytes(apk({"AndroidManifest.xml": b"\x03\x00", "classes.dex": b"dex", "assets/index.html": PAGE,
                          "res/mipmap-xxxhdpi-v4/ic_launcher.png": b"\x89PNG fake icon"}))
    p.locator("form.composer input[type=file]").set_input_files(str(made))
    p.locator("#composer-input").fill("put this app on google play")
    expect(p.get_by_role("button", name="Send message")).to_be_enabled(timeout=10_000)
    p.locator("#composer-input").press("Enter")
    wait_reply(p, 1)
    # the AI was told it's a web app that can become a Play package
    assert "Google Play" in json.dumps(ai.requests[-1]["messages"][-1])
    p.get_by_role("button", name="Make a Google Play package from Chai-Shop.apk").click()
    dlg = p.get_by_role("dialog", name=re.compile("^Google Play package"))
    expect(dlg.get_by_label("App name")).to_have_value("Chai Shop")
    expect(dlg.locator(".app-icon")).to_have_attribute("style", re.compile(r"data:image/png;base64"))
    dlg.get_by_role("button", name="Make package").click()
    expect(dlg).to_contain_text("is ready for Google Play", timeout=5_000)
    assert "<h1>Chai Shop</h1>" in p.evaluate("window.__play")[0]["html"]

    # an APK that isn't made from a web page: explained, nothing made
    dlg.get_by_role("button", name="Done").click()
    other = tmp_path / "game.apk"
    other.write_bytes(apk({"AndroidManifest.xml": b"\x03\x00", "classes.dex": b"dex", "lib/arm64-v8a/libgame.so": b"\x7fELF"}))
    p.locator("form.composer input[type=file]").set_input_files(str(other))
    expect(p.get_by_role("button", name="Send message")).to_be_enabled(timeout=10_000)
    p.locator("#composer-input").press("Enter")
    wait_reply(p, 2)
    p.get_by_role("button", name="Make a Google Play package from game.apk").click()
    err = p.get_by_role("dialog", name=re.compile("^Google Play package"))
    expect(err).to_contain_text("isn't an app made from a web page")
    expect(err).to_contain_text("Generate Signed App Bundle")
    assert not errors, errors
