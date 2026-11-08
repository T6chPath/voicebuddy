"""Graphs in the chat: the offline demo plots what you ask; a model's ```plot block becomes an interactive 2D or 3D
graph; tracing, zoom, reset, PNG, parameter sliders; graphs become pictures in PDFs."""
import base64
import io
import json
import re
from pathlib import Path

from PIL import Image
from playwright.sync_api import expect

from test_camera_pdf_read import FakeAI, open_app, wait_reply

ROOT = Path(__file__).resolve().parents[1]
HTML = ROOT / "frontend" / "dist-standalone" / "zenvqo-chat.html"
SHOTS = Path(__file__).parent / "screenshots"
DEMO = "localStorage.setItem('zc.local.settings', JSON.stringify({default_model: 'echo'}));"


def canvas_png(p, locator) -> Image.Image:
    data = locator.evaluate("c => c.toDataURL('image/png')")
    return Image.open(io.BytesIO(base64.b64decode(data.split(",", 1)[1]))).convert("RGB")


def count_colour(img, rgb, tol=40):
    w, h = img.size
    return sum(1 for x in range(0, w, 2) for y in range(0, h, 2) if all(abs(a - b) <= tol for a, b in zip(img.getpixel((x, y)), rgb)))


def ask(p, text, n):
    p.locator("#composer-input").fill(text)
    p.locator("#composer-input").press("Enter")
    wait_reply(p, n)
    plot = p.locator("article.msg-assistant").last.locator(".plot")
    expect(plot.locator("canvas")).to_be_visible(timeout=10_000)
    return plot


def test_demo_plots_a_function_with_key_points(browser):
    p, errors = open_app(browser, FakeAI(), DEMO)
    plot = ask(p, "plot y = x^2 - 4", 1)
    readout = plot.locator(".plot-readout")
    expect(readout).to_contain_text("Root (−2, 0)")
    expect(readout).to_contain_text("Minimum & y-intercept (0, −4)")
    canvas = plot.locator("canvas")
    img = canvas_png(p, canvas)
    assert count_colour(img, (0x25, 0x63, 0xeb)) > 150, "the blue curve should be drawn"
    SHOTS.mkdir(exist_ok=True)
    plot.screenshot(path=str(SHOTS / "plot-2d.png"))
    # trace: hover on the curve at x = 1 → y = -3
    box = canvas.bounding_box()
    label = canvas.get_attribute("aria-label")
    m = re.search(r"x from (\S+) to (\S+), y from (\S+) to (\S+)\.", label)
    num = lambda s: float(s.replace("−", "-"))
    x0, x1, y0, y1 = map(num, m.groups())
    px = box["x"] + (1 - x0) / (x1 - x0) * box["width"]
    py = box["y"] + box["height"] - (-3 - y0) / (y1 - y0) * box["height"]
    p.mouse.move(px, py)
    expect(readout).to_contain_text(re.compile(r"x = 1(\.0\d*)?, y = −3"))
    # zoom with the wheel, then reset
    p.mouse.wheel(0, -400)
    expect(canvas).not_to_have_attribute("aria-label", label)
    plot.get_by_role("button", name="Reset view").click()
    expect(canvas).to_have_attribute("aria-label", label)
    assert not errors, errors


def test_demo_plots_3d_and_rotates(browser):
    p, errors = open_app(browser, FakeAI(), DEMO)
    plot = ask(p, "3d plot of sin(x) cos(y)", 1)
    canvas = plot.locator("canvas")
    before = canvas_png(p, canvas)
    colours = len(set(before.resize((120, 120)).getdata()))
    assert colours > 400, f"a shaded surface has many colours ({colours})"
    plot.screenshot(path=str(SHOTS / "plot-3d.png"))
    box = canvas.bounding_box()
    p.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    p.mouse.down()
    p.mouse.move(box["x"] + box["width"] / 2 + 120, box["y"] + box["height"] / 2 + 30, steps=6)
    p.mouse.up()
    p.wait_for_timeout(200)
    after = canvas_png(p, canvas)
    diff = sum(1 for a, b in zip(before.resize((100, 100)).getdata(), after.resize((100, 100)).getdata()) if a != b)
    assert diff > 1500, f"dragging should rotate the surface ({diff})"
    assert not errors, errors


