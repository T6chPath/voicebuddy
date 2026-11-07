"""Math rendering (KaTeX) in the real browser: standalone app (as in the APK) and the server app, desktop and phone."""
from pathlib import Path

from playwright.sync_api import expect

ROOT = Path(__file__).resolve().parents[1]
SHOTS = Path(__file__).parent / "screenshots"
HTML = ROOT / "frontend" / "dist-standalone" / "zenvqo-chat.html"


def ask(p, text):
    box = p.get_by_label("Message", exact=True)
    box.fill(text)
    box.press("Enter")
    reply = p.locator("article.msg-assistant").last
    expect(reply).to_have_attribute("aria-busy", "false", timeout=15_000)
    return reply


def check_math(p, reply):
    expect(reply.locator(".math-display")).to_have_count(2)
    expect(reply.locator(".math-inline .katex")).to_have_count(2)
    expect(reply.locator(".katex-error")).to_have_count(0)
    assert reply.locator(".math-display annotation").first.text_content().startswith("x = \\frac{-b")   # MathML for screen readers
    assert "$" not in reply.locator(".msg-body").inner_text().replace("$$", "")                          # no raw LaTeX left
    p.evaluate("document.fonts.ready")
    assert p.evaluate("document.fonts.check('20px KaTeX_Main') && document.fonts.check('italic 20px KaTeX_Math')")
    box = reply.locator(".math-display .katex-html").first.bounding_box()
    assert box and box["height"] > 40                                                                # stacked fraction, not one text line


def test_standalone_math_desktop_and_copy(browser):
    ctx = browser.new_context(viewport={"width": 1100, "height": 900})
    ctx.grant_permissions(["clipboard-read", "clipboard-write"])
    p = ctx.new_page()
    errors = []
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.goto(HTML.as_uri())
    reply = ask(p, "show me math equations")
    check_math(p, reply)
    reply.locator(".math-display").first.hover()
    reply.get_by_role("button", name="Copy LaTeX").first.click()
    expect(reply.get_by_role("button", name="Copied")).to_be_visible()
    p.screenshot(path=str(SHOTS / "math-desktop.png"))
    assert errors == []
    ctx.close()


def test_standalone_math_phone_dark(browser):
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, color_scheme="dark")
    p = ctx.new_page()
    p.goto(HTML.as_uri())
    reply = ask(p, "Write the quadratic formula and Euler's identity: ganit with a long equation $$\\sum_{k=0}^{n} \\binom{n}{k} a^{k} b^{n-k} = (a+b)^n \\quad \\text{for all } n \\ge 0 \\text{ and every pair of real numbers } a, b$$")
    expect(reply.locator(".math-display")).to_have_count(2)
    assert p.evaluate("document.documentElement.scrollWidth - window.innerWidth") <= 0                # long math scrolls inside its box
    color = p.evaluate("getComputedStyle(document.querySelector('.math-display .katex')).color")
    assert color != "rgb(0, 0, 0)"                                                                    # readable in dark mode
    p.screenshot(path=str(SHOTS / "math-phone-dark.png"))
    ctx.close()


def test_server_app_renders_math(page, server):
    page.goto("/")
    page.get_by_role("button", name="Create an account").click()
    page.get_by_label("Name").fill("Asha")
    page.get_by_label("Email").fill("math@example.com")
    page.get_by_label("Password").fill("correct horse battery")
    page.get_by_role("button", name="Create account").click()
    expect(page.get_by_role("heading", name="How can I help?")).to_be_visible()
    reply = ask(page, "explain an equation for me")
    check_math(page, reply)
    assert page.errors == []
