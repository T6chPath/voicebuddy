"""On the emulator: turn a web page into an Android app inside zenvqo, install it with Android's own installer, open it
and check the page (with its JavaScript) runs as an app.

Run after the other phone checks (the app is open). Usage: python apps_on_phone.py OUT_DIR
"""
import base64
import json
import re
import subprocess
import time

from pdf_on_phone import OUT, PKG, Page, adb, ask, page_socket

NEW_PKG_PREFIX = "app.zenvqo.web.phonecheck"
PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><title>Phone Check</title>
<style>body{font:20px sans-serif;margin:40px;background:#f4f7f6;color:#0f2623}</style></head>
<body><h1 id="t">Waiting for JavaScript</h1>
<script>document.getElementById('t').textContent = 'Made on the phone ' + (6 * 7);</script></body></html>"""


def shot(name):
    subprocess.run(f"adb exec-out screencap -p > {OUT}/{name}.png", shell=True)


def ui():
    adb("shell", "uiautomator", "dump", "/sdcard/ui.xml", check=False)
    return adb("shell", "cat", "/sdcard/ui.xml", check=False)


def tap(labels, timeout=40):
    """Taps the first on-screen button whose text is one of labels (system screens, e.g. the package installer)."""
    end, xml = time.time() + timeout, ""
    while time.time() < end:
        xml = ui()
        for lab in labels:
            m = re.search(r'text="' + re.escape(lab) + r'"[^>]*?bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', xml, re.I)
            if m:
                x, y = (int(m[1]) + int(m[3])) // 2, (int(m[2]) + int(m[4])) // 2
                adb("shell", "input", "tap", str(x), str(y))
                return lab
        time.sleep(1.5)
    texts = re.findall(r'text="([^"]+)"', xml)[:30]
    raise SystemExit(f"no button {labels} on screen; texts: {texts}")


def click(page, label):
    page.js(f"[...document.querySelectorAll('dialog button')].find(b => b.textContent.trim().startsWith({json.dumps(label)})).click()")


def main():
    page = Page(page_socket())
    page.wait('!!document.querySelector("#composer-input")', 60, "the chat box")
    for p in adb("shell", "pm", "list", "packages", NEW_PKG_PREFIX, check=False).split():
        adb("shell", "pm", "uninstall", p.replace("package:", ""), check=False)
    # let zenvqo install apps without the one-time settings screen (a person allows it once on a real phone)
    adb("shell", "appops", "set", PKG, "REQUEST_INSTALL_PACKAGES", "allow", check=False)

    data = base64.b64encode(PAGE.encode()).decode()
    page.js(f"""(() => {{
      const bytes = Uint8Array.from(atob("{data}"), c => c.charCodeAt(0));
      const dt = new DataTransfer(); dt.items.add(new File([bytes], "phone-check.html", {{ type: "text/html" }}));
      const input = document.querySelector("form.composer input[type=file]"); input.files = dt.files;
      input.dispatchEvent(new Event("change", {{ bubbles: true }}));
    }})()""")
    page.wait('(() => { const c = document.querySelector(".att-list.pending .chip"); return c && !c.querySelector("progress"); })()', 30, "the page to attach")
    ask(page, "convert this html to apk")
    page.wait('!!document.querySelector("dialog .make-app")', 20, "the Make app dialog")
    name = page.js('document.querySelector("dialog .make-app input").value')
    print("  app name from the page:", name)
    assert name == "Phone Check", name
    t0 = time.time()
    click(page, "Make app")
    page.wait('(() => { const d = document.querySelector("dialog .make-app"); return d && (d.innerText.includes("is ready") || d.querySelector(".form-error")); })()', 120, "the app to be made")
    text = page.js('document.querySelector("dialog .make-app").innerText')
    print(f"  made in {time.time() - t0:.1f}s:", text.replace("\n", " | ")[:200])
    shot("make-app-ready")
    assert "is ready" in text, text
    listing = adb("shell", "ls", "-l", "/sdcard/Download/zenvqo/", check=False)
    print("  Downloads/zenvqo:", [l for l in listing.splitlines() if l.endswith(".apk")])

    click(page, "Install")
    pressed = tap(["Install", "INSTALL", "Update", "UPDATE"])
    print("  system installer: tapped", pressed)
    shot("make-app-installer")
    page.wait('(() => { const d = document.querySelector("dialog .make-app"); return d && (d.innerText.includes("is installed") || d.querySelector(".form-error")); })()', 90, "Android to install it")
    text = page.js('document.querySelector("dialog .make-app").innerText')
    assert "is installed" in text, text
    pkgs = [p.replace("package:", "") for p in adb("shell", "pm", "list", "packages", NEW_PKG_PREFIX).split()]
    print("  installed:", pkgs)
    assert pkgs, "the new app isn't installed"
    dump = adb("shell", "dumpsys", "package", pkgs[0], check=False)
    print("  ", " ".join(l.strip() for l in dump.splitlines() if re.search(r"versionName|targetSdk|signatures|apkSigningVersion", l))[:300])

    click(page, "Open app")
    end, xml = time.time() + 40, ""
    while time.time() < end:
        xml = ui()
        if "Made on the phone 42" in xml:
            break
        time.sleep(1.5)
    shot("made-app-running")
    top = adb("shell", "dumpsys", "activity", "activities", check=False)
    resumed = re.findall(r"(?:mResumedActivity|topResumedActivity)[^\n]*", top)[:2]
    print("  now showing:", resumed)
    assert "Made on the phone 42" in xml, "the made app didn't show its page (JavaScript ran: 'Made on the phone 42')"
    print("OK: a web page became an installed Android app that runs on this phone")
    adb("shell", "am", "start", "-W", "-n", f"{PKG}/app.zenvqo.chat.MainActivity", check=False)


if __name__ == "__main__":
    main()
