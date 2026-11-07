"""Passwords (scrypt), server-side sessions, login rate limiting, CSRF/origin checks, security headers."""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import threading
import time
from collections import defaultdict, deque

SCRYPT = {"n": 2 ** 14, "r": 8, "p": 1}          # ~16 MB, ~50 ms on a laptop core
COOKIE = "zc_session"


def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(pw.encode(), salt=salt, dklen=32, **SCRYPT)
    return "scrypt$%d$%d$%d$%s$%s" % (SCRYPT["n"], SCRYPT["r"], SCRYPT["p"], base64.b64encode(salt).decode(), base64.b64encode(dk).decode())


def verify_password(pw: str, stored: str) -> bool:
    try:
        _, n, r, p, salt, dk = stored.split("$")
        got = hashlib.scrypt(pw.encode(), salt=base64.b64decode(salt), dklen=32, n=int(n), r=int(r), p=int(p))
        return hmac.compare_digest(got, base64.b64decode(dk))
    except (ValueError, TypeError):
        return False


DUMMY_HASH = hash_password(secrets.token_hex(8))  # equalises timing for unknown emails


def new_session_token() -> tuple[str, str]:
    tok = secrets.token_urlsafe(32)
    return tok, token_hash(tok)


def token_hash(tok: str) -> str:
    return hashlib.sha256(tok.encode()).hexdigest()


class RateLimiter:
    """Sliding window per key (IP and email separately) — slows password guessing without locking real users out."""

    def __init__(self, limit: int = 10, window_s: float = 600):
        self.limit, self.window = limit, window_s
        self.hits: dict[str, deque] = defaultdict(deque)
        self.lock = threading.Lock()

    def check(self, *keys: str) -> float:
        """0 if allowed, else seconds until retry. Counts the attempt when allowed."""
        now = time.monotonic()
        with self.lock:
            for k in keys:
                q = self.hits[k]
                while q and now - q[0] > self.window:
                    q.popleft()
                if len(q) >= self.limit:
                    return round(self.window - (now - q[0]), 1)
            for k in keys:
                self.hits[k].append(now)
        return 0.0

    def reset(self, *keys: str):
        with self.lock:
            for k in keys:
                self.hits.pop(k, None)


UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}


def csrf_ok(method: str, headers, allowed_origins: list[str]) -> bool:
    """Cookie auth + SameSite=Lax already blocks cross-site form posts. We additionally require (a) a custom header,
    which a cross-origin page cannot send without passing CORS preflight, and (b) a matching Origin when present."""
    if method not in UNSAFE:
        return True
    if headers.get("x-requested-with") != "zenvqo":
        return False
    origin = headers.get("origin")
    return origin is None or origin in allowed_origins


SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(self), geolocation=()",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; "
                               "script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
}
