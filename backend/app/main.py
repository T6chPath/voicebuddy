"""zenvqo chat API.
  dev:   uvicorn app.main:create_app --factory --reload
  prod:  ZC_STATIC_DIR=../frontend/dist ZC_COOKIE_SECURE=1 uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8000
"""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from starlette.datastructures import Headers

from .config import Settings
from .db import Database
from .routes import auth, chat, conversations, misc
from .security import SECURITY_HEADERS, RateLimiter, csrf_ok


class GuardMiddleware:
    """Pure ASGI (not BaseHTTPMiddleware, which interferes with streaming responses and client-disconnect
    cancellation): CSRF/origin check on /api mutations + security headers on every response."""

    def __init__(self, app, allowed_origins: list[str]):
        self.app, self.origins = app, allowed_origins

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path = scope["path"]
        if path.startswith("/api/") and not csrf_ok(scope["method"], Headers(scope=scope), self.origins):
            resp = JSONResponse({"detail": "Request blocked (missing CSRF header or foreign origin)."}, status_code=403)
            return await resp(scope, receive, send)

        async def send_wrapper(msg):
            if msg["type"] == "http.response.start":
                have = {k.lower() for k, _ in msg.get("headers", [])}
                extra = [(k.lower().encode(), v.encode()) for k, v in SECURITY_HEADERS.items() if k.lower().encode() not in have]
                if path.startswith("/api/") and b"cache-control" not in have:
                    extra.append((b"cache-control", b"no-store"))
                msg = {**msg, "headers": list(msg.get("headers", [])) + extra}
            await send(msg)

        await self.app(scope, receive, send_wrapper)


def create_app(settings: Settings | None = None) -> FastAPI:
    s = settings or Settings()
    app = FastAPI(title="zenvqo chat", version="1.0.0")
    app.state.settings = s
    app.state.db = Database(s.data_dir / "zenvqo.sqlite")
    app.state.limiter = RateLimiter(limit=10, window_s=600)

    app.add_middleware(CORSMiddleware, allow_origins=s.allowed_origins, allow_credentials=True,
                       allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"], allow_headers=["Content-Type", "X-Requested-With"])

    app.add_middleware(GuardMiddleware, allowed_origins=s.allowed_origins)

    for r in (auth.router, conversations.router, chat.router, misc.router):
        app.include_router(r)

    if s.static_dir and Path(s.static_dir).is_dir():
        root = Path(s.static_dir).resolve()

        @app.get("/{path:path}", include_in_schema=False)
        def spa(path: str):
            """Serve the built frontend; unknown paths fall back to index.html (client-side routing)."""
            if path.startswith("api/"):
                return JSONResponse({"detail": "Not found"}, status_code=404)
            f = (root / path).resolve()
            if path and f.is_file() and root in f.parents:
                cache = "public, max-age=31536000, immutable" if "/assets/" in f.as_posix() else "no-cache"
                return FileResponse(f, headers={"Cache-Control": cache})
            return FileResponse(root / "index.html", headers={"Cache-Control": "no-cache"})

    return app

