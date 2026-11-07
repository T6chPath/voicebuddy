import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
try:
    import fastapi  # noqa: F401
except ImportError:  # offline dev environment only — see tools/fastapi_offline_shim/README.md
    sys.path.insert(0, str(ROOT.parent / "tools" / "fastapi_offline_shim"))

from fastapi.testclient import TestClient  # noqa: E402

from app.config import ModelConfig, Settings  # noqa: E402
from app.main import create_app  # noqa: E402

HDR = {"X-Requested-With": "zenvqo"}


def make_settings(tmp_path, **kw):
    s = Settings(data_dir=tmp_path, echo_delay_s=0.0, allowed_origins=["http://localhost:5173"], image_providers="none", tts_engines="none",
                 models=[ModelConfig("echo", "Demo (echo)", "echo"), ModelConfig("echo-vision", "Echo vision", "echo", vision=True)])
    for k, v in kw.items():
        setattr(s, k, v)
    return s


@pytest.fixture
def settings(tmp_path):
    return make_settings(tmp_path)


@pytest.fixture
def app(settings):
    return create_app(settings)


def client_for(app):
    c = TestClient(app)
    c.headers.update(HDR)
    return c


@pytest.fixture
def client(app):
    return client_for(app)


def register(c, email="asha@example.com", name="Asha", pw="correct horse battery"):
    r = c.post("/api/auth/register", json={"email": email, "name": name, "password": pw})
    assert r.status_code == 201, r.text
    return r.json()


@pytest.fixture
def user(client):
    return register(client)


@pytest.fixture
def other(app):
    c = client_for(app)
    register(c, "bob@example.com", "Bob")
    return c


def parse_sse(text: str) -> list[tuple[str, dict]]:
    out = []
    for block in text.strip().split("\n\n"):
        ev, data = "message", ""
        for line in block.splitlines():
            if line.startswith("event:"):
                ev = line[6:].strip()
            elif line.startswith("data:"):
                data += line[5:].strip()
        if data:
            out.append((ev, json.loads(data)))
    return out


def new_conv(c, model=None):
    r = c.post("/api/conversations", json={"model": model} if model else {})
    assert r.status_code == 201, r.text
    return r.json()["id"]


def send(c, cid, content, **kw):
    r = c.post(f"/api/conversations/{cid}/messages", json={"content": content, **kw})
    return r.status_code, (parse_sse(r.text) if r.status_code == 200 else r.json())
