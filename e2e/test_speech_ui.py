"""Reading replies aloud, in the real browser UI.

ZC_E2E_TTS=fake (default): a tone engine on the server stands in for the voice, to check every control quickly.
ZC_E2E_TTS=real          : the server's real voices (CI: Kokoro) — the success criterion with real speech audio.
The Android path is checked against a scripted window.ZenvqoTTS bridge (the real one is Android's TextToSpeech)."""
import io
import json
import os
import wave
from pathlib import Path

import pytest
from conftest import start_server
from playwright.sync_api import expect

REAL = os.environ.get("ZC_E2E_TTS") == "real"
SHOTS = Path(os.environ.get("ZC_REAL_OUT") or Path(__file__).parent / "screenshots")
ROOT = Path(__file__).resolve().parents[1]
T = 180_000 if REAL else 15_000
fake_only = pytest.mark.skipif(REAL, reason="UI-control test; uses the tone voice")


@pytest.fixture(scope="module")
def voice_server(tmp_path_factory):
    env = {"ZC_E2E_TTS": "real" if REAL else "fake", "ZC_E2E_IMAGES": "fake",
           "ZC_TTS_ENGINES": os.environ.get("ZC_TTS_ENGINES", "kokoro") if REAL else "none"}
    base, proc = start_server(tmp_path_factory, "e2e_image_app:create", env)
    yield base
    proc.terminate()
    proc.wait(10)


@pytest.fixture
def pg(browser, voice_server, request):
    ctx = browser.new_context(base_url=voice_server, viewport={"width": 1280, "height": 900})
    p = ctx.new_page()
    p.errors, p.tts = [], []
    p.on("pageerror", lambda e: p.errors.append(str(e)))
    p.on("response", lambda r: r.url.endswith("/api/tts") and p.tts.append(r))
    p.goto("/")
    p.get_by_role("button", name="Create an account").click()
    p.get_by_label("Name").fill("Asha")
    p.get_by_label("Email").fill(f"v{abs(hash(request.node.name))}@example.com")
    p.get_by_label("Password").fill("correct horse battery")
    p.get_by_role("button", name="Create account").click()
    expect(p.get_by_role("heading", name="How can I help?")).to_be_visible()
    yield p
    ctx.close()


def ask(p, text):
    box = p.get_by_label("Message", exact=True)
    box.fill(text)
    box.press("Enter")
    reply = p.locator("article.msg-assistant").last
    expect(reply).to_have_attribute("aria-busy", "false", timeout=15_000)
    return reply


def test_success_criterion_reply_is_spoken(pg):
    reply = ask(pg, "What is Artificial Intelligence?")
    expect(reply).to_contain_text("What is Artificial Intelligence?")
    reply.get_by_role("button", name="Read aloud").click()
    expect(reply.get_by_role("button", name="Pause reading")).to_be_visible(timeout=5000)
    expect(reply.locator(".now-speaking")).to_contain_text("What is Artificial Intelligence?", timeout=T)
    def first_sentence():
        return [x for x in pg.tts if json.loads(x.request.post_data)["text"].startswith("You said")]
    for _ in range(int(T / 250)):
        if first_sentence():
            break
        pg.wait_for_timeout(250)
    r = first_sentence()[0]
    assert r.status == 200 and r.headers["content-type"] == "audio/wav"
    body = json.loads(r.request.post_data)
    assert body["lang"] == "en" and body["text"].startswith("You said: What is Artificial Intelligence?")
    again = pg.request.post(pg.url.split("/c/")[0] + "/api/tts", data=body, headers={"X-Requested-With": "zenvqo"})
    audio = again.body()                                                             # same sentence (cached on the server)
    with wave.open(io.BytesIO(audio)) as w:
        secs = w.getnframes() / w.getframerate()
    assert secs > 0.5 and again.headers["x-tts-cache"] == "hit"                       # real audio came back
    pg.screenshot(path=str(SHOTS / ("speech-playing-real.png" if REAL else "speech-playing.png")))
    if REAL:
        (SHOTS / "speech-ui-first-sentence.wav").write_bytes(audio)
    reply.get_by_role("button", name="Pause reading").click()
    expect(reply.get_by_role("button", name="Resume reading")).to_be_visible()
    reply.get_by_role("button", name="Resume reading").click()
    expect(reply.get_by_role("button", name="Pause reading")).to_be_visible()
    reply.get_by_role("button", name="Stop reading").click()
    expect(reply.get_by_role("button", name="Read aloud")).to_be_visible()
    expect(reply.locator(".now-speaking")).to_have_count(0)
    reply.get_by_role("button", name="Read aloud").click()                         # plays to the end by itself
    expect(reply.get_by_role("button", name="Read aloud")).to_be_visible(timeout=T * 2)
    assert len(pg.tts) >= 2 and pg.errors == []


@fake_only
def test_one_voice_at_a_time_replay_and_auto_speak(pg):
    first = ask(pg, "Tell me a fact about the moon.")
    second = ask(pg, "And one about the sun.")
    first.get_by_role("button", name="Read aloud").click()
    expect(first.get_by_role("button", name="Pause reading")).to_be_visible()
    second.get_by_role("button", name="Read aloud").click()
    expect(second.get_by_role("button", name="Pause reading")).to_be_visible()
    expect(pg.get_by_role("button", name="Pause reading")).to_have_count(1)        # the first one stopped
    second.get_by_role("button", name="Replay from the start").click()
    expect(second.locator(".speak-ctl")).to_contain_text("1 /")
    pg.get_by_role("button", name="Speak replies automatically").click()           # auto mode
    expect(pg.get_by_role("button", name="Speak replies automatically")).to_have_attribute("aria-pressed", "true")
    n = len(pg.tts)
    box = pg.get_by_label("Message", exact=True)
    box.fill("What is Artificial Intelligence? Explain it simply.")
    box.press("Enter")                                                              # sending also stops the old reading
    third = pg.locator("article.msg-assistant").last
    expect(third.get_by_role("button", name="Pause reading")).to_be_visible(timeout=10_000)
    expect(pg.get_by_role("button", name="Pause reading")).to_have_count(1)
    assert len(pg.tts) > n
    pg.keyboard.press("Escape")                                                     # Esc stops speech
    expect(third.get_by_role("button", name="Read aloud")).to_be_visible()
    assert pg.errors == []


