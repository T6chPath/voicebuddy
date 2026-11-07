import asyncio
import io
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from conftest import HDR, client_for, make_settings, new_conv, parse_sse, register, send

from app.config import ModelConfig
from app.main import create_app


# ---------------- auth ----------------
def test_register_sets_secure_session_cookie(client):
    r = client.post("/api/auth/register", json={"email": "Asha@Example.com", "name": "Asha", "password": "longenough1"})
    assert r.status_code == 201
    assert r.json()["email"] == "asha@example.com"
    ck = r.headers["set-cookie"]
    assert "zc_session=" in ck and "HttpOnly" in ck and "samesite=lax" in ck.lower()
    assert client.get("/api/auth/me").json()["name"] == "Asha"


def test_login_logout_and_generic_errors(client, user):
    client.post("/api/auth/logout")
    assert client.get("/api/auth/me").status_code == 401
    bad = client.post("/api/auth/login", json={"email": "asha@example.com", "password": "wrong-password"})
    unknown = client.post("/api/auth/login", json={"email": "nobody@example.com", "password": "wrong-password"})
    assert bad.status_code == unknown.status_code == 401
    assert bad.json() == unknown.json()                                   # no account enumeration
    ok = client.post("/api/auth/login", json={"email": "ASHA@example.com", "password": "correct horse battery"})
    assert ok.status_code == 200 and client.get("/api/auth/me").status_code == 200


def test_old_session_invalid_after_logout(app, client, user):
    tok = client.cookies.get("zc_session")
    client.post("/api/auth/logout")
    c2 = client_for(app)
    c2.cookies.set("zc_session", tok)
    assert c2.get("/api/auth/me").status_code == 401


def test_validation_duplicate_and_rate_limit(client, user):
    assert client.post("/api/auth/register", json={"email": "not-an-email", "name": "x", "password": "longenough1"}).status_code == 422
    assert client.post("/api/auth/register", json={"email": "a@b.co", "name": "x", "password": "short"}).status_code == 422
    assert client.post("/api/auth/register", json={"email": "a@b.co", "name": "x", "password": "longenough1", "admin": True}).status_code == 422
    assert client.post("/api/auth/register", json={"email": "asha@example.com", "name": "x", "password": "longenough1"}).status_code == 409
    codes = [client.post("/api/auth/login", json={"email": "asha@example.com", "password": "nope-nope"}).status_code for _ in range(12)]
    assert codes[:10] == [401] * 10 and codes[10] == 429


def test_registration_can_be_closed(tmp_path):
    c = client_for(create_app(make_settings(tmp_path, allow_registration=False)))
    assert c.post("/api/auth/register", json={"email": "a@b.co", "name": "x", "password": "longenough1"}).status_code == 403


