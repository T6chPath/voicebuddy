"""SQLite storage (stdlib sqlite3, WAL). One connection per thread; every query that touches user data is scoped
by user_id in the WHERE clause — the route layer never fetches a row by id alone."""
from __future__ import annotations

import sqlite3
import threading
import time
import uuid
from pathlib import Path

SCHEMA = """
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL,
  created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at REAL NOT NULL, expires_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL,
  model TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL, updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS conv_user ON conversations(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL, role TEXT NOT NULL CHECK (role IN ('user','assistant')), content TEXT NOT NULL,
  model TEXT, status TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete','streaming','stopped','error')),
  error TEXT, attachments TEXT NOT NULL DEFAULT '[]', created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS msg_conv ON messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
  mime TEXT NOT NULL, size INTEGER NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL, text TEXT,
  created_at REAL NOT NULL
);
"""


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def now() -> float:
    return time.time()


class Database:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        self.conn().executescript(SCHEMA)
        cols = {r["name"] for r in self.all("PRAGMA table_info(messages)")}
        if "meta" not in cols:                                     # added for image tools; older DBs get it here
            self.conn().execute("ALTER TABLE messages ADD COLUMN meta TEXT NOT NULL DEFAULT '{}'")

    def conn(self) -> sqlite3.Connection:
        c = getattr(self._local, "c", None)
        if c is None:
            c = sqlite3.connect(self.path, timeout=10, isolation_level=None, check_same_thread=False)
            c.row_factory = sqlite3.Row
            c.execute("PRAGMA foreign_keys = ON")
            c.execute("PRAGMA busy_timeout = 5000")
            self._local.c = c
        return c

    def one(self, sql: str, args: tuple = ()) -> dict | None:
        r = self.conn().execute(sql, args).fetchone()
        return dict(r) if r else None

    def all(self, sql: str, args: tuple = ()) -> list[dict]:
        return [dict(r) for r in self.conn().execute(sql, args).fetchall()]

    def run(self, sql: str, args: tuple = ()) -> int:
        return self.conn().execute(sql, args).rowcount
