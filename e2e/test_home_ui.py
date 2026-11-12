"""The home screen (a new chat): greeting, one-tap tools and three ideas to try."""
from playwright.sync_api import expect

from test_camera_pdf_read import FakeAI, open_app


def test_home_tools_and_ideas(browser):
    p, errors = open_app(browser, FakeAI("ok"))
    expect(p.get_by_role("heading", name="How can I help?")).to_be_visible()
    expect(p.locator(".home-hello")).to_have_text(__import__("re").compile("^(Good (morning|afternoon|evening)|Hello)$"))
    tools = p.get_by_role("list", name="Quick tools").get_by_role("button")
    assert tools.all_inner_texts() == ["Snap a question", "Create an image", "Build an app", "Make a PDF", "Plot a graph", "Read a file"]
    box = p.locator("#composer-input")
    p.get_by_role("button", name="Build an app").click()
    expect(box).to_have_value("Make an app: ")
    expect(box).to_be_focused()
    p.get_by_role("button", name="Make a PDF").click()
    expect(box).to_have_value("Make a PDF of notes on ")
    with p.expect_file_chooser() as fc:
        p.get_by_role("button", name="Read a file").click()
    assert fc.value.is_multiple()
    ideas = p.locator(".ideas .suggestion")
    expect(ideas).to_have_count(3)
    first = ideas.first.inner_text().strip()
    ideas.first.click()
    expect(box).to_have_value(first)
    p.get_by_role("button", name="Snap a question").click()
    expect(p.get_by_role("dialog", name="Take a photo")).to_be_visible()
    assert not errors, errors
