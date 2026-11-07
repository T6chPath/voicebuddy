import itertools
import re
from pathlib import Path

from playwright.sync_api import expect

SHOTS = Path(__file__).resolve().parent / "screenshots"
_n = itertools.count()


def signup(page, name="Asha"):
    email = f"user{next(_n)}_{id(page)}@example.com"
    page.goto("/")
    page.get_by_role("button", name="Create an account").click()
    page.get_by_label("Name").fill(name)
    page.get_by_label("Email").fill(email)
    page.get_by_label("Password").fill("correct horse battery")
    page.get_by_role("button", name="Create account").click()
    expect(page.get_by_role("heading", name="How can I help?")).to_be_visible()
    return email


def send(page, text):
    page._assistant_before = page.locator("article.msg-assistant").count()
    box = page.get_by_label("Message", exact=True)
    box.fill(text)
    box.press("Enter")


def wait_reply_done(page, new=True):
    """A new assistant message exists and has finished streaming (complete, stopped or error)."""
    msgs = page.locator("article.msg-assistant")
    if new:
        expect(msgs).to_have_count(page._assistant_before + 1, timeout=15000)
    expect(msgs.last).to_have_attribute("aria-busy", "false", timeout=15000)
    expect(page.get_by_role("button", name="Send message")).to_be_visible()


def test_auth_flow_and_errors(page):
    page.goto("/")
    expect(page.get_by_role("heading", name="Sign in to zenvqo")).to_be_visible()
    page.get_by_label("Email").fill("nobody@example.com")
    page.get_by_label("Password").fill("wrong-password")
    page.get_by_role("button", name="Sign in").click()
    expect(page.locator(".form-error")).to_contain_text("Email or password is incorrect")
    email = signup(page)
    page.get_by_role("button", name="Sign out").click()
    expect(page.get_by_role("heading", name="Sign in to zenvqo")).to_be_visible()
    page.get_by_label("Email").fill(email)
    page.get_by_label("Password").fill("correct horse battery")
    page.get_by_role("button", name="Sign in").click()
    expect(page.get_by_role("heading", name="How can I help?")).to_be_visible()
    assert page.errors == []


def test_streaming_markdown_code_table_and_persistence(page):
    signup(page)
    send(page, "Show me some code and a table")
    expect(page.get_by_role("button", name="Stop generating")).to_be_visible()      # streaming state
    wait_reply_done(page)
    reply = page.locator("article.msg-assistant").last
    expect(reply.locator(".code-block .code-lang")).to_have_text("python")
    expect(reply.locator(".code-block .hljs-keyword").first).to_be_visible()        # syntax highlighted
    expect(reply.locator("table th").first).to_have_text("Model")
    expect(reply.locator("strong")).to_contain_text("Show me some code and a table")
    expect(page.locator("nav .conv-title").first).to_have_text("Show me some code and a table")   # auto title
    assert re.search(r"/c/cnv_[0-9a-f]+$", page.url)
    reply.get_by_role("button", name="Copy python code").click()
    expect(reply.get_by_role("button", name="Copy python code")).to_have_text("Copied")
    assert "def greet" in page.evaluate("navigator.clipboard.readText()")
    page.screenshot(path=str(SHOTS / "desktop-light.png"))
    page.reload()
    expect(page.locator("article.msg")).to_have_count(2)
    expect(page.locator("article.msg-assistant .code-block")).to_be_visible()
    assert page.errors == []


def test_stop_regenerate_and_error_states(page):
    signup(page)
    send(page, "Tell me a long story about mangoes and monsoon rain in Pune please")
    expect(page.locator("article.msg-assistant .md").last).to_contain_text("You said")
    page.get_by_label("Message", exact=True).press("Escape")                        # Esc stops
    expect(page.get_by_text("Stopped", exact=True)).to_be_visible()
    page.reload()
    expect(page.get_by_text("Stopped", exact=True)).to_be_visible()                              # partial reply was saved as stopped
    page.get_by_role("button", name="Regenerate reply").click()
    expect(page.locator("article.msg-assistant").last).to_have_attribute("aria-busy", "true")
    wait_reply_done(page, new=False)
    expect(page.get_by_text("Stopped", exact=True)).to_have_count(0)
    send(page, "this will [fail] for sure")
    alert = page.locator(".msg-error")
    expect(alert).to_contain_text("failed on purpose")
    expect(alert.get_by_role("button", name="Retry")).to_be_visible()
    page.get_by_label("Model").select_option("broken")
    send(page, "hello?")
    expect(page.locator(".msg-error").last).to_contain_text("Can't reach the model server")
    assert page.errors == []


