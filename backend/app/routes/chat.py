"""Streaming chat over Server-Sent Events.

POST /api/conversations/{id}/messages     {"content", "model"?, "file_ids"?}   → text/event-stream
POST /api/conversations/{id}/regenerate                                         → text/event-stream
Events:  meta {user_message, assistant_message} · delta {text} · done {status, title} · error {code, message, retryable}
The assistant row is created as 'streaming' and updated in place. If the client disconnects (Stop button / closed tab),
the generator is cancelled and the partial reply is saved with status 'stopped'.
"""
from __future__ import annotations

import base64
import json
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse

from ..config import Settings
from ..db import Database, new_id, now
from ..deps import current_user, get_db, get_settings
from ..providers import ProviderError, provider_for
from ..schemas import MessageIn
from .conversations import msg_out, owned

router = APIRouter(prefix="/api/conversations", tags=["chat"])
BASE_SYSTEM = "You are zenvqo, a helpful assistant. Use Markdown when it helps (lists, tables, fenced code with a language)."


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def user_settings(db: Database, uid: str) -> dict:
    row = db.one("SELECT data FROM settings WHERE user_id = ?", (uid,))
    return json.loads(row["data"]) if row else {}


def build_messages(db: Database, uid: str, cid: str, s_user: dict, model_cfg, upto_id: str | None = None) -> list[dict]:
    """System prompt + history (newest first until the char budget is used) with attachments inlined."""
    system = BASE_SYSTEM + (("\n\n" + s_user["system_prompt"]) if s_user.get("system_prompt") else "")
    rows = db.all("SELECT * FROM messages WHERE conversation_id = ? AND user_id = ? AND status != 'error' ORDER BY created_at",
                  (cid, uid))
    if upto_id:
        idx = next(i for i, r in enumerate(rows) if r["id"] == upto_id)
        rows = rows[: idx + 1]
    out, used = [], len(system)
    for r in reversed(rows):
        content = r["content"]
        atts = json.loads(r["attachments"])
        images = []
        for a in atts:
            f = db.one("SELECT * FROM files WHERE id = ? AND user_id = ?", (a["id"], uid))
            if not f:
                continue
            if f["kind"] == "image":
                images.append(f)
            elif f["text"]:
                content += f"\n\n<attached_file name=\"{f['name']}\">\n{f['text']}\n</attached_file>"
        if used + len(content) > model_cfg.context_chars and out:
            break
        used += len(content)
        if images and model_cfg.vision:
            parts = [{"type": "text", "text": content}] + [
                {"type": "image_url", "image_url": {"url": f"data:{f['mime']};base64," + base64.b64encode(Path(f['path']).read_bytes()).decode()}}
                for f in images]
            out.append({"role": r["role"], "content": parts})
        else:
            out.append({"role": r["role"], "content": content})
    return [{"role": "system", "content": system}] + out[::-1]


def _stream(db: Database, s: Settings, uid: str, cid: str, model_id: str, user_msg: dict | None, s_user: dict, upto_id: str | None):
    cfg = s.model(model_id)
    provider = provider_for(cfg, s.echo_delay_s)
    msgs = build_messages(db, uid, cid, s_user, cfg, upto_id)          # history first, then the placeholder row
    aid, t = new_id("msg"), now()
    db.run("INSERT INTO messages (id, conversation_id, user_id, role, content, model, status, created_at) "
           "VALUES (?,?,?,?,?,?,?,?)", (aid, cid, uid, "assistant", "", model_id, "streaming", t + 0.001))

    async def gen():
        text, status = "", "streaming"
        yield sse("meta", {"user_message": user_msg, "assistant_message": {"id": aid, "model": model_id}})
        try:
            async for delta in provider.stream(msgs, float(s_user.get("temperature", 0.7))):
                text += delta
                yield sse("delta", {"text": delta})
            status = "complete"
            title = _maybe_title(db, uid, cid)
            yield sse("done", {"status": status, "title": title, "message_id": aid})
        except ProviderError as e:
            status = "error"
            db.run("UPDATE messages SET error = ? WHERE id = ?", (str(e), aid))
            yield sse("error", {"code": e.code, "message": str(e), "retryable": e.retryable, "message_id": aid})
        finally:
            if status == "streaming":
                status = "stopped"                                   # client went away mid-stream
            db.run("UPDATE messages SET content = ?, status = ? WHERE id = ? AND user_id = ?", (text, status, aid, uid))
            db.run("UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?", (now(), cid, uid))

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _maybe_title(db: Database, uid: str, cid: str) -> str | None:
    c = db.one("SELECT title FROM conversations WHERE id = ? AND user_id = ?", (cid, uid))
    if c and c["title"] == "New chat":
        first = db.one("SELECT content FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY created_at LIMIT 1", (cid,))
        if first:
            words = " ".join(first["content"].split())
            title = words[:60].rsplit(" ", 1)[0] + "…" if len(words) > 60 else words
            db.run("UPDATE conversations SET title = ? WHERE id = ? AND user_id = ?", (title, cid, uid))
            return title
    return None


@router.post("/{cid}/messages")
def send(cid: str, body: MessageIn, user: dict = Depends(current_user), db: Database = Depends(get_db),
         s: Settings = Depends(get_settings)):
    conv = owned(db, cid, user["id"])
    model_id = body.model or conv["model"]
    cfg = s.model(model_id)
    if not cfg:
        raise HTTPException(400, "Unknown model.")
    atts = []
    for fid in dict.fromkeys(body.file_ids):
        f = db.one("SELECT id, name, mime, size, kind FROM files WHERE id = ? AND user_id = ?", (fid, user["id"]))
        if not f:
            raise HTTPException(400, "An attached file was not found. Remove it and try again.")
        if f["kind"] == "image" and not cfg.vision:
            raise HTTPException(400, f"“{cfg.label}” can't read images. Choose a vision model or remove the image.")
        atts.append(f)
    if model_id != conv["model"]:
        db.run("UPDATE conversations SET model = ? WHERE id = ? AND user_id = ?", (model_id, cid, user["id"]))
    mid = new_id("msg")
    db.run("INSERT INTO messages (id, conversation_id, user_id, role, content, model, status, attachments, created_at) "
           "VALUES (?,?,?,?,?,?,?,?,?)", (mid, cid, user["id"], "user", body.content, None, "complete", json.dumps(atts), now()))
    user_msg = msg_out(db.one("SELECT * FROM messages WHERE id = ?", (mid,)))
    return _stream(db, s, user["id"], cid, model_id, user_msg, user_settings(db, user["id"]), None)


@router.post("/{cid}/regenerate")
def regenerate(cid: str, user: dict = Depends(current_user), db: Database = Depends(get_db), s: Settings = Depends(get_settings)):
    """Replace the last assistant reply (or answer an unanswered/failed last user message)."""
    conv = owned(db, cid, user["id"])
    rows = db.all("SELECT id, role FROM messages WHERE conversation_id = ? AND user_id = ? ORDER BY created_at", (cid, user["id"]))
    while rows and rows[-1]["role"] == "assistant":
        db.run("DELETE FROM messages WHERE id = ? AND user_id = ?", (rows.pop()["id"], user["id"]))
    if not rows:
        raise HTTPException(400, "Nothing to regenerate.")
    if not s.model(conv["model"]):
        raise HTTPException(400, "Unknown model.")
    return _stream(db, s, user["id"], cid, conv["model"], None, user_settings(db, user["id"]), rows[-1]["id"])
