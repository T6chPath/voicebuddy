"""Drives the real Android app on an emulator: asks for PDFs in the chat and checks the files land in Downloads/zenvqo.

The debug APK enables WebView debugging, so the page is controlled over the DevTools protocol (typing and Enter are
real input events). Usage: python pdf_on_phone.py OUT_DIR
"""
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import websocket

PKG = "app.zenvqo.chat.debug"
OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "phone-out")
OUT.mkdir(parents=True, exist_ok=True)


def adb(*a, check=True):
    return subprocess.run(["adb", *a], capture_output=True, text=True, check=check).stdout


def page_socket():
    pid = ""
    for _ in range(60):
        pid = adb("shell", "pidof", PKG, check=False).strip()
        if pid:
            break
        time.sleep(1)
    assert pid, "the app didn't start"
    adb("forward", "tcp:9222", f"localabstract:webview_devtools_remote_{pid.split()[0]}")
    for _ in range(60):
        try:
            pages = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json", timeout=5))
            main = [p for p in pages if p.get("type") == "page" and "index.html" in p.get("url", "")]
            if main:
                return websocket.create_connection(main[0]["webSocketDebuggerUrl"], timeout=120, suppress_origin=True)
        except Exception as e:  # not up yet
            last = e
        time.sleep(1)
    raise SystemExit(f"no debuggable page: {last!r}")


class Page:
    def __init__(self, ws):
        self.ws, self.n = ws, 0

    def call(self, method, **params):
        self.n += 1
        self.ws.send(json.dumps({"id": self.n, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.n:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg.get("result", {})

    def js(self, expr):
        r = self.call("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        if "exceptionDetails" in r:
            raise RuntimeError(r["exceptionDetails"])
        return r["result"].get("value")

    def wait(self, expr, timeout, what):
        end = time.time() + timeout
        while time.time() < end:
            v = self.js(expr)
            if v:
                return v
            time.sleep(0.5)
        raise SystemExit(f"timed out waiting for {what}")


def ask(page, text):
    page.js('document.querySelector("[aria-label=\\"Message\\"]").focus()')
    page.call("Input.insertText", text=text)
    for t in ("rawKeyDown", "char", "keyUp"):
        extra = {"text": "\r"} if t == "char" else {}
        page.call("Input.dispatchKeyEvent", type=t, key="Enter", code="Enter", windowsVirtualKeyCode=13, **extra)


def main():
    page = Page(page_socket())
    page.wait('!!document.querySelector("[aria-label=\\"Message\\"]")', 60, "the chat box")
    adb("shell", "rm", "-rf", "/sdcard/Download/zenvqo", check=False)
    results = []
    for n, (prompt, expect) in enumerate([("generate pdf of 30 quiz questions", "What is the SI unit of force"),
                                          ("make a pdf of a paragraph on AI", "Artificial intelligence")], 1):
        ask(page, prompt)
        t0 = time.time()
        page.wait(f'document.querySelectorAll(".pdf-card").length >= {n}', 20, "the PDF card")
        last = None
        status = None
        while time.time() - t0 < 120:
            info = page.js(f'(() => {{ const c = document.querySelectorAll(".pdf-card")[{n - 1}]; return c && [c.className, c.innerText]; }})()')
            if info != last:
                print(f"  [{time.time() - t0:5.1f}s] {info}", flush=True)
                last = info
            if info and ("saved" in info[0].split() or "error" in info[0].split() or "ready" in info[0].split()):
                status = info
                break
            time.sleep(0.3)
        subprocess.run(f"adb exec-out screencap -p > {OUT}/screen{n}.png", shell=True)
        assert status and "saved" in status[0].split(), f"PDF {n} not saved: {status}"
        print(f"PDF {n} saved in {time.time() - t0:.1f}s after sending")
        results.append(expect)
    listing = adb("shell", "ls", "-l", "/sdcard/Download/zenvqo/")
    print(listing)
    names = [l.split()[-1] for l in listing.splitlines() if l.endswith(".pdf")]
    assert len(names) == 2, names
    texts = []
    for name in names:
        adb("pull", f"/sdcard/Download/zenvqo/{name}", str(OUT / name))
        info = subprocess.run(["pdfinfo", str(OUT / name)], capture_output=True, text=True).stdout
        text = subprocess.run(["pdftotext", "-layout", str(OUT / name), "-"], capture_output=True, text=True).stdout
        pages = int(next(l.split()[-1] for l in info.splitlines() if l.startswith("Pages:")))
        print(f"{name}: {pages} page(s), {len(text)} chars of text")
        texts.append(text)
    joined = "\n".join(texts)
    for e in results:
        assert e in joined, f"{e!r} missing from the PDFs"
    print("OK: both PDFs were saved to Downloads/zenvqo and contain the expected text")


main()
