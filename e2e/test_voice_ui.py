"""Voice conversation in a real browser with a real (fake-device) microphone: Chromium plays a WAV file as the mic, so
capture, VAD, transport, the chat, and the spoken reply all run for real.

ZC_E2E_ASR=fake (default): a tone recognizer stands in for Whisper (tones → known sentences).
ZC_E2E_ASR=real          : real Whisper + real Kokoro (CI) on a real recording of "What is Artificial Intelligence?"."""
import json
import os
import re
import wave
from pathlib import Path

import numpy as np
import pytest
from conftest import start_server
from playwright.sync_api import expect

REAL = os.environ.get("ZC_E2E_ASR") == "real"
SHOTS = Path(os.environ.get("ZC_REAL_OUT") or Path(__file__).parent / "screenshots")
ROOT = Path(__file__).resolve().parents[1]
T = 240_000 if REAL else 25_000
fake_only = pytest.mark.skipif(REAL, reason="uses the tone recognizer")
SR = 48000


def syllables(f, secs, amp=0.35):
    t = np.arange(int(SR * secs)) / SR
    env = 0.55 + 0.45 * np.sin(2 * np.pi * 4 * t)                  # speech-like loudness changes, ~4 syllables/s
    return (amp * env * np.sin(2 * np.pi * f * t) * np.sin(2 * np.pi * 7 * t + 1) ** 2).astype(np.float32)


def quiet(secs):
    return (np.random.default_rng(1).normal(0, 0.001, int(SR * secs))).astype(np.float32)


def write_wav(path, x, sr=SR):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())


@pytest.fixture(scope="module")
def mic_file(tmp_path_factory):
    p = tmp_path_factory.mktemp("mic") / "mic.wav"
    if REAL:
        import sys
        sys.path.insert(0, str(ROOT / "backend"))
        from app.tts.engines import KokoroEngine                     # a real voice asking the question
        k = KokoroEngine()
        speech, sr = k.synth("What is Artificial Intelligence?", "am_michael", "en", 1.0, "")
        t = np.arange(int(len(speech) * SR / sr)) * sr / SR
        speech = np.interp(t, np.arange(len(speech)), speech).astype(np.float32)
        write_wav(p, np.concatenate([quiet(1.5), speech * 0.8, quiet(40)]))
    else:
        write_wav(p, np.concatenate([quiet(1.2), syllables(300, 1.6), quiet(5), syllables(500, 1.6), quiet(12)]))
    return p


@pytest.fixture(scope="module")
def voice_server(tmp_path_factory):
    env = {"ZC_E2E_ASR": "real" if REAL else "fake", "ZC_E2E_TTS": "real" if REAL else "fake", "ZC_E2E_IMAGES": "fake",
           "ZC_ASR_ENGINES": "whisper" if REAL else "none", "ZC_TTS_ENGINES": "kokoro" if REAL else "none"}
    base, proc = start_server(tmp_path_factory, "e2e_image_app:create", env)
    yield base
    proc.terminate()
    proc.wait(10)


@pytest.fixture(scope="module")
def mic_browser(pw, mic_file):
    b = pw.chromium.launch(args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
                                 f"--use-file-for-fake-audio-capture={mic_file}", "--autoplay-policy=no-user-gesture-required"])
    yield b
    b.close()


def signed_in(browser, base, name, grant=True):
    ctx = browser.new_context(base_url=base, viewport={"width": 1100, "height": 900})
    if grant:
        ctx.grant_permissions(["microphone"], origin=base)
    p = ctx.new_page()
    p.errors = []
    p.on("pageerror", lambda e: p.errors.append(str(e)))
    p.goto("/")
    p.get_by_role("button", name="Create an account").click()
    p.get_by_label("Name").fill("Asha")
    p.get_by_label("Email").fill(f"{name}@example.com")
    p.get_by_label("Password").fill("correct horse battery")
    p.get_by_role("button", name="Create account").click()
    expect(p.get_by_role("heading", name="How can I help?")).to_be_visible()
    return ctx, p


def test_hands_free_voice_turn(mic_browser, voice_server):
    ctx, p = signed_in(mic_browser, voice_server, "voice1")
    ws_frames = []
    p.on("websocket", lambda ws: ws.on("framesent", lambda f: ws_frames.append(f)))
    p.get_by_role("button", name="Add photos, files and more").click()
    p.get_by_role("menuitem", name="Start voice conversation").click()
    panel = p.get_by_role("region", name="Voice conversation")
    expect(panel).to_be_visible()
    expect(p.locator(".rec-dot")).to_have_text("Mic on", timeout=10_000)                 # recording is visible
    expect(panel.get_by_text("Hearing you…")).to_be_visible(timeout=T)
    user = p.locator("article.msg-user").first
    expect(user).to_contain_text(re.compile(r"what is artificial intelligence", re.I), timeout=T)   # speech → text → chat
    reply = p.locator("article.msg-assistant").first
    expect(reply).to_contain_text(re.compile(r"artificial intelligence", re.I), timeout=T)
    expect(panel.get_by_text("Speaking")).to_be_visible(timeout=T)                       # reply is spoken
    expect(reply.locator(".now-speaking")).to_be_visible()
    p.screenshot(path=str(SHOTS / ("voice-speaking-real.png" if REAL else "voice-speaking.png")))
    lat = panel.locator(".voice-latency")
    expect(lat).to_be_visible(timeout=T)
    heard, audio = lat.get_attribute("data-heard-ms"), lat.get_attribute("data-audio-ms")
    (SHOTS / ("voice-latency-real.json" if REAL else "voice-latency.json")).write_text(json.dumps({
        "heard_ms": heard, "first_audio_ms": audio, "text": lat.inner_text(), "user": user.inner_text(),
        "websocket_frames": len(ws_frames)}))
    assert heard and int(heard) >= 0
    if not REAL:
        expect(p.locator("article.msg-user").nth(1)).to_contain_text("Tell me a joke", timeout=T)   # hands-free: next turn
    p.get_by_role("button", name="End voice").click()
    expect(panel).to_have_count(0)
    expect(p.locator(".rec-dot")).to_have_count(0)                                        # mic released
    assert p.errors == []
    ctx.close()