@fake_only
def test_voice_settings_language_gender_test_button(pg):
    pg.get_by_role("button", name="Settings", exact=True).click()
    dlg = pg.get_by_role("dialog", name="Settings")
    voice = dlg.locator("fieldset", has_text="Voice")
    expect(voice.get_by_label("Read replies with")).to_contain_text("Server voices")
    voice.get_by_text("Male-sounding", exact=True).click()
    hindi = voice.get_by_label("Hindi voice", exact=True)
    expect(hindi.locator("option")).to_have_text(["Automatic", "Omega — Hindi"])
    voice.locator(".voice-row", has_text="Hindi voice").get_by_role("button", name="Test").click()
    for _ in range(40):
        if pg.tts:
            break
        pg.wait_for_timeout(100)
    body = json.loads(pg.tts[-1].request.post_data)
    assert body["lang"] == "hi" and body["gender"] == "male" and "नमस्ते" in body["text"]
    assert pg.tts[-1].headers["x-tts-voice"] == "kokoro:hm_omega"
    voice.get_by_label("Speed").fill("1.5")
    expect(voice.get_by_text("Pitch: not adjustable with server voices")).to_be_visible()
    pg.screenshot(path=str(SHOTS / "speech-settings.png"))
    saved = pg.evaluate("JSON.parse(localStorage.getItem('zc.voice'))")
    assert saved["gender"] == "male" and saved["speed"] == 1.5


MOCK_ANDROID = """
window.__ttsLog = [];
window.ZenvqoTTS = {
  cur: null, t: null,
  speak(id, text, lang, rate, pitch, volume, voice) {
    window.__ttsLog.push({ev: 'speak', id, text, lang, rate, pitch, voice});
    this.cur = id;
    setTimeout(() => window.__ztts(id, 'range', 0, 4), 30);
    this.t = setTimeout(() => { this.cur = null; window.__ztts(id, 'done'); }, 700);
  },
  stop() {
    window.__ttsLog.push({ev: 'stop'});
    clearTimeout(this.t);
    if (this.cur) { const id = this.cur; this.cur = null; setTimeout(() => window.__ztts(id, 'stop'), 10); }
  },
  voices() { return JSON.stringify([{name: 'hi-in-x-hia-local', locale: 'hi-IN', local: true}, {name: 'en-us-x-sfg-local', locale: 'en-US', local: true}]); },
  status() { return 'ready'; },
};
"""


@fake_only
def test_android_app_uses_phone_tts(browser):
    html = ROOT / "frontend" / "dist-standalone" / "zenvqo-chat.html"
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    ctx.add_init_script(MOCK_ANDROID)
    p = ctx.new_page()
    errors = []
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.goto(html.as_uri())
    box = p.get_by_label("Message", exact=True)
    box.fill("What is Artificial Intelligence?")
    box.press("Enter")
    reply = p.locator("article.msg-assistant").last
    expect(reply).to_have_attribute("aria-busy", "false", timeout=15_000)
    reply.get_by_role("button", name="Read aloud").click()
    expect(reply.get_by_role("button", name="Pause reading")).to_be_visible()
    expect(reply.locator(".now-speaking mark")).to_have_text("I'm ", timeout=3000)   # word highlight from range events
    reply.get_by_role("button", name="Pause reading").click()
    expect(reply.get_by_role("button", name="Resume reading")).to_be_visible()
    reply.get_by_role("button", name="Resume reading").click()
    expect(reply.get_by_role("button", name="Read aloud")).to_be_visible(timeout=20_000)   # finished
    log = p.evaluate("window.__ttsLog")
    speaks = [x for x in log if x["ev"] == "speak"]
    assert speaks[0]["lang"] == "en-US" and speaks[0]["text"].startswith("I'm the offline demo")
    assert speaks[1]["text"] == speaks[0]["text"]                                   # Android has no pause: sentence restarts
    assert any(x["ev"] == "stop" for x in log)
    p.get_by_role("button", name="Open conversations").click()
    p.get_by_role("button", name="Settings", exact=True).click()
    voice = p.get_by_role("dialog", name="Settings").locator("fieldset", has_text="Voice")
    expect(voice.get_by_label("Read replies with")).to_contain_text("This phone's voices")
    expect(voice.get_by_label("Hindi voice", exact=True).locator("option")).to_have_text(["Automatic", "hi-in-x-hia-local"])
    voice.get_by_label("Pitch").fill("1.3")
    voice.locator(".voice-row", has_text="Hindi voice").get_by_role("button", name="Test").click()
    p.wait_for_function("window.__ttsLog.some(x => x.lang === 'hi-IN')")
    last = [x for x in p.evaluate("window.__ttsLog") if x["ev"] == "speak"][-1]
    assert last["lang"] == "hi-IN" and last["pitch"] == 1.3 and "नमस्ते" in last["text"]
    p.screenshot(path=str(SHOTS / "speech-android-settings.png"))
    assert errors == []
    ctx.close()
