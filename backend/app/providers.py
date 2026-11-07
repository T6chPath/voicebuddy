"""Model providers. Each yields text deltas asynchronously and raises ProviderError with a user-safe message."""
from __future__ import annotations

import asyncio
import json
import os
from typing import AsyncIterator

from .config import ModelConfig


class ProviderError(RuntimeError):
    def __init__(self, message: str, code: str = "provider_error", retryable: bool = True):
        super().__init__(message)
        self.code, self.retryable = code, retryable


class OpenAICompatProvider:
    """Any /v1/chat/completions server with stream=true: llama-server (zenvqo's local model), Ollama, vLLM, OpenAI."""

    def __init__(self, cfg: ModelConfig, timeout: float = 120.0):
        self.cfg, self.timeout = cfg, timeout

    async def stream(self, messages: list[dict], temperature: float) -> AsyncIterator[str]:
        async for kind, val in self.events(messages, temperature):
            if kind == "text":
                yield val

    async def events(self, messages: list[dict], temperature: float, tools: list | None = None) -> AsyncIterator[tuple[str, object]]:
        """Yields ("text", delta) while streaming, then ("tool_calls", [{name, arguments}]) if the model called tools."""
        import httpx
        headers = {"Content-Type": "application/json"}
        if self.cfg.api_key_env and os.environ.get(self.cfg.api_key_env):
            headers["Authorization"] = f"Bearer {os.environ[self.cfg.api_key_env]}"
        body = {"model": self.cfg.model, "messages": messages, "stream": True, "temperature": temperature}
        if tools:
            body["tools"], body["tool_choice"] = tools, "auto"
        calls: dict[int, dict] = {}
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(self.timeout, connect=5.0)) as client:
                async with client.stream("POST", self.cfg.base_url.rstrip("/") + "/chat/completions",
                                         headers=headers, json=body) as r:
                    if r.status_code == 401:
                        raise ProviderError("The model server rejected the API key.", "auth", False)
                    if r.status_code == 429:
                        raise ProviderError("The model is busy (rate limited). Try again shortly.", "rate_limited")
                    if r.status_code >= 400:
                        if tools and r.status_code in (400, 404, 422, 500, 501):
                            raise ProviderError("This model server doesn't support tool calling.", "tools_unsupported", False)
                        raise ProviderError(f"The model server returned an error ({r.status_code}).")
                    async for line in r.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            break
                        try:
                            delta = json.loads(data)["choices"][0].get("delta", {})
                        except (json.JSONDecodeError, KeyError, IndexError, TypeError):
                            continue
                        if delta.get("content"):
                            yield "text", delta["content"]
                        for tc in delta.get("tool_calls") or []:
                            slot = calls.setdefault(int(tc.get("index", 0)), {"id": "", "name": "", "arguments": ""})
                            slot["id"] = tc.get("id") or slot["id"]
                            fn = tc.get("function") or {}
                            slot["name"] += fn.get("name") or ""
                            slot["arguments"] += fn.get("arguments") or ""
            if calls:
                yield "tool_calls", [calls[k] for k in sorted(calls)]
        except httpx.ConnectError as e:
            raise ProviderError(f"Can't reach the model server for “{self.cfg.label}”. Is it running?", "unreachable") from e
        except httpx.TimeoutException as e:
            raise ProviderError("The model took too long to respond.", "timeout") from e
        except httpx.HTTPError as e:
            raise ProviderError("Connection to the model was interrupted.", "network") from e


class EchoProvider:
    """Offline demo: streams a Markdown reply. '[fail]' in the prompt triggers a mid-stream error (for testing)."""

    def __init__(self, cfg: ModelConfig, delay_s: float = 0.02):
        self.cfg, self.delay = cfg, delay_s

    async def events(self, messages: list[dict], temperature: float, tools: list | None = None):
        async for t in self.stream(messages, temperature):
            yield "text", t

    async def stream(self, messages: list[dict], temperature: float) -> AsyncIterator[str]:
        last = next((m for m in reversed(messages) if m["role"] == "user"), messages[-1])["content"]
        if isinstance(last, list):
            last = " ".join(p.get("text", "") for p in last if isinstance(p, dict))
        question = last.split("\n\n<attached_file", 1)[0].strip()
        n_files = last.count("<attached_file")
        parts = [f"You said: **{question[:300]}**\n\n"]
        if n_files:
            parts.append(f"I can see {n_files} attached file(s). First line: `{_first_line(last)}`\n\n")
        if "code" in question.lower():
            parts.append("Here's an example:\n\n```python\ndef greet(name: str) -> str:\n    return f\"Namaste, {name}!\"\n\nprint(greet(\"zenvqo\"))\n```\n\n")
        if "pdf" in question.lower():
            n = min(30, max(1, int(next(iter(__import__("re").findall(r"\b(\d{1,2})\b", question)), 10))))
            qs = ["What is the SI unit of force? (a) Joule (b) Newton (c) Watt (d) Pascal",
                  "Solve for $x$: $2x + 6 = 14$. (a) $3$ (b) $4$ (c) $5$ (d) $10$",
                  "भारत की राजधानी क्या है? (a) मुंबई (b) नई दिल्ली (c) कोलकाता (d) चेन्नई"]
            parts.append(f"# Practice Quiz ({n} questions)\n\n" + "\n".join(f"{i + 1}. {qs[i % 3]}" for i in range(n)) + "\n\n")
        elif any(w in question.lower() for w in ("math", "equation", "formula", "maths", "ganit")):
            parts.append("Inline math looks like $E = mc^2$ or $a^2 + b^2 = c^2$, and a displayed equation like this:\n\n"
                         "$$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$\n\n"
                         "$$\\int_0^1 x^2\\,dx = \\frac{1}{3} \\qquad \\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}$$\n\n")
        if "table" in question.lower():
            parts.append("| Model | Size |\n|---|---|\n| zenvqo | 3B |\n| echo | 0B |\n\n")
        earlier = sum(1 for m in messages[:-1] if m["role"] != "system")
        parts.append(f"(_demo model — {earlier} earlier message(s) in context, temperature {temperature}_)")
        text = "".join(parts)
        for i, tok in enumerate(_tokens(text)):
            if "[fail]" in question and i == 6:
                raise ProviderError("The demo model failed on purpose ([fail] in your message).", "demo_failure")
            await asyncio.sleep(self.delay)
            yield tok


def _tokens(text: str):
    word = ""
    for ch in text:
        word += ch
        if ch in " \n":
            yield word
            word = ""
    if word:
        yield word


def _first_line(text: str) -> str:
    try:
        body = text.split("<attached_file", 1)[1].split(">", 1)[1].strip().splitlines()[0]
        return body[:80].replace("`", "'")
    except IndexError:
        return ""


def provider_for(cfg: ModelConfig, echo_delay: float = 0.02):
    if cfg.provider == "echo":
        return EchoProvider(cfg, echo_delay)
    if cfg.provider == "openai":
        return OpenAICompatProvider(cfg)
    raise ProviderError(f"Unknown provider {cfg.provider}", "config", False)
