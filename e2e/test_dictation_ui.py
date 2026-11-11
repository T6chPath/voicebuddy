"""The mic in the message box (like ChatGPT): tap → it records (waveform, timer, words so far) → ✓ puts the words in
the box → the user sends and the AI does the task. Phone app build with a stand-in for the phone's speech recognizer."""
import json

from playwright.sync_api import expect

from test_camera_pdf_read import FakeAI, open_app, wait_reply

ASR = """
window.__asr = [];
window.ZenvqoASR = {
  status() { return 'ready'; },
  start(lang, partial) {
    window.__asr.push('start');
    const n = window.__asr.filter(x => x === 'start').length;
    let t = 0; const at = (ev, d, ms) => setTimeout(() => window.__zasr(ev, d), (t += ms));
    at('begin', '', 100);
    for (const l of [2, 7, 4, 9, 3]) at('level', String(l), 60);
    if (n === 1) {                      // first stretch: the phone stops at a pause; the app listens again
      at('partial', 'explain photo', 100); at('partial', 'explain photosynthesis', 100);
      at('final', 'explain photosynthesis', 100); at('end', '', 50);
    } else {
      window.__finish = () => { at('partial', 'in simple', 50); at('final', 'in simple words', 80); at('end', '', 40); };
      at('partial', 'in simple', 150);
    }
  },
  stop() { window.__asr.push('stop'); window.__finish && window.__finish(); },
  cancel() { window.__asr.push('cancel'); },
};
"""


def test_dictate_then_send(browser):
    ai = FakeAI("Plants make food from sunlight.")
    p, errors = open_app(browser, ai, ASR)
    p.locator("#composer-input").fill("Please")
    p.get_by_role("button", name="Dictate").click()
    bar = p.get_by_role("group", name="Recording your message")
    expect(bar).to_be_visible()
    expect(bar.locator(".dict-time")).to_have_text("0:00")
    expect(p.locator("#composer-input")).to_have_value("Please explain photosynthesis in simple", timeout=5_000)   # live words
    expect(p.locator("#composer-input")).to_have_js_property("readOnly", True)
    assert p.evaluate("window.__asr.filter(x => x === 'start').length") == 2, "listened again after the pause"
    heights = bar.locator(".dict-wave i").evaluate_all("els => els.map(e => parseFloat(e.style.height))")
    assert max(heights) > 30, heights                                                        # the waveform moves
    bar.get_by_role("button", name="Done — put the words in the message").click()
    expect(bar).to_have_count(0)
    expect(p.locator("#composer-input")).to_have_value("Please explain photosynthesis in simple words")
    expect(p.locator("#composer-input")).to_be_focused()
    p.get_by_role("button", name="Send message").click()
    wait_reply(p, 1)
    sent = [m for m in ai.requests[0]["messages"] if m["role"] == "user"][-1]["content"]
    assert "Please explain photosynthesis in simple words" in json.dumps(sent)
    assert not errors, errors


def test_cancel_keeps_what_was_typed(browser):
    ai = FakeAI("ok")
    p, errors = open_app(browser, ai, ASR)
    p.locator("#composer-input").fill("draft")
    p.get_by_role("button", name="Dictate").click()
    expect(p.locator("#composer-input")).to_have_value("draft explain photosynthesis", timeout=5_000)
    p.get_by_role("button", name="Cancel recording").click()
    expect(p.get_by_role("group", name="Recording your message")).to_have_count(0)
    expect(p.locator("#composer-input")).to_have_value("draft")
    assert "cancel" in p.evaluate("window.__asr")
    assert not ai.requests
    assert not errors, errors