def test_model_plot_with_slider_implicit_and_polar(browser):
    reply = ("Here you go:\n\n```plot\ntitle: Family of curves\na = 1 [0..3]\ny = a*sin(x)\nx^2 + y^2 = 4\nr = 1 + cos(theta)\n(1, 1)\n```\n\n"
             "And in 3D:\n\n```plot\nx^2 + y^2 + z^2 = 9\n```")
    ai = FakeAI(reply)
    p, errors = open_app(browser, ai)
    p.locator("#composer-input").fill("show me some graphs")
    p.locator("#composer-input").press("Enter")
    wait_reply(p, 1)
    plots = p.locator("article.msg-assistant").last.locator(".plot")
    expect(plots).to_have_count(2, timeout=10_000)
    first = plots.nth(0)
    expect(first.locator(".plot-title")).to_have_text("Family of curves")
    expect(first.locator(".plot-legend li")).to_have_count(4)
    slider = first.get_by_label("Parameter a")
    canvas = first.locator("canvas")
    before = canvas_png(p, canvas)
    slider.fill("3")
    expect(first.locator(".plot-param-value")).to_have_text("= 3")
    p.wait_for_timeout(400)
    after = canvas_png(p, canvas)
    assert before.tobytes() != after.tobytes(), "moving the slider redraws the graph"
    first.screenshot(path=str(SHOTS / "plot-params.png"))
    sphere = canvas_png(p, plots.nth(1).locator("canvas"))
    assert len(set(sphere.resize((100, 100)).getdata())) > 200
    assert not errors, errors


def test_bad_plot_is_explained(browser):
    p, errors = open_app(browser, FakeAI("```plot\ny = foo(x)\n```"))
    p.locator("#composer-input").fill("graph")
    p.locator("#composer-input").press("Enter")
    wait_reply(p, 1)
    expect(p.locator(".plot-error")).to_contain_text("Unknown name “foo”", timeout=10_000)
    assert not errors, errors


def test_png_download_and_graph_in_pdf(browser, tmp_path):
    mock = """window.__pdf = []; window.ZenvqoPDF = {
      save(id, html, name) { window.__pdf.push({id, html, name}); setTimeout(() => window.__zpdf(id, 'saved', 'Downloads/zenvqo'), 50); },
      saveBytes(id, b64, name) { window.__pdf.push({id, b64, name}); setTimeout(() => window.__zpdf(id, 'saved', 'Downloads/zenvqo'), 50); },
      open() {}, share() {} };"""
    ai = FakeAI("# Graph of x squared\n\n```plot\ny = x^2\n```\n\nIt is a parabola.")
    p, errors = open_app(browser, ai, mock)
    p.locator("#composer-input").fill("make a pdf with the graph of x^2")
    p.locator("#composer-input").press("Enter")
    wait_reply(p, 1)
    expect(p.locator(".pdf-card")).to_contain_text("Saved to Downloads/zenvqo", timeout=15_000)
    saved = p.evaluate("window.__pdf.find(x => x.html)")
    assert 'class="pdf-plot"' in saved["html"] and "data:image/png;base64," in saved["html"]
    plot = p.locator(".plot").first
    plot.get_by_role("button", name="Save as picture").click()
    expect(plot.locator(".plot-readout")).to_have_text("Saved to Downloads/zenvqo")
    png = p.evaluate("window.__pdf.find(x => x.b64)")
    assert png["name"].startswith("graph-") and png["name"].endswith(".png")
    assert base64.b64decode(png["b64"])[:8] == b"\x89PNG\r\n\x1a\n"
    assert not errors, errors
