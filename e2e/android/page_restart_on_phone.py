"""The page's own process is stopped, as Android does when the phone needs memory (making a picture on the phone uses a
lot): the app opens its page again by itself instead of closing. Usage: python page_restart_on_phone.py OUT_DIR"""
import subprocess
import sys
import time

from pdf_on_phone import OUT, PKG, Page, adb, page_socket


def main():
    page = Page(page_socket())
    page.wait('!!document.querySelector("#composer-input")', 60, "the chat box")
    before = adb("shell", "pidof", PKG, check=False).strip()
    adb("root", check=False)                                   # the page's process belongs to another user
    adb("wait-for-device", check=False)
    time.sleep(3)
    procs = adb("shell", "ps -A -o PID,NAME", check=False).splitlines()
    pages = [line.split()[0] for line in procs if "sandboxed_process" in line]
    print("page processes:", pages, flush=True)
    if not pages:
        print("SKIP: no page process found")
        return
    for pid in pages:
        adb("shell", "kill", "-9", pid, check=False)
    time.sleep(8)
    after = adb("shell", "pidof", PKG, check=False).strip()
    print("app process before / after:", before, "/", after, flush=True)
    subprocess.run(f"adb exec-out screencap -p > {OUT}/page-restarted.png", shell=True)
    assert after and after == before, "the app was closed when its page's process stopped"
    page = Page(page_socket())
    page.wait('!!document.querySelector("#composer-input")', 60, "the chat box after the page came back")
    print("OK: the page came back by itself", flush=True)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    main()
    sys.exit(0)
