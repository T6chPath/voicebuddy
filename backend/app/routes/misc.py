"""Files, settings, models, health."""
from __future__ import annotations

import json
from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile

from ..config import Settings
from ..db import Database, new_id, now
from ..deps import current_user, get_db, get_settings
from ..files import UploadRejected, extract_text, safe_name, sniff, store
from ..schemas import SettingsIn

router = APIRouter(prefix="/api", tags=["misc"])


@router.get("/health")
def health():
    return {"ok": True}


@router.get("/models")
def models(user: dict = Depends(current_user), s: Settings = Depends(get_settings)):
    return {"items": [{"id": m.id, "label": m.label, "vision": m.vision, "description": m.description} for m in s.models]}


@router.get("/settings")
def get_user_settings(user: dict = Depends(current_user), db: Database = Depends(get_db), s: Settings = Depends(get_settings)):
    row = db.one("SELECT data FROM settings WHERE user_id = ?", (user["id"],))
    data = SettingsIn(**(json.loads(row["data"]) if row else {})).model_dump()
    if not s.model(data["default_model"]):
        data["default_model"] = s.models[0].id
    return data


@router.put("/settings")
def put_user_settings(body: SettingsIn, user: dict = Depends(current_user), db: Database = Depends(get_db),
                      s: Settings = Depends(get_settings)):
    if not s.model(body.default_model):
        raise HTTPException(400, "Unknown model.")
    db.run("INSERT INTO settings VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data",
           (user["id"], json.dumps(body.model_dump())))
    return body.model_dump()


@router.post("/files", status_code=201)
async def upload(file: UploadFile = File(...), user: dict = Depends(current_user), db: Database = Depends(get_db),
                 s: Settings = Depends(get_settings)):
    limit = s.max_upload_mb * 1024 * 1024
    data = await file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(413, f"File is larger than {s.max_upload_mb} MB.")
    if not data:
        raise HTTPException(400, "The file is empty.")
    name = safe_name(file.filename or "file")
    try:
        kind, mime = sniff(data, name)
        text = extract_text(data, kind, mime)
    except UploadRejected as e:
        raise HTTPException(415, str(e)) from e
    fid = new_id("fil")
    path = store(s.data_dir, user["id"], fid, data)
    db.run("INSERT INTO files VALUES (?,?,?,?,?,?,?,?,?)", (fid, user["id"], name, mime, len(data), kind, path, text, now()))
    return {"id": fid, "name": name, "mime": mime, "size": len(data), "kind": kind,
            "chars": len(text) if text else 0, "truncated": bool(text and len(text) >= 60_000)}


@router.get("/files/{fid}")
def download(fid: str, user: dict = Depends(current_user), db: Database = Depends(get_db)):
    f = db.one("SELECT * FROM files WHERE id = ? AND user_id = ?", (fid, user["id"]))
    if not f:
        raise HTTPException(404, "File not found.")
    disp = "inline" if f["kind"] == "image" else "attachment"
    quoted = f["name"].encode("ascii", "replace").decode().replace('"', "'")
    return Response(Path(f["path"]).read_bytes(), media_type=f["mime"],
                    headers={"Content-Disposition": f'{disp}; filename="{quoted}"', "Cache-Control": "private, max-age=3600"})


@router.delete("/files/{fid}", status_code=204)
def delete_file(fid: str, user: dict = Depends(current_user), db: Database = Depends(get_db)):
    f = db.one("SELECT * FROM files WHERE id = ? AND user_id = ?", (fid, user["id"]))
    if not f:
        raise HTTPException(404, "File not found.")
    Path(f["path"]).unlink(missing_ok=True)
    db.run("DELETE FROM files WHERE id = ? AND user_id = ?", (fid, user["id"]))
    return Response(status_code=204)
