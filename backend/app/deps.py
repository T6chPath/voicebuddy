from __future__ import annotations

from fastapi import Depends, HTTPException, Request, status

from .config import Settings
from .db import Database, now
from .security import COOKIE, token_hash


def get_db(request: Request) -> Database:
    return request.app.state.db


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def current_user(request: Request, db: Database = Depends(get_db)) -> dict:
    tok = request.cookies.get(COOKIE)
    if tok:
        row = db.one("SELECT u.id, u.email, u.name, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id "
                     "WHERE s.token_hash = ?", (token_hash(tok),))
        if row and row["expires_at"] > now():
            return {"id": row["id"], "email": row["email"], "name": row["name"]}
    raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Please sign in.")