def test_csrf_and_security_headers(app, user, client):
    raw = client_for(app)
    raw.headers.pop("X-Requested-With")
    raw.cookies = client.cookies
    assert raw.post("/api/conversations", json={}).status_code == 403            # no custom header
    assert client.post("/api/conversations", json={}, headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/conversations", json={}, headers={"Origin": "http://localhost:5173"}).status_code == 201
    r = client.get("/api/auth/me")
    assert r.headers["x-content-type-options"] == "nosniff"
    assert "frame-ancestors 'none'" in r.headers["content-security-policy"]
    assert r.headers["cache-control"] == "no-store"


def test_password_is_hashed(app, user):
    row = app.state.db.one("SELECT password_hash FROM users")
    assert row["password_hash"].startswith("scrypt$") and "correct" not in row["password_hash"]
    assert app.state.db.one("SELECT token_hash FROM sessions")["token_hash"] != ""


# ---------------- conversations ----------------
def test_conversation_crud_search_and_paging(client, user):
    ids = [new_conv(client) for _ in range(3)]
    send(client, ids[0], "tell me about mangoes")
    lst = client.get("/api/conversations").json()
    assert {c["id"] for c in lst["items"]} == set(ids)
    assert lst["items"][0]["id"] == ids[0]                                  # most recently updated first
    found = client.get("/api/conversations", params={"q": "mango"}).json()["items"]
    assert [c["id"] for c in found] == [ids[0]]
    assert client.get("/api/conversations", params={"q": "%"}).json()["items"] == []     # LIKE wildcards escaped
    page = client.get("/api/conversations", params={"limit": 2}).json()
    assert len(page["items"]) == 2 and page["has_more"]
    r = client.patch(f"/api/conversations/{ids[1]}", json={"title": "Renamed", "pinned": True}).json()
    assert r["title"] == "Renamed" and r["pinned"]
    assert client.get("/api/conversations").json()["items"][0]["id"] == ids[1]  # pinned first
    assert client.patch(f"/api/conversations/{ids[1]}", json={"model": "nope"}).status_code == 400
    assert client.delete(f"/api/conversations/{ids[2]}").status_code == 204
    assert client.get(f"/api/conversations/{ids[2]}").status_code == 404


def test_cross_user_isolation(client, user, other):
    cid = new_conv(client)
    send(client, cid, "secret plans")
    fid = client.post("/api/files", files={"file": ("n.txt", b"private note", "text/plain")}).json()["id"]
    for method, path, body in [("GET", f"/api/conversations/{cid}", None), ("PATCH", f"/api/conversations/{cid}", {"title": "x"}),
                               ("DELETE", f"/api/conversations/{cid}", None), ("POST", f"/api/conversations/{cid}/messages", {"content": "hi"}),
                               ("POST", f"/api/conversations/{cid}/regenerate", None), ("GET", f"/api/files/{fid}", None),
                               ("DELETE", f"/api/files/{fid}", None)]:
        assert other.request(method, path, json=body).status_code == 404, path
    assert other.get("/api/conversations", params={"q": "secret"}).json()["items"] == []
    c2 = new_conv(other)
    code, body = send(other, c2, "use this", file_ids=[fid])                 # can't attach someone else's file
    assert code == 400
    assert client.get(f"/api/conversations/{cid}").status_code == 200


def test_requires_login(app):
    c = client_for(app)
    for m, p in [("GET", "/api/conversations"), ("POST", "/api/conversations"), ("GET", "/api/models"), ("GET", "/api/settings"),
                 ("POST", "/api/files")]:
        assert c.request(m, p).status_code == 401, p


# ---------------- chat streaming ----------------
def test_stream_events_persistence_and_title(client, user):
    cid = new_conv(client)
    code, events = send(client, cid, "Show me some code please")
    assert code == 200
    kinds = [e for e, _ in events]
    assert kinds[0] == "meta" and kinds[-1] == "done" and kinds.count("delta") > 5
    text = "".join(d["text"] for e, d in events if e == "delta")
    assert "```python" in text
    assert events[-1][1]["title"] == "Show me some code please"
    conv = client.get(f"/api/conversations/{cid}").json()
    assert [m["role"] for m in conv["messages"]] == ["user", "assistant"]
    assert conv["messages"][1]["content"] == text and conv["messages"][1]["status"] == "complete"
    assert conv["title"] == "Show me some code please"


def test_history_is_sent_to_model(client, user):
    cid = new_conv(client)
    send(client, cid, "first")
    _, events = send(client, cid, "second")
    text = "".join(d["text"] for e, d in events if e == "delta")
    assert "2 earlier message(s)" in text                                     # user+assistant from turn 1


def test_provider_error_mid_stream(client, user):
    cid = new_conv(client)
    _, events = send(client, cid, "please [fail] now")
    assert events[-1][0] == "error" and events[-1][1]["code"] == "demo_failure" and events[-1][1]["retryable"]
    msgs = client.get(f"/api/conversations/{cid}").json()["messages"]
    assert msgs[-1]["status"] == "error" and "on purpose" in msgs[-1]["error"]
    _, events = send(client, cid, "ok now")                                   # failed reply isn't fed back as context
    assert "2 earlier message(s)" not in "".join(d["text"] for e, d in events if e == "delta")


def test_regenerate_replaces_last_reply(client, user):
    cid = new_conv(client)
    send(client, cid, "hello")
    first = client.get(f"/api/conversations/{cid}").json()["messages"][-1]["id"]
    r = client.post(f"/api/conversations/{cid}/regenerate")
    assert parse_sse(r.text)[-1][0] == "done"
    msgs = client.get(f"/api/conversations/{cid}").json()["messages"]
    assert len(msgs) == 2 and msgs[-1]["id"] != first
    empty = new_conv(client)
    assert client.post(f"/api/conversations/{empty}/regenerate").status_code == 400


def test_model_switch_unknown_model_and_vision_check(client, user):
    cid = new_conv(client)
    assert send(client, cid, "x", model="does-not-exist")[0] == 400
    png = b"\x89PNG\r\n\x1a\n" + b"\0" * 64
    fid = client.post("/api/files", files={"file": ("a.png", png, "image/png")}).json()["id"]
    code, body = send(client, cid, "what is this", file_ids=[fid])
    assert code == 400 and "can't read images" in body["detail"]
    assert send(client, cid, "what is this", file_ids=[fid], model="echo-vision")[0] == 200
    assert client.get(f"/api/conversations/{cid}").json()["model"] == "echo-vision"


def test_stop_saves_partial_reply(app, client, user):
    """Simulates the client disconnecting mid-stream (Stop button): the generator is closed early."""
    from app.routes.chat import _stream
    cid = new_conv(client)
    uid = user["id"]
    from types import SimpleNamespace
    resp = _stream(SimpleNamespace(app=app), app.state.db, app.state.settings, uid, cid, "echo", None, {}, None, {}, "hello", [])

    async def run():
        it = resp.body_iterator
        got = [await it.__anext__() for _ in range(4)]
        await it.aclose()
        return got
    got = asyncio.run(run())
    assert got[0].startswith("event: meta")
    row = app.state.db.one("SELECT status, content FROM messages WHERE role = 'assistant'")
    assert row["status"] == "stopped" and row["content"]


def test_message_validation(client, user):
    cid = new_conv(client)
    assert client.post(f"/api/conversations/{cid}/messages", json={"content": ""}).status_code == 422
    assert client.post(f"/api/conversations/{cid}/messages", json={"content": "x" * 32001}).status_code == 422
    assert client.post(f"/api/conversations/{cid}/messages", json={"content": "x", "file_ids": ["a"] * 6}).status_code == 422


# ---------------- OpenAI-compatible provider against a fake upstream ----------------
class Upstream(BaseHTTPRequestHandler):
    seen = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        Upstream.seen.append(body)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for w in ["Hello", " from", " upstream"]:
            self.wfile.write(f"data: {json.dumps({'choices': [{'delta': {'content': w}}]})}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")

    def log_message(self, *a):
        pass


def test_openai_compatible_provider(tmp_path):
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        s = make_settings(tmp_path, models=[ModelConfig("up", "Upstream", "openai", f"http://127.0.0.1:{srv.server_address[1]}/v1", "m1"),
                                            ModelConfig("down", "Down", "openai", "http://127.0.0.1:9/v1", "m2")])
        c = client_for(create_app(s))
        register(c)
        c.put("/api/settings", json={"system_prompt": "Be brief.", "temperature": 0.3, "default_model": "up"})
        cid = new_conv(c)
        fid = c.post("/api/files", files={"file": ("notes.md", "# Notes\nbuy milk".encode(), "text/markdown")}).json()["id"]
        _, ev = send(c, cid, "hi", file_ids=[fid])
        assert "".join(d["text"] for e, d in ev if e == "delta") == "Hello from upstream"
        sent = Upstream.seen[-1]
        assert sent["model"] == "m1" and sent["stream"] and sent["temperature"] == 0.3
        assert "Be brief." in sent["messages"][0]["content"]
        assert '<attached_file name="notes.md">' in sent["messages"][-1]["content"]
        _, ev = send(c, cid, "hi", model="down")
        assert ev[-1][0] == "error" and ev[-1][1]["code"] == "unreachable"
    finally:
        srv.shutdown()
        srv.server_close()


# ---------------- files ----------------
def test_uploads(client, user, tmp_path):
    r = client.post("/api/files", files={"file": ("../../etc/notes.txt", b"line one\nline two", "application/octet-stream")})
    assert r.status_code == 201 and r.json()["name"] == "notes.txt" and r.json()["kind"] == "text"
    fid = r.json()["id"]
    d = client.get(f"/api/files/{fid}")
    assert d.content == b"line one\nline two" and d.headers["content-disposition"].startswith("attachment")
    cid = new_conv(client)
    _, ev = send(client, cid, "summarise", file_ids=[fid])
    assert "line one" in "".join(x["text"] for e, x in ev if e == "delta")
    assert client.post("/api/files", files={"file": ("x.exe", b"MZ\x90\x00\x03\x00\x00\x00", "application/octet-stream")}).status_code == 415
    assert client.post("/api/files", files={"file": ("x.txt", b"\x00\x01\x02binary", "text/plain")}).status_code == 415
    assert client.post("/api/files", files={"file": ("fake.png", b"not really a png", "image/png")}).status_code == 415
    assert client.post("/api/files", files={"file": ("e.txt", b"", "text/plain")}).status_code == 400
    assert client.delete(f"/api/files/{fid}").status_code == 204
    assert client.get(f"/api/files/{fid}").status_code == 404


def test_upload_size_limit_and_pdf(tmp_path):
    c = client_for(create_app(make_settings(tmp_path, max_upload_mb=1)))
    register(c)
    assert c.post("/api/files", files={"file": ("big.txt", b"a" * (1024 * 1024 + 1), "text/plain")}).status_code == 413
    pytest.importorskip("reportlab")
    from reportlab.pdfgen import canvas
    buf = io.BytesIO()
    cv = canvas.Canvas(buf)
    cv.drawString(72, 720, "Quarterly revenue grew 12 percent.")
    cv.save()
    r = c.post("/api/files", files={"file": ("report.pdf", buf.getvalue(), "application/pdf")})
    assert r.status_code == 201 and r.json()["kind"] == "pdf" and r.json()["chars"] > 10


# ---------------- settings & models ----------------
def test_settings_and_models(client, user):
    s = client.get("/api/settings").json()
    assert s["theme"] == "system" and s["default_model"] == "echo"
    new = {**s, "theme": "dark", "temperature": 1.2, "send_on_enter": False}
    assert client.put("/api/settings", json=new).json()["theme"] == "dark"
    assert client.get("/api/settings").json()["temperature"] == 1.2
    assert client.put("/api/settings", json={**new, "temperature": 3}).status_code == 422
    assert client.put("/api/settings", json={**new, "theme": "neon"}).status_code == 422
    assert client.put("/api/settings", json={**new, "default_model": "gpt-99"}).status_code == 400
    assert client.put("/api/settings", json={**new, "is_admin": True}).status_code == 422
    models = client.get("/api/models").json()["items"]
    assert [m["id"] for m in models] == ["echo", "echo-vision"] and models[1]["vision"]
    assert "base_url" not in json.dumps(models)                              # server URLs not exposed


def test_spa_fallback(tmp_path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html>app</html>")
    (dist / "assets" / "a.js").write_text("x")
    c = client_for(create_app(make_settings(tmp_path, static_dir=dist)))
    assert c.get("/c/some-chat").text == "<html>app</html>"
    assert "immutable" in c.get("/assets/a.js").headers["cache-control"]
    assert c.get("/../../etc/passwd").text == "<html>app</html>"
    assert c.get("/api/nope").status_code == 404
