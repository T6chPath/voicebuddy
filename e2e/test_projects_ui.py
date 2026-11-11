"""Models for big projects, in the phone app build: more services (OpenRouter with free models marked, Claude headers),
model search, long answers that continue when cut off, and multi-file projects as a .zip / an app.
The Android network bridge (window.ZenvqoNative) is a stand-in that answers like each service."""
import io
import json
import zipfile
from pathlib import Path

from playwright.sync_api import expect

ROOT = Path(__file__).resolve().parents[1]
HTML = ROOT / "frontend" / "dist-standalone" / "zenvqo-chat.html"
ANSWER = (Path(__file__).parent / "project_sample.md").read_text()
CUT = ANSWER.index("body {")                                   # the first part stops inside the css block

BRIDGE = """
window.__calls = [];
window.ZenvqoNative = {
  request(id, url, method, headers, body) {
    const b = body ? JSON.parse(body) : null;
    window.__calls.push({url, method, headers: JSON.parse(headers), body: b});
    let t = 0;
    const at = (k, d) => setTimeout(() => window.__zn(id, k, d), (t += 5));
    if (url.endsWith('/models')) {
      at('head', '{"status":200}');
      at('data', JSON.stringify({data: [
        {id: 'anthropic/claude-sonnet-5-5', pricing: {prompt: '0.000003', completion: '0.000015'}, context_length: 1000000},
        {id: 'qwen/qwen3-coder', pricing: {prompt: '0.0000002', completion: '0.0000008'}, context_length: 262144},
        {id: 'openai/gpt-oss-120b:free', pricing: {prompt: '0', completion: '0'}, context_length: 131072},
        {id: 'openrouter/free', pricing: {prompt: '0', completion: '0'}, context_length: 200000},
        ...Array.from({length: 20}, (_, i) => ({id: 'maker' + i + '/model-' + i, pricing: {prompt: '0.000001', completion: '0.000001'}})),
      ]}));
      at('end', '');
      return;
    }
    const last = b.messages[b.messages.length - 1].content;
    const second = typeof last === 'string' && last.startsWith('Your previous reply was cut off');
    const text = second ? '```css\\n' + window.__part2 : window.__part1;
    at('head', '{"status":200}');
    for (let i = 0; i < text.length; i += 37) at('data', 'data: ' + JSON.stringify({choices: [{delta: {content: text.slice(i, i + 37)}}]}) + '\\n\\n');
    at('data', 'data: ' + JSON.stringify({choices: [{delta: {}, finish_reason: second ? 'stop' : 'length'}]}) + '\\n\\n');
    at('data', 'data: [DONE]\\n\\n'); at('end', '');
  },
  cancel(id) {}
};
"""


def open_app(browser, settings, extra="", phone=False):
    ctx = browser.new_context(viewport={"width": 390, "height": 844} if phone else {"width": 1280, "height": 860}, is_mobile=phone,
                              has_touch=phone, accept_downloads=True)
    ctx.add_init_script(f"localStorage.setItem('zc.local.settings', {json.dumps(json.dumps(settings))});" + BRIDGE + extra)
    p = ctx.new_page()
    errors = []
    p.on("pageerror", lambda e: errors.append(str(e)))
    p.goto(HTML.as_uri())
    expect(p.locator("#composer-input")).to_be_visible()
    return p, errors


