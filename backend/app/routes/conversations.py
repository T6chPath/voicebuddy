from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Response

from ..config import Settings
from ..db import Database, new_id, now
from ..deps import current_user, get_db, get_settings
from ..schemas import ConversationIn, ConversationPatch

router = APIRouter(prefix="/api/conversations", tags=["conversations"])


def owned(db: Database, cid: str, uid: str) -> dict:
    c = db.one("SELECT * FROM conversations WHERE id = ? AND user_id = ?", (cid, uid))
    if not c:
        raise HTTPException(404, "Conversation not found.")      # same answer for "missing" and "someone else's"
    return c


def conv_out(c: dict) -> dict:
    return {"id": c["id"], "title": c["title"], "model": c["model"], "pinned": bool(c["pinned"]),
            "created_at": c["created_at"], "updated_at": c["updated_at"]}


def msg_out(m: dict) -> dict:
    return {"id": m["id"], "role": m["role"], "content": m["content"], "model": m["model"], "status": m["status"],
            "error": m["error"], "attachments": json.loads(m["attachments"]), "created_at": m["created_at"]}


@router.get("")
def list_conversations(q: str = "", limit: int = 50, before: float | None = None, user: dict = Depends(current_user),
                       db: Database = Depends(get_db)):
    limit = max(1, min(100, limit))
    sql = "SELECT * FROM conversations WHERE user_id = ?"
    args: list = [user["id"]]
    if q:
        like = "%" + q.replace("%", r"\%").replace("_", r"\_")[:100] + "%"
        sql += (r" AND (title LIKE ? ESCAPE '\' OR id IN (SELECT conversation_id FROM messages WHERE user_id = ? "
                r"AND content LIKE ? ESCAPE '\'))")
        args += [like, user["id"], like]
    if before is not None:
        sql += " AND updated_at < ?"
        args.append(before)
    sql += " ORDER BY pinned DESC, updated_at DESC LIMIT ?"
    rows = db.all(sql, (*args, limit + 1))
    return {"items": [conv_out(c) for c in rows[:limit]], "has_more": len(rows) > limit}


@router.post("", status_code=201)
def create(body: ConversationIn, user: dict = Depends(current_user), db: Database = Depends(get_db),
           s: Settings = Depends(get_settings)):
    model = body.model or _default_model(db, user["id"], s)
    if not s.model(model):
        raise HTTPException(400, "Unknown model.")
    cid, t = new_id("cnv"), now()
    db.run("INSERT INTO conversations VALUES (?,?,?,?,0,?,?)", (cid, user["id"], body.title or "New chat", model, t, t))
    return conv_out(owned(db, cid, user["id"]))


@router.get("/{cid}")
def get(cid: str, user: dict = Depends(current_user), db: Database = Depends(get_db)):
    c = owned(db, cid, user["id"])
    msgs = db.all("SELECT * FROM messages WHERE conversation_id = ? AND user_id = ? ORDER BY created_at", (cid, user["id"]))
    return {**conv_out(c), "messages": [msg_out(m) for m in msgs]}


@router.patch("/{cid}")
def patch(cid: str, body: ConversationPatch, user: dict = Depends(current_user), db: Database = Depends(get_db),
          s: Settings = Depends(get_settings)):
    owned(db, cid, user["id"])
    if body.model is not None and not s.model(body.model):
        raise HTTPException(400, "Unknown model.")
    for field, val in (("title", body.title), ("pinned", None if body.pinned is None else int(body.pinned)), ("model", body.model)):
        if val is not None:
            db.run(f"UPDATE conversations SET {field} = ? WHERE id = ? AND user_id = ?", (val, cid, user["id"]))
    return conv_out(owned(db, cid, user["id"]))


@router.delete("/{cid}", status_code=204)
def delete(cid: str, user: dict = Depends(current_user), db: Database = Depends(get_db)):
    owned(db, cid, user["id"])
    db.run("DELETE FROM conversations WHERE id = ? AND user_id = ?", (cid, user["id"]))
    return Response(status_code=204)


def _default_model(db: Database, uid: str, s: Settings) -> str:
    row = db.one("SELECT data FROM settings WHERE user_id = ?", (uid,))
    m = json.loads(row["data"]).get("default_model") if row else None
    return m if m and s.model(m) else s.models[0].id
