"""Pictures made by the phone itself, on a real Android (emulator): downloads the picture model through
Settings like a user would, switches to "Phone only", then makes a picture and changes it, with no online service.
Run after read_on_phone.py (the app is open). Usage: python pictures_on_phone.py OUT_DIR
Skips (exit 0) when this APK has no picture engine, unless ZC_REQUIRE_DEVICE_IMAGES=1."""
import json
import os
import subprocess
import sys
import time

from pdf_on_phone import OUT, Page, ask, page_socket


def shot(name):
    subprocess.run(f"adb exec-out screencap -p > {OUT}/{name}.png", shell=True)


def click_text(page, selector, text):
    return page.js(f"""(() => {{ const b = [...document.querySelectorAll({json.dumps(selector)})].find(e => e.textContent.trim() === {json.dumps(text)} && e.offsetParent);
      if (b) b.click(); return !!b; }})()""")


SHARE = """(async (test) => {
  const a = [...document.querySelectorAll("article.msg-assistant")].pop();
  const img = a.querySelector("img");
  if (!img) return JSON.stringify({ error: a.innerText });
  await img.decode().catch(() => {});
  const c = document.createElement("canvas"); c.width = 64; c.height = 64; const g = c.getContext("2d");
  g.drawImage(img, 0, 0, 64, 64); const d = g.getImageData(0, 0, 64, 64).data; let n = 0;
  for (let i = 0; i < d.length; i += 4) if (test(d[i], d[i + 1], d[i + 2])) n++;
  return JSON.stringify({ w: img.naturalWidth, h: img.naturalHeight, share: n / 4096, text: a.innerText.slice(0, 300) });
})(%s)"""


def wait_picture(page, n, what, timeout):
    t0, last = time.time(), ""
    while time.time() - t0 < timeout:
        state = page.js('(() => { const a = [...document.querySelectorAll("article.msg-assistant")]; const l = a[a.length - 1];'
                        f' if (a.length < {n} || !l) return "wait"; if (l.getAttribute("aria-busy") === "false") return "done";'
                        ' const p = l.querySelector(".tool-progress, [role=progressbar], progress"); return "busy:" + (l.innerText || "").slice(-90); })()')
        if state == "done":
            return time.time() - t0
        if state != last and state.startswith("busy"):
            print(f"  {int(time.time() - t0)} s {state[5:].strip()!r}", flush=True)
            last = state
        time.sleep(2)
    shot(f"{what}-timeout")
    raise SystemExit(f"timed out waiting for {what}")


def main():
    page = Page(page_socket())
    page.wait('!!document.querySelector("#composer-input")', 60, "the chat box")
    info = page.js("window.ZenvqoImageGen ? window.ZenvqoImageGen.info() : null")
    print("picture engine:", info, flush=True)
    if not info or not json.loads(info).get("engine"):
        msg = "this APK has no on-phone picture engine"
        if os.environ.get("ZC_REQUIRE_DEVICE_IMAGES") == "1":
            raise SystemExit(msg)
        print("SKIP:", msg)
        return

    # --- download the model in Settings, like a user ---
    page.js('document.querySelector("[aria-label=\\"Open conversations\\"]")?.click()')
    time.sleep(1)
    assert page.js('(() => { const b = [...document.querySelectorAll("[aria-label=\\"Settings\\"]")].find(e => e.offsetParent); if (b) b.click(); return !!b; })()'), "no Settings button"
    page.wait('!!document.querySelector("fieldset.device-pictures li button")', 20, "the pictures settings")
    page.js('document.querySelector("fieldset.device-pictures").scrollIntoView()')
    page.js('document.querySelector("fieldset.device-pictures li button").click()')
    t0, last = time.time(), -1
    while True:
        s = page.js('(() => { const li = document.querySelector("fieldset.device-pictures li"); const e = document.querySelector("fieldset.device-pictures .form-error");'
                    ' return JSON.stringify({ text: li.innerText, err: e ? e.innerText : null }); })()')
        s = json.loads(s)
        if s["err"]:
            shot("model-download-failed")
            raise SystemExit("download failed: " + s["err"])
        if "Downloaded" in s["text"]:
            break
        el = int(time.time() - t0)
        if el // 20 != last:
            last = el // 20
            print(f"  download {el} s: {s['text'].splitlines()[-1]}", flush=True)
        if el > 1500:
            raise SystemExit("the model download took too long")
        time.sleep(2)
    print(f"model downloaded in {time.time() - t0:.0f} s:", page.js("window.ZenvqoImageGen.info()"), flush=True)
    shot("device-model-downloaded")
    assert click_text(page, "label", "Phone only"), "no 'Phone only' choice"
    assert click_text(page, "button", "Save")
    page.wait('[...document.querySelectorAll(".saved")].some(e => e.textContent === "Saved")', 10, "settings saved")
    click_text(page, "button", "Close")
    time.sleep(1)

    # --- a new picture, made on the phone ---
    n = page.js('document.querySelectorAll("article.msg-assistant").length') + 1
    ask(page, "Generate an image of a red apple on a white plate, studio photo")
    secs = wait_picture(page, n, "phone-picture", 1200)
    r = json.loads(page.js(SHARE % "(r, g, b) => r > g + 50 && r > b + 50"))
    print(f"  made on the phone in {secs:.0f} s:", r, flush=True)
    shot("device-picture")
    assert "error" not in r, r
    assert r["w"] >= 448 and r["share"] > 0.02, r
    assert "online service" not in r["text"], r["text"]

    # --- change it: the picture itself is edited on the phone ---
    ask(page, "make the apple green")
    secs = wait_picture(page, n + 1, "phone-edit", 1200)
    g = json.loads(page.js(SHARE % "(r, g, b) => g > r + 25 && g > b + 25"))
    print(f"  changed on the phone in {secs:.0f} s:", g, flush=True)
    shot("device-edit")
    assert "error" not in g and g["share"] > 0.03, g
    assert "Changed on your phone" in g["text"], g["text"]


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    main()
    sys.exit(0)