@fake_only
def test_push_to_talk_mute_and_interrupt(mic_browser, voice_server):
    ctx, p = signed_in(mic_browser, voice_server, "voice2")
    p.get_by_role("button", name="Add photos, files and more").click()
    p.get_by_role("menuitem", name="Start voice conversation").click()
    panel = p.get_by_role("region", name="Voice conversation")
    panel.get_by_text("Push-to-talk").click()
    expect(panel.get_by_text("Hold the mic button and talk")).to_be_visible()
    p.wait_for_timeout(2500)
    assert p.locator("article.msg-user").count() == 0                                     # nothing sent without holding
    orb = panel.get_by_role("button", name="Hold to talk")
    box = orb.bounding_box()
    p.mouse.move(box["x"] + 20, box["y"] + 20)
    p.mouse.down()
    p.wait_for_timeout(2600)
    p.mouse.up()
    expect(p.locator("article.msg-user").first).to_contain_text(".", timeout=T)
    expect(panel.get_by_text("Speaking")).to_be_visible(timeout=T)
    panel.get_by_role("button", name="Interrupt and talk").click()                       # tap to interrupt
    expect(p.locator("article.msg-assistant").first.get_by_role("button", name="Read aloud")).to_be_visible()
    panel.get_by_role("button", name="Mute").click()
    expect(panel.get_by_text("Muted")).to_be_visible()
    expect(p.locator(".rec-dot")).to_have_count(0)
    panel.get_by_role("button", name="Unmute").click()
    panel.get_by_role("button", name="End voice").click()
    assert p.errors == []
    ctx.close()


@fake_only
def test_microphone_denied(pw, voice_server):
    b = pw.chromium.launch(args=["--use-fake-device-for-media-stream"])
    ctx, p = signed_in(b, voice_server, "voice3", grant=False)
    # what the browser raises when the user clicks "Block" (headless Chromium can't show the prompt itself)
    p.evaluate("() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')); }")
    p.get_by_role("button", name="Add photos, files and more").click()
    p.get_by_role("menuitem", name="Start voice conversation").click()
    expect(p.get_by_role("alert")).to_contain_text("Microphone permission was denied", timeout=10_000)
    p.get_by_role("button", name="End voice").click()
    b.close()


MOCK_ANDROID = """
window.__asr = [];
window.ZenvqoASR = {
  status() { return 'ready'; },
  start(lang, partial) {
    window.__asr.push({ev: 'start', lang});
    const n = window.__asr.filter(x => x.ev === 'start').length;
    const say = n === 1 ? 'AI kya hai' : 'aur batao';
    setTimeout(() => window.__zasr('begin', ''), 200);
    setTimeout(() => window.__zasr('level', '6'), 300);
    setTimeout(() => window.__zasr('partial', say.split(' ')[0]), 500);
    setTimeout(() => { window.__zasr('final', say); window.__zasr('end', ''); }, 900);
  },
  stop() { window.__asr.push({ev: 'stop'}); },
  cancel() { window.__asr.push({ev: 'cancel'}); },
};
window.ZenvqoTTS = {
  speak(id, text, lang) { window.__asr.push({ev: 'speak', text, lang}); setTimeout(() => window.__ztts(id, 'done'), 400); },
  stop() {}, voices() { return '[]'; }, status() { return 'ready'; },
};
"""


@fake_only
def test_android_app_voice_loop(browser):
    html = ROOT / "frontend" / "dist-standalone" / "zenvqo-chat.html"
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
    ctx.add_init_script(MOCK_ANDROID)
    p = ctx.new_page()
    errors = []
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.goto(html.as_uri())
    p.get_by_role("button", name="Add photos, files and more").click()
    p.get_by_role("menuitem", name="Start voice conversation").click()
    panel = p.get_by_role("region", name="Voice conversation")
    expect(p.locator("article.msg-user").first).to_contain_text("AI kya hai", timeout=10_000)   # on-device recognition
    expect(p.locator("article.msg-assistant").first).to_contain_text("offline demo", timeout=10_000)
    expect(p.locator("article.msg-user").nth(1)).to_contain_text("aur batao", timeout=15_000)   # listened again after speaking
    log = p.evaluate("window.__asr")
    starts = [x for x in log if x["ev"] == "start"]
    assert starts[0]["lang"] == "auto" and any(x["ev"] == "speak" for x in log)
    first_speak = next(i for i, x in enumerate(log) if x["ev"] == "speak")
    second_start = [i for i, x in enumerate(log) if x["ev"] == "start"][1]
    assert second_start > first_speak                                                       # never listens over its own voice
    panel.get_by_role("button", name="End voice").click()
    p.screenshot(path=str(SHOTS / "voice-android.png"))
    assert errors == []
    ctx.close()
