"""On the emulator: make a Google Play package from a web page inside zenvqo (window.ZenvqoPlay), pull the .zip from
Downloads/zenvqo and check it: the .aab is signed, has the page and the right manifest, and the store pictures and
screenshots are real pictures of the right sizes. Usage: python play_on_phone.py OUT_DIR"""
import io
import json
import subprocess
import time
import zipfile

from pdf_on_phone import OUT, Page, adb, page_socket

PAGE = """<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Play Check</title>
<style>body{font:20px sans-serif;margin:0;background:#fff7e6;color:#3b2200}header{background:#c0560a;color:#fff;padding:40px 24px}
section{padding:24px;min-height:900px;border-bottom:4px solid #c0560a}</style></head>
<body><header><h1>Play Check</h1><p>Made into a Google Play package on the phone.</p></header>
<section><h2>First part</h2><p>Lots of text here.</p></section><section><h2>Second part</h2></section></body></html>"""


def png_size(b):
    return int.from_bytes(b[16:20], "big"), int.from_bytes(b[20:24], "big")


def jpeg_size(b):
    i = 2
    while i < len(b):
        if b[i] != 0xFF:
            i += 1
            continue
        marker, length = b[i + 1], int.from_bytes(b[i + 2:i + 4], "big")
        if marker in (0xC0, 0xC1, 0xC2):
            return int.from_bytes(b[i + 7:i + 9], "big"), int.from_bytes(b[i + 5:i + 7], "big")
        i += 2 + length
    return 0, 0


def main():
    page = Page(page_socket())
    page.wait('!!document.querySelector("#composer-input")', 60, "the chat box")
    adb("shell", "rm", "-f", "/sdcard/Download/zenvqo/Play-Check-Google-Play.zip", check=False)
    args = {"html": PAGE, "name": "Play Check", "pkg": "com.zenvqo.playcheck", "versionCode": 3, "versionName": "1.2", "icon": "",
            "folder": "Play Check", "files": {"listing.txt": "listing", "HOW-TO-PUBLISH.txt": "guide"}}
    page.js(f"""(() => {{ window.__playcheck = null;
      window.__zplay = (id, ev, data) => {{ if (ev !== 'step') window.__playcheck = {{ev, data}}; }};
      window.ZenvqoPlay.make('check1', {json.dumps(json.dumps(args))}); }})()""")
    page.wait("!!window.__playcheck", 120, "the Google Play package")
    r = page.js("window.__playcheck")
    print("  result:", r)
    assert r["ev"] == "done", r
    info = json.loads(r["data"])
    assert info["saved"] == "Downloads/zenvqo/Play-Check-Google-Play.zip", info
    local = f"{OUT}/Play-Check-Google-Play.zip"
    for _ in range(10):
        if subprocess.run(["adb", "pull", "/sdcard/Download/zenvqo/Play-Check-Google-Play.zip", local], capture_output=True).returncode == 0:
            break
        time.sleep(1)
    z = zipfile.ZipFile(local)
    names = z.namelist()
    print("  folder:", names)
    base = "Play-Check-Google-Play/"
    for need in ["Play-Check.aab", "store-listing/app-icon-512.png", "store-listing/feature-graphic-1024x500.jpg", "listing.txt",
                 "HOW-TO-PUBLISH.txt", "upload-key-KEEP-PRIVATE/upload-key.p12", "upload-key-KEEP-PRIVATE/upload_certificate.pem",
                 "upload-key-KEEP-PRIVATE/README.txt"]:
        assert base + need in names, need
    assert png_size(z.read(base + "store-listing/app-icon-512.png")) == (512, 512)
    assert jpeg_size(z.read(base + "store-listing/feature-graphic-1024x500.jpg")) == (1024, 500)
    shots = [n for n in names if "phone-screenshot" in n]
    print(f"  {len(shots)} screenshot(s)")
    for s in shots:
        assert jpeg_size(z.read(s)) == (1080, 1920), s
        open(f"{OUT}/{s.rsplit('/', 1)[1]}", "wb").write(z.read(s))
    assert len(shots) == 2, "expected two screenshots (top, and further down the long page)"
    aab = zipfile.ZipFile(io.BytesIO(z.read(base + "Play-Check.aab")))
    assert "META-INF/UPLOAD.RSA" in aab.namelist() and b"Play Check" in aab.read("base/assets/index.html")
    open(f"{OUT}/Play-Check.aab", "wb").write(z.read(base + "Play-Check.aab"))
    readme = z.read(base + "upload-key-KEEP-PRIVATE/README.txt").decode()
    assert "Key alias:       upload" in readme and "SHA-256:" in readme
    # a second package of the same app is signed with the same key
    page.js(f"""(() => {{ window.__playcheck = null; window.ZenvqoPlay.make('check2', {json.dumps(json.dumps({**args, "versionCode": 4}))}); }})()""")
    page.wait("!!window.__playcheck", 120, "the second Google Play package")
    again = json.loads(page.js("window.__playcheck")["data"])
    assert again["newKey"] is False and again["sha256"] == info["sha256"], again
    print("OK: Google Play package made on the phone, with screenshots, pictures and the same key for updates")


if __name__ == "__main__":
    main()
