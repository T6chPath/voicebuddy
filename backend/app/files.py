"""Upload validation, storage and text extraction.

Type comes from content sniffing, not the browser's MIME or the filename. Files are stored under a random id (never the
user's filename) outside any static directory, and served back only to their owner as attachments with nosniff."""
from __future__ import annotations

import io
import json
import re
import unicodedata
from pathlib import Path

TEXT_EXT = {".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".py", ".js", ".ts", ".tsx", ".jsx", ".html", ".css",
            ".sql", ".yaml", ".yml", ".toml", ".xml", ".log", ".java", ".kt", ".c", ".cpp", ".h", ".go", ".rs", ".sh"}
IMAGE_MAGIC = [(b"\x89PNG\r\n\x1a\n", "image/png"), (b"\xff\xd8\xff", "image/jpeg"), (b"GIF87a", "image/gif"), (b"GIF89a", "image/gif")]
MAX_TEXT_CHARS = 60_000


class UploadRejected(ValueError):
    pass


def safe_name(name: str) -> str:
    name = unicodedata.normalize("NFC", Path(name or "file").name)
    name = re.sub(r"[\x00-\x1f\x7f/\\:*?\"<>|]", "_", name).strip(" .") or "file"
    return name[:120]


def sniff(data: bytes, name: str) -> tuple[str, str]:
    """→ (kind, mime). kind ∈ text | pdf | image."""
    for magic, mime in IMAGE_MAGIC:
        if data.startswith(magic):
            return "image", mime
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image", "image/webp"
    if data.startswith(b"%PDF-"):
        return "pdf", "application/pdf"
    ext = Path(name).suffix.lower()
    if ext in TEXT_EXT or ext == "":
        if b"\x00" in data[:8192]:
            raise UploadRejected("This looks like a binary file, not text.")
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            try:
                data.decode("utf-16")
            except UnicodeDecodeError as e:
                raise UploadRejected("Text files must be UTF-8.") from e
        mime = {".json": "application/json", ".csv": "text/csv", ".md": "text/markdown"}.get(ext, "text/plain")
        return "text", mime
    raise UploadRejected("Unsupported file type. Upload text, code, CSV/JSON, PDF or PNG/JPEG/WebP/GIF images.")


def extract_text(data: bytes, kind: str, mime: str) -> str | None:
    if kind == "text":
        try:
            t = data.decode("utf-8")
        except UnicodeDecodeError:
            t = data.decode("utf-16", errors="replace")
        if mime == "application/json":
            try:
                t = json.dumps(json.loads(t), indent=1, ensure_ascii=False)
            except json.JSONDecodeError:
                pass
        return t[:MAX_TEXT_CHARS]
    if kind == "pdf":
        try:
            from pypdf import PdfReader
            r = PdfReader(io.BytesIO(data))
            if r.is_encrypted:
                raise UploadRejected("Password-protected PDFs aren't supported.")
            out = []
            for i, p in enumerate(r.pages[:50]):
                out.append(f"[page {i + 1}]\n" + (p.extract_text() or ""))
                if sum(len(x) for x in out) > MAX_TEXT_CHARS:
                    break
            t = "\n\n".join(out)[:MAX_TEXT_CHARS]
            if not t.replace("[page", "").strip(" \n0123456789]"):
                raise UploadRejected("This PDF has no extractable text (it may be a scan).")
            return t
        except UploadRejected:
            raise
        except ImportError:
            return None
        except Exception as e:
            raise UploadRejected("Couldn't read this PDF.") from e
    return None


def store(base: Path, user_id: str, file_id: str, data: bytes) -> str:
    d = base / "uploads" / user_id
    d.mkdir(parents=True, exist_ok=True)
    p = d / file_id
    p.write_bytes(data)
    p.chmod(0o600)
    return str(p)
