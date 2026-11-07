# zenvqo chat: a responsive AI chat web app (React + FastAPI)

**Three ways to run it:**

| | What it is | Login & history |
|---|---|---|
| **Web app** (`backend/` + `frontend/`) | FastAPI server + React UI, multi-user | accounts, history in SQLite on the server |
| **Single HTML file** (`frontend/dist-standalone/zenvqo-chat.html`) | the same UI in one offline file; open it in any browser | no login, history saved in that browser |
| **Android app** (`android/`) | that HTML file inside a native WebView app; the APK is built by GitHub Actions | no login, history saved on the phone |

The HTML file and the APK talk **directly** to an OpenAI-compatible server such as llama-server on your laptop (set it in Settings → Connection), or use the built-in offline demo model. Rebuild the HTML with `cd frontend && npm run build:standalone`; this also copies it into the Android app. The APK steps are in [android/README.md](android/README.md).

A web chat app for your zenvqo model, built with a React + TypeScript frontend and a FastAPI backend. It has:

- **Chat:** streaming replies, saved and searchable conversation history, model selection.
- **Rendering:** sanitised Markdown with highlighted code blocks.
- **Accounts:** sign-in and per-user settings.
- **Files:** uploads of text, code, PDF and images.
- **Quality:** accessibility, mobile layout, and error and loading states throughout.

It talks to any **OpenAI-compatible** model server: llama-server running your fine-tuned zenvqo, the zenvqo-vision model, Ollama, or vLLM. It also includes an offline **demo model** so the whole app works without one.

```
backend/                     FastAPI · SQLite · server-side sessions · SSE streaming
  app/main.py                app factory, CORS, CSRF/security-header ASGI middleware, SPA serving
  app/routes/auth.py         register · login · logout · me (scrypt hashes, httpOnly cookie, rate limiting)
  app/routes/conversations.py list/search/page · create · rename · pin · switch model · delete
  app/routes/chat.py         send message / regenerate → text/event-stream; stop = client disconnect
  app/routes/misc.py         uploads (type sniffing, PDF text extraction) · downloads · settings · models · health
  app/providers.py           OpenAI-compatible streaming client + demo "echo" provider
  tests/test_api.py          22 tests
frontend/                    React 19 + TypeScript + Vite, no UI framework, ~125 KB gzipped JS
  src/api/                   typed client, SSE-over-fetch parser, upload with progress
  src/components/            AuthPage · Sidebar · ChatView · MessageView · Markdown · Composer · Dialogs · Icon
  src/state/                 session (auth, settings, models) · toasts
  src/lib/                   markdown (marked + highlight.js + DOMPurify) · formatting · tiny router
  src/**/*.test.ts           9 unit tests (node:test)
e2e/test_app.py              9 Playwright browser tests (desktop + mobile), screenshots in e2e/screenshots/
tools/fastapi_offline_shim/  dev-only stand-in used where FastAPI couldn't be installed (see "Verification")
```

## Setup

### 1. Backend (Python 3.11+)
```bash
cd backend
python -m venv .venv && source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env && export $(grep -v '^#' .env | xargs)
uvicorn app.main:create_app --factory --reload --port 8000
```

### 2. Frontend (Node 20+)
```bash
cd frontend
npm install
npm run dev                         # http://localhost:5173 — Vite proxies /api to :8000
```
Open http://localhost:5173 and create an account. Pick **Demo (echo)** to try the app without a model server:
- Ask for "code" or a "table" to see them rendered.
- Type `[fail]` to see the error state.

### 3. Connect your model
Point `ZC_MODELS` at your servers (`.env.example` has a full example):
```bash
llama-server -m zenvqo-q4_k_m.gguf --port 8080              # your fine-tuned model
ZC_MODELS='[{"id":"zenvqo-local","label":"zenvqo (local)","provider":"openai","base_url":"http://127.0.0.1:8080/v1","model":"local"}]'
```
- **Image models:** set `"vision": true` on models that accept images, such as the zenvqo-vision llama-server. Images sent to other models are refused with a clear message.
- **Hosted APIs:** set `"api_key_env": "OPENAI_API_KEY"`. The key is read from that environment variable and never stored in config or sent to the browser.