def test_uploads(page, tmp_path):
    signup(page)
    f = tmp_path / "notes.txt"
    f.write_text("Buy mangoes on Friday\nsecond line")
    page.locator("input[type=file]").set_input_files(str(f))
    expect(page.locator(".att-list.pending .chip")).to_contain_text("notes.txt")
    expect(page.locator(".att-list.pending .chip")).to_contain_text("B")            # uploaded → size shown
    send(page, "summarise the file")
    wait_reply_done(page)
    expect(page.locator("article.msg-assistant").last).to_contain_text("Buy mangoes on Friday")
    expect(page.locator("article.msg-user .chip")).to_contain_text("notes.txt")
    bad = tmp_path / "tool.exe"
    bad.write_bytes(b"MZ\x90\x00binary")
    page.locator("input[type=file]").set_input_files(str(bad))
    expect(page.locator(".chip-error")).to_contain_text("Unsupported file type")
    expect(page.get_by_role("button", name="Send message")).to_be_disabled()
    page.get_by_role("button", name="Remove tool.exe").click()
    png = tmp_path / "pic.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\0" * 100)
    page.locator("input[type=file]").set_input_files(str(png))
    expect(page.locator(".att-list.pending .chip")).to_contain_text("pic.png")
    page.get_by_label("Message", exact=True).fill("what is in this image")
    expect(page.locator(".att-list.pending progress")).to_have_count(0)
    page.get_by_label("Message", exact=True).press("Enter")
    expect(page.locator(".toasts-errors")).to_contain_text("can't read images")
    expect(page.get_by_label("Message", exact=True)).to_have_value("what is in this image")   # draft kept
    page.get_by_label("Model").select_option("echo-vision")
    page._assistant_before = page.locator("article.msg-assistant").count()
    page.get_by_label("Message", exact=True).press("Enter")
    wait_reply_done(page)
    assert page.errors == []


def test_untrusted_markdown_is_sanitised(page):
    signup(page)
    send(page, 'x <img src=x onerror="alert(1)"> [click](javascript:alert(2)) <script>alert(3)</script>')
    wait_reply_done(page)
    page.wait_for_timeout(300)
    assert not any(e.startswith("dialog:") for e in page.errors), page.errors
    html = page.locator("article.msg-assistant .md").last.inner_html()
    assert "onerror" not in html and "javascript:" not in html and "<script" not in html


def test_conversation_management_and_search(page):
    signup(page)
    send(page, "first chat about mangoes")
    wait_reply_done(page)
    page.get_by_role("button", name="New chat").click()
    expect(page.get_by_role("heading", name="How can I help?")).to_be_visible()
    send(page, "second chat about trains")
    wait_reply_done(page)
    nav = page.get_by_role("navigation", name="Conversations")
    expect(nav.locator(".conv")).to_have_count(2)
    page.keyboard.press("Control+k")
    expect(page.get_by_label("Search conversations")).to_be_focused()
    page.keyboard.type("mango")
    expect(nav.locator(".conv")).to_have_count(1)
    page.get_by_label("Search conversations").fill("")
    expect(nav.locator(".conv")).to_have_count(2)
    nav.get_by_role("button", name=re.compile("Rename “second")).click()
    page.get_by_label("New title").fill("Train plans")
    page.get_by_label("New title").press("Enter")
    expect(nav.get_by_text("Train plans")).to_be_visible()
    print("SNAP", nav.aria_snapshot())
    nav.get_by_role("button", name=re.compile("^Pin “first")).click()
    expect(nav.locator("h2").first).to_have_text("Pinned")
    nav.get_by_role("button", name=re.compile("Delete “Train plans")).click()
    dialog = page.get_by_role("dialog", name="Delete conversation?")
    expect(dialog).to_be_visible()
    dialog.get_by_role("button", name="Delete").click()
    expect(nav.locator(".conv")).to_have_count(1)
    expect(page.locator(".toasts").first).to_contain_text("Deleted")
    page.goto("/c/cnv_doesnotexist")
    expect(page.get_by_text("doesn't exist or was deleted")).to_be_visible()
    assert page.errors == []


