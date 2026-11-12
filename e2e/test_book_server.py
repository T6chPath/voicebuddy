"""'Learn as a book' on the web version (FastAPI server): an earlier page is written again in its place."""
import re

from playwright.sync_api import expect

from test_app import send, signup, wait_reply_done


def test_earlier_book_page_written_again_on_the_server(page):
    signup(page)
    page.get_by_role("button", name="Add photos, files and more").click()
    page.get_by_role("menuitem", name=re.compile("^Learn as a book")).click()
    send(page, "electricity")
    wait_reply_done(page)
    page._assistant_before = 1
    page.locator(".book-bar").get_by_role("button", name=re.compile("^Next")).click()
    wait_reply_done(page)
    pages = page.locator("article.msg-book")
    expect(pages).to_have_count(2)
    second = pages.nth(1).locator(".msg-body").inner_text()
    pages.nth(0).get_by_role("button", name="Regenerate this page").click()
    expect(pages.nth(0)).to_have_attribute("aria-busy", "true", timeout=5000)
    expect(pages.nth(0)).to_have_attribute("aria-busy", "false", timeout=15000)
    expect(page.locator(".msg-error")).to_have_count(0)
    expect(page.locator("article.msg-assistant")).to_have_count(2)            # in its place, not added at the end
    assert pages.nth(1).locator(".msg-body").inner_text() == second
    page.reload()                                                                 # saved on the server, in the same order
    expect(page.locator("article.msg-book")).to_have_count(2)
    expect(page.locator("article.msg-book").nth(0).locator(".msg-actions")).to_be_visible()
    assert page.locator("article.msg-book").nth(1).locator(".msg-body").inner_text() == second
    assert page.errors == []
