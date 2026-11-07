"""Runtime configuration from environment variables (prefix ZC_)."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class ModelConfig:
    id: str
    label: str
    provider: str                     # "openai" (any OpenAI-compatible server) | "echo" (demo)
    base_url: str = ""
    model: str = ""
    api_key_env: str = ""             # name of the env var holding the key — keys never live in config files
    vision: bool = False
    context_chars: int = 24000
    tools: bool = False               # server supports OpenAI-style function calling (llama-server --jinja, Gemini, OpenAI)
    description: str = ""


DEFAULT_MODELS = [
    {"id": "zenvqo-local", "label": "zenvqo (local)", "provider": "openai", "base_url": "http://127.0.0.1:8080/v1",
     "model": "local", "description": "Your fine-tuned model via llama-server"},
    {"id": "echo", "label": "Demo (echo)", "provider": "echo", "description": "Offline demo model — echoes with Markdown"},
]


@dataclass
class Settings:
    data_dir: Path = Path(os.environ.get("ZC_DATA_DIR", "data"))
    allowed_origins: list[str] = field(default_factory=lambda: [o for o in os.environ.get(
        "ZC_ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173,http://localhost:8000,http://127.0.0.1:8000").split(",") if o])
    cookie_secure: bool = os.environ.get("ZC_COOKIE_SECURE", "0") == "1"
    session_days: int = int(os.environ.get("ZC_SESSION_DAYS", "14"))
    allow_registration: bool = os.environ.get("ZC_ALLOW_REGISTRATION", "1") == "1"
    max_upload_mb: int = int(os.environ.get("ZC_MAX_UPLOAD_MB", "10"))
    max_files_per_message: int = 5
    static_dir: Path | None = Path(os.environ["ZC_STATIC_DIR"]) if os.environ.get("ZC_STATIC_DIR") else None
    image_router: str = os.environ.get("ZC_IMAGE_ROUTER", "auto")   # auto | rules | llm
    image_providers: str | None = None                              # None = from ZC_IMAGE_PROVIDERS
    echo_delay_s: float = float(os.environ.get("ZC_ECHO_DELAY", "0.02"))
    models: list[ModelConfig] = field(default_factory=lambda: [ModelConfig(**m) for m in json.loads(
        os.environ.get("ZC_MODELS") or json.dumps(DEFAULT_MODELS))])

    def model(self, model_id: str) -> ModelConfig | None:
        return next((m for m in self.models if m.id == model_id), None)
