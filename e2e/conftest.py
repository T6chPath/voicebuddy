"""Starts the real backend (serving the built frontend) on a free port with demo models, then drives Chromium.

  cd frontend && npm run build && cd ..
  pip install pytest playwright && python -m playwright install chromium
  python -m pytest e2e -v
"""
import json
import os
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


@pytest.fixture(scope="session")
def server(tmp_path_factory):
    dist = ROOT / "frontend" / "dist"
    assert (dist / "index.html").exists(), "build the frontend first (cd frontend && npm run build)"
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    env = dict(os.environ)
    env.update(ZC_DATA_DIR=str(tmp_path_factory.mktemp("data")), ZC_STATIC_DIR=str(dist), ZC_ECHO_DELAY="0.03",
               ZC_ALLOWED_ORIGINS=base, ZC_MODELS=json.dumps([
                   {"id": "echo", "label": "Demo (echo)", "provider": "echo", "description": "Offline demo"},
                   {"id": "echo-vision", "label": "Demo vision", "provider": "echo", "vision": True},
                   {"id": "broken", "label": "Offline server", "provider": "openai", "base_url": "http://127.0.0.1:9/v1", "model": "x"}]))
    pp = [str(ROOT / "backend")]
    try:
        import fastapi  # noqa: F401
    except ImportError:
        pp.append(str(ROOT / "tools" / "fastapi_offline_shim"))
    env["PYTHONPATH"] = os.pathsep.join(pp + [env.get("PYTHONPATH", "")])
    proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:create_app", "--factory", "--port", str(port), "--log-level", "warning"],
                            cwd=ROOT / "backend", env=env)
    for _ in range(100):
        try:
            urllib.request.urlopen(base + "/api/health", timeout=1)
            break
        except OSError:
            time.sleep(0.1)
    else:
        proc.kill()
        raise RuntimeError("server did not start")
    yield base
    proc.terminate()
    proc.wait(5)


@pytest.fixture(scope="session")
def browser():
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch()
        yield b
        b.close()


@pytest.fixture
def page(browser, server):
    ctx = browser.new_context(base_url=server, viewport={"width": 1280, "height": 800})
    ctx.grant_permissions(["clipboard-read", "clipboard-write"], origin=server)
    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    pg.on("dialog", lambda d: (pg.errors.append("dialog:" + d.message), d.dismiss()))
    yield pg
    ctx.close()


@pytest.fixture
def mobile(browser, server):
    ctx = browser.new_context(base_url=server, viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    pg = ctx.new_page()
    pg.errors = []
    pg.on("pageerror", lambda e: pg.errors.append(str(e)))
    yield pg
    ctx.close()