def test_settings_theme_temperature_and_keyboard(page):
    signup(page)
    page.get_by_role("button", name="Settings").click()
    dlg = page.get_by_role("dialog", name="Settings")
    expect(dlg).to_be_visible()
    dlg.get_by_text("Dark", exact=True).click()
    dlg.get_by_label(re.compile("Creativity")).fill("1.5")
    dlg.get_by_label("Custom instructions").fill("Answer briefly.")
    dlg.get_by_label(re.compile("Enter sends")).uncheck()
    dlg.get_by_role("button", name="Save").click()
    expect(dlg.get_by_text("Saved", exact=True)).to_be_visible()
    page.keyboard.press("Escape")
    expect(dlg).to_be_hidden()
    assert page.evaluate("document.documentElement.dataset.theme") == "dark"
    box = page.get_by_label("Message", exact=True)
    box.fill("line one")
    box.press("Enter")                                                              # Enter = newline now
    box.type("line two")
    assert box.input_value() == "line one\nline two"
    page._assistant_before = page.locator("article.msg-assistant").count()
    box.press("Control+Enter")
    wait_reply_done(page)
    expect(page.locator("article.msg-assistant").last).to_contain_text("temperature 1.5")
    page.reload()
    assert page.evaluate("document.documentElement.dataset.theme") == "dark"
    expect(page.locator("article.msg-assistant .md")).to_be_visible()
    page.screenshot(path=str(SHOTS / "desktop-dark.png"))
    assert page.errors == []


def test_accessibility_basics(page):
    signup(page)
    send(page, "code please")
    wait_reply_done(page)
    problems = page.evaluate("""() => {
      const out = [];
      const name = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').trim();
      document.querySelectorAll('button, a[href], [role=button]').forEach((el) => { if (el.offsetParent && !name(el)) out.push('unnamed ' + el.outerHTML.slice(0, 80)); });
      document.querySelectorAll('input:not([type=hidden]):not([type=file]), textarea, select').forEach((el) => {
        const labelled = el.labels?.length || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
        if (el.offsetParent && !labelled) out.push('unlabelled ' + el.outerHTML.slice(0, 80));
      });
      if (!document.documentElement.lang) out.push('no lang');
      if (!document.querySelector('main')) out.push('no main');
      if (!document.querySelector('nav')) out.push('no nav');
      if (!document.querySelector('[role=log]')) out.push('no log region');
      return out;
    }""")
    assert problems == [], problems
    page.reload()
    expect(page.locator("article.msg")).to_have_count(2)
    page.keyboard.press("Tab")
    expect(page.get_by_role("link", name="Skip to message box")).to_be_focused()   # first tab stop
    page.keyboard.press("Enter")
    page.wait_for_timeout(100)
    expect(page.get_by_label("Message", exact=True)).to_be_focused()


def test_mobile_layout(mobile):
    signup(mobile)
    nav = mobile.get_by_role("navigation", name="Conversations")
    expect(nav).to_be_hidden()                                                       # drawer closed
    send(mobile, "Show me code and a table on my phone")
    wait_reply_done(mobile)
    overflow = mobile.evaluate("document.documentElement.scrollWidth - window.innerWidth")
    assert overflow <= 0, f"horizontal overflow {overflow}px"
    mobile.screenshot(path=str(SHOTS / "mobile-chat.png"))
    menu = mobile.get_by_role("button", name="Open conversations")
    menu.click()
    expect(nav).to_be_visible()
    expect(menu).to_have_attribute("aria-expanded", "true")
    mobile.wait_for_timeout(350)                                                    # slide-in transition
    mobile.screenshot(path=str(SHOTS / "mobile-drawer.png"))
    mobile.keyboard.press("Escape")
    expect(nav).to_be_hidden()
    box = mobile.get_by_label("Message", exact=True).bounding_box()
    assert box["y"] + box["height"] <= 844                                         # composer on screen
    for b in mobile.locator("button:visible").all():
        bb = b.bounding_box()
        if bb and b.get_attribute("class") and "code-copy" not in b.get_attribute("class"):
            assert bb["height"] >= 36, f"small touch target: {b.get_attribute('aria-label')}"
    assert mobile.errors == []
