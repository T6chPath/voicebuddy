"""On the emulator: share a photo (plus a caption) to zenvqo with Android's real share intent — what WhatsApp or
Gallery do — and check it arrives in a new chat's message box. Usage: python share_on_phone.py OUT_DIR"""
import re
import subprocess
import time
from pathlib import Path

from pdf_on_phone import OUT, PKG, Page, adb, page_socket

PHOTO = Path(__file__).resolve().parents[1] / "files" / "red.jpg"


def main():
    page = Page(page_socket())
    page.wait('!!document.querySelector("#composer-input")', 60, "the chat box")
    adb("push", str(PHOTO), "/sdcard/Pictures/zv-share.jpg")
    adb("shell", "content", "call", "--method", "scan_volume", "--uri", "content://media", "--arg", "external_primary", check=False)
    adb("shell", "am", "broadcast", "-a", "android.intent.action.MEDIA_SCANNER_SCAN_FILE", "-d", "file:///sdcard/Pictures/zv-share.jpg", check=False)
    uid = ""
    for _ in range(20):
        rows = adb("shell", "content", "query", "--uri", "content://media/external/images/media", "--projection", "_id:_display_name", check=False)
        m = re.search(r"_id=(\d+), _display_name=zv-share\.jpg", rows)
        if m:
            uid = m[1]
            break
        time.sleep(1)
    assert uid, "the test photo didn't reach the gallery"
    uri = f"content://media/external/images/media/{uid}"
    out = adb("shell", "am", "start", "-W", "-a", "android.intent.action.SEND", "-t", "image/jpeg", "--eu", "android.intent.extra.STREAM", uri,
              "--es", "android.intent.extra.TEXT", "Shared from the gallery", "--grant-read-uri-permission",
              "-n", f"{PKG}/app.zenvqo.chat.MainActivity", check=False)
    print("  share intent:", " ".join(out.split())[:160])
    try:
        page.wait('(() => { const c = document.querySelector(".att-list.pending .file-card"); return c && !document.querySelector(".att-list.pending progress"); })()', 40, "the shared photo in the message box")
    except SystemExit:
        log = subprocess.run(["adb", "logcat", "-d", "-s", "ZenvqoShare"], capture_output=True, text=True).stdout
        print("ZenvqoShare log:", log[-1500:])
        raise
    text = page.js('document.querySelector("#composer-input").value')
    cards = page.js('[...document.querySelectorAll(".att-list.pending .file-card")].length')
    subprocess.run(f"adb exec-out screencap -p > {OUT}/shared.png", shell=True)
    print(f"  arrived: {cards} file(s), text {text!r}")
    assert cards == 1 and text == "Shared from the gallery", (cards, text)
    print("OK: sharing a photo to zenvqo puts it in the message box")


if __name__ == "__main__":
    main()