def test_openrouter_free_models_first_and_model_search(browser):
    p, errors = open_app(browser, {"default_model": "echo"})
    p.get_by_role("button", name="Settings", exact=True).click()
    dlg = p.get_by_role("dialog", name="Settings")
    for name in ["OpenRouter — 500+ models, free key", "DeepSeek V4 — big projects", "Claude (Anthropic)", "OpenAI", "Mistral (Codestral)"]:
        expect(dlg.get_by_role("button", name=name, exact=True)).to_be_visible()
    dlg.get_by_role("button", name="OpenRouter — 500+ models, free key").click()
    expect(dlg.get_by_label("Server address")).to_have_value("https://openrouter.ai/api/v1")
    expect(dlg.get_by_role("link", name="openrouter.ai/keys")).to_be_visible()
    dlg.get_by_label("API key").fill("sk-or-test")
    dlg.get_by_role("button", name="Test connection").click()
    expect(dlg.locator(".conn-ok")).to_contain_text("openrouter/free (free)")
    req = p.evaluate("window.__calls")[0]
    assert req["url"] == "https://openrouter.ai/api/v1/models" and req["headers"]["Authorization"] == "Bearer sk-or-test"
    dlg.get_by_role("button", name="Save").click()
    expect(p.locator(".model-picker select option").nth(10)).to_be_attached(timeout=10_000)   # the chat now lists the service's models
    p.keyboard.press("Escape")
    p.get_by_role("button", name="Settings", exact=True).click()
    dlg = p.get_by_role("dialog", name="Settings")
    expect(dlg.get_by_label("Default model").locator("option").nth(10)).to_be_attached(timeout=10_000)   # the list has loaded
    expect(dlg.get_by_label("Default model")).to_have_value("srv:openrouter/free")
    options = [o for o in dlg.get_by_label("Default model").locator("option").all_inner_texts() if not o.startswith("Demo")]
    assert options[:2] == ["openrouter/free (free)", "openai/gpt-oss-120b (free)"], options[:4]
    dlg.get_by_label("Find a model").fill("coder")
    expect(dlg.get_by_label("Default model").locator("option")).to_have_count(2)        # the match + the chosen model (Demo hidden)
    assert "qwen/qwen3-coder" in dlg.get_by_label("Default model").locator("option").all_inner_texts()
    assert not errors, errors


def test_claude_gets_its_key_headers(browser):
    p, errors = open_app(browser, {"default_model": "echo"})
    p.get_by_role("button", name="Settings", exact=True).click()
    dlg = p.get_by_role("dialog", name="Settings")
    dlg.get_by_role("button", name="Claude (Anthropic)").click()
    dlg.get_by_label("API key").fill("sk-ant-test")
    dlg.get_by_role("button", name="Test connection").click()
    expect(dlg.locator(".conn-ok")).to_be_visible()
    h = p.evaluate("window.__calls")[0]["headers"]
    assert h["x-api-key"] == "sk-ant-test" and h["anthropic-version"] == "2023-06-01" and h["Authorization"] == "Bearer sk-ant-test"
    assert not errors, errors


def test_long_project_continues_then_zip_and_app(browser):
    parts = f"window.__part1 = {json.dumps(ANSWER[:CUT])}; window.__part2 = {json.dumps(ANSWER[CUT:])};"
    p, errors = open_app(browser, {"server_url": "https://api.deepseek.com/v1", "api_key": "k", "default_model": "srv:deepseek-v4-flash"}, parts, phone=True)
    p.locator("#composer-input").fill("make a todo web app")
    p.locator("#composer-input").press("Enter")
    reply = p.locator("article.msg-assistant").last
    expect(reply).to_have_attribute("aria-busy", "false", timeout=20_000)
    calls = [c for c in p.evaluate("window.__calls") if c["url"].endswith("/chat/completions")]
    assert len(calls) == 2, "the cut-off answer was continued once"
    assert calls[1]["body"]["messages"][-2] == {"role": "assistant", "content": ANSWER[:CUT]}
    system = calls[0]["body"]["messages"][0]["content"]
    assert "EVERY file complete" in system and "**`path/to/file.ext`**" in system
    expect(reply.locator(".code-block")).to_have_count(6)                              # joined: no extra code block
    bar = reply.get_by_role("region", name="Project todo")
    expect(bar).to_contain_text("4 files")
    with p.expect_download() as d:
        bar.get_by_role("button", name="Download project (.zip)").click()
    path = d.value.path()
    z = zipfile.ZipFile(io.BytesIO(Path(path).read_bytes()))
    assert z.testzip() is None
    assert sorted(z.namelist()) == ["todo/app.js", "todo/index.html", "todo/server.py", "todo/style.css"]
    assert "font: 16px" in z.read("todo/style.css").decode()
    assert d.value.suggested_filename == "todo.zip"
    bar.get_by_role("button", name="Make app").click()
    dlg = p.get_by_role("dialog", name="Make an Android app")
    expect(dlg).to_be_visible()
    assert not errors, errors