### 4. Production (single process, behind HTTPS)
```bash
cd frontend && npm run build && cd ../backend
ZC_STATIC_DIR=../frontend/dist ZC_COOKIE_SECURE=1 ZC_ALLOWED_ORIGINS=https://chat.example.com ZC_ALLOW_REGISTRATION=0 \
  uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8000 --workers 1
```
- **Reverse proxy:** put Caddy or nginx in front for TLS. In nginx, disable buffering for streaming: `proxy_buffering off; proxy_read_timeout 300s;`. The API also sends `X-Accel-Buffering: no`.
- **Workers:** SQLite plus one worker is right for a personal or small-team deployment. For more traffic, move `db.py` to Postgres.

## Features

| Area | Details |
|---|---|
| **Streaming** | SSE over `fetch` (POST + `ReadableStream`; `EventSource` can't POST). Tokens are batched per animation frame, so long replies stay smooth on phones. **Stop** = abort; the server saves the partial reply as `stopped`. Regenerate / Retry replaces the last reply. |
| **History** | Grouped Pinned / Today / Yesterday / 7 days / 30 days / Older. Search covers titles and message text (wildcards escaped). Rename inline, pin, delete with confirmation. Conversations auto-title from the first message. Each chat has its own URL (`/c/:id`) with back/forward support. |
| **Markdown** | GFM: tables (scroll sideways on phones), lists, quotes, inline code. Fenced code shows a language label, highlighting for 15 common languages, and a **Copy** button. Output passes through DOMPurify: no scripts or event handlers, `javascript:` links removed, links open in a new tab with `noopener`. |
| **Uploads** | Button, drag-and-drop or paste. Up to 5 files of 10 MB each, with a progress bar per file and per-file errors. The type is detected from the file's content, not its extension. Text, code and CSV/JSON are inlined into the prompt; PDF text is extracted (scanned PDFs get a clear message); images go only to vision models. Files are stored under random ids and only their owner can download them. |
| **Models** | A native `<select>` (accessible, and the best picker on phones), one model per conversation. Switching mid-chat is allowed. The default model is a user setting. |
| **Login** | Email + password (scrypt). Server-side sessions in an httpOnly, SameSite=Lax cookie (Secure in production), so no token is readable from JavaScript. 10 attempts per 10 min per IP and per email. Error messages don't reveal which emails have accounts. Registration can be turned off. |
| **Settings** | Theme (system/light/dark, applied before first paint), text size, default model, temperature, custom instructions (system prompt), Enter-to-send vs Ctrl/⌘+Enter, message times. |
| **Accessibility** | See the next section. |
| **Mobile** | Below 900 px the sidebar becomes a slide-in drawer (Esc or a tap outside closes it). Uses `100dvh` and safe-area insets. Touch targets are at least 44 px. The composer stays above the keyboard, and nothing scrolls sideways (tested). |
| **Errors / loading** | Skeletons for the conversation list and thread. Typing indicator and streaming cursor. Inline error with Retry on failed replies. Toasts for action failures. Offline banner. A "server unreachable" screen with retry. A 404 page for deleted chats. If the server rejects a message (e.g. image to a text model), the draft is kept. Uploads that are still running block sending. |

### Accessibility

- **Structure:** landmarks (`nav`, `main`, `role=log`), and a skip link to the message box. Every control has an accessible name (tested).
- **Live announcements:** replies are announced politely ("responding…", "complete", "failed: …") instead of reading every token aloud. Errors are announced assertively.
- **Dialogs:** native `<dialog>` with focus trap, Esc to close, and focus returned to the opener.
- **Keyboard and visibility:** visible focus rings, plus `prefers-reduced-motion` and `forced-colors` support. Hover-only actions stay in the accessibility tree.
- **Text entry:** IME composition is respected, so Hindi transliteration keyboards don't send mid-word.

## API

All endpoints are under `/api`.
- **Errors** are `{"detail": "..."}` in FastAPI's format; the client maps them to readable messages.
- **Mutations** require `X-Requested-With: zenvqo`, the CSRF guard. Requests from foreign `Origin`s are rejected.

| Method | Path | |
|---|---|---|
| POST | `/auth/register` `/auth/login` `/auth/logout` · GET `/auth/me` | session cookie |
| GET | `/conversations?q=&limit=&before=` | `{items, has_more}` |
| POST · GET · PATCH · DELETE | `/conversations` · `/conversations/{id}` | PATCH: `title`, `pinned`, `model` |
| POST | `/conversations/{id}/messages` `{content, model?, file_ids?}` | **SSE**: `meta` → `delta`* → `done {title}` or `error {code, message, retryable}` |
| POST | `/conversations/{id}/regenerate` | SSE, same events |
| POST · GET · DELETE | `/files` (multipart `file`) · `/files/{id}` | owner only |
| GET · PUT | `/settings` | validated (unknown fields rejected) |
| GET | `/models` · `/health` | model list exposes no server URLs |

## Tests

```bash
cd backend && pytest                                    # 22 API tests
cd frontend && npm test                                 # 9 unit tests: SSE parser, client errors, grouping, routing
cd frontend && npm run build && cd .. && pip install playwright && python -m playwright install chromium
python -m pytest e2e -v                                 # 9 browser tests, desktop + mobile, writes screenshots
```

**Backend coverage:**
- Auth and cookie flags, logout invalidating the session, no account enumeration, rate limiting.
- CSRF and origin checks, security headers.
- Cross-user isolation on every endpoint (returns 404).
- The SSE event order, persistence and auto-title; history sent to the model.
- Mid-stream provider errors, stop saving a partial reply, regenerate.
- Vision gating; the OpenAI-compatible provider against a fake upstream, including an unreachable server.
- Upload sniffing, limits and PDF extraction; settings validation; SPA fallback and path traversal.

**Browser coverage:**
- Sign-in errors.
- Streaming Markdown with highlighted code, a table and copy-to-clipboard; Esc-to-stop with the partial reply saved; regenerate; error and Retry states.
- Uploads, including rejected types and an image sent to a text model.
- XSS payloads neutralised.
- Rename, pin, search, delete; settings persistence; keyboard flows.
- A basic accessibility audit; the mobile drawer and overflow checks.

## Verification done here, and its limits

- **Results:** all **22 backend, 9 unit and 9 browser tests pass**. The browser suite was run twice in a row to check for flakiness.
- **FastAPI wasn't installed here.** The workspace had no network access and no FastAPI, though it had Starlette (which FastAPI is built on), uvicorn and Pydantic. The backend tests and browser tests ran against `tools/fastapi_offline_shim/`, which implements only the FastAPI features this app uses. The app code imports `fastapi` normally. **Run `pip install -r backend/requirements.txt && pytest` once on your machine** to confirm against real FastAPI; the shim is only used when `import fastapi` fails. The shim's dependency order and error format follow FastAPI's documented behaviour, but small differences are possible.
- **The bundle tested here was built with esbuild** (`frontend/scripts/build-offline.mjs`) from the same source, because Vite couldn't be installed. `npm run build` (Vite) is the normal path.
- **Type-checking:** `tsc` was run here only on the non-React modules, since React's type definitions were unavailable. Run `npm run typecheck` after `npm install`.
- **Not tested:** real LLM servers (only a fake OpenAI-compatible upstream), Safari/Firefox, real phones, and screen readers. The accessibility checks are automated smoke tests; do a manual pass with NVDA or VoiceOver before launch.

Bugs these tests caught and fixed during the build:
- The first message of a new chat was aborted when the URL changed.
- The composer kept the sent text until the reply finished, and could wipe a newly attached file.
- "Saved" in Settings disappeared immediately.
- Hover-only conversation actions were missing from the accessibility tree.
- The temperature label was associated with the wrong element.
