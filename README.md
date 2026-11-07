# zenvqo chat: a responsive AI chat web app (React + FastAPI)

**Three ways to run it:**

| | What it is | Login & history |
|---|---|---|
| **Web app** (`backend/` + `frontend/`) | FastAPI server + React UI, multi-user | accounts, history in SQLite on the server |
| **Single HTML file** (`frontend/dist-standalone/zenvqo-chat.html`) | the same UI in one offline file; open it in any browser | no login, history saved in that browser |
| **Android app** (`android/`) | that HTML file inside a native WebView app; the APK is built by GitHub Actions | no login, history saved on the phone |

The HTML file and the APK talk **directly** to an AI service chosen in **Settings → Connection**: **Google Gemini** (free key from aistudio.google.com/apikey), **Groq** (free key from console.groq.com/keys), llama-server on your laptop, Ollama, or any OpenAI-compatible server. In the Android app, requests go through native code, so services that don't allow browser (CORS) requests still work. Every request includes the current date, time and time zone, so "what day is today" is answered correctly. Without a connection, an offline demo explains how to connect and only knows the date and time. Rebuild the HTML with `cd frontend && npm run build:standalone`; this also copies it into the Android app. The APK steps are in [android/README.md](android/README.md).

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
| POST | `/conversations/{id}/messages` `{content, model?, file_ids?, image?}` | **SSE**: `meta` → `delta`* → `done {title}` or `error {code, message, retryable}`; image replies add `tool` → `progress`* → `image`* |
| POST | `/conversations/{id}/regenerate` | SSE, same events |
| POST · GET · DELETE | `/files` (multipart `file`) · `/files/{id}` | owner only |
| GET · PUT | `/settings` | validated (unknown fields rejected) |
| GET | `/models` · `/health` | model list exposes no server URLs |
| GET | `/images/capabilities` | which image providers are ready, and the exact reason if none is |
| POST | `/images` `{op, prompt, style?, aspect_ratio?, n?, seed?, source_id?, mask_id?, …}` | runs one image job outside chat; `{images, notes}` |
| GET | `/files/{id}?download=1` | the same file as a download instead of inline |

## Images: generate, edit, understand

The assistant makes and edits real images: text→image, image→image, variations, styles, masked inpainting and object
removal, and background removal or replacement. Results are stored like uploads, shown in the chat with preview and
download, and numbered (#1, #2…) so later messages can refer to them ("make it night time", "remove the car from image 2").

### How a request is routed
1. **UI buttons** (Variations, Remove background, Paint to edit, "Make an image from my next message") send an explicit operation.
2. **Rules** catch clear requests in English and Hinglish ("Generate an image of…", "Remove the background", "background hata do",
   "make it anime style", "3 variations", "16:9", "seed 42", "as webp").
3. **The chat model** decides everything else through function calling (`generate_image`, `edit_image`), if its server supports
   tools. Mark such models with `"tools": true` in `ZC_MODELS` (Gemini's OpenAI-compatible endpoint, OpenAI, llama-server started
   with `--jinja`). The model also writes the caption. If the server rejects tools, the rules route takes over.

`ZC_IMAGE_ROUTER=auto` (default) is rules first, then the model; `rules` never asks the model; `llm` always does.
When no image provider is ready, the assistant explains the real reason (for example "GEMINI_API_KEY is not set") instead of
claiming to be text-only.

### Providers
| | Local (default) | Gemini | OpenAI |
|---|---|---|---|
| Model | `stabilityai/sd-turbo` (diffusers) + rembg U²-Net | `gemini-2.5-flash-image` | `gpt-image-1` |
| Runs on | your CPU (or GPU) — nothing leaves the machine | Google's servers | OpenAI's servers |
| Cost | free | paid tier only (Google lists $0.039 per image up to 1024px; free AI Studio keys get a quota error) | token-priced, a few cents per image |
| Licence | SD-Turbo: Stability AI Community License (see stability.ai/license for commercial use) · rembg: MIT | Google API terms | OpenAI API terms |
| Speed (512px) | measured on a 4-vCPU GitHub runner: 30–40 s per image incl. the safety check; background removal ~2 s | a few seconds | several seconds |
| Quality | good for drafts, 512–768px; weak at text in images | high, very good instruction edits | high, best text rendering |
| Masks | exact: outside the mask stays pixel-identical | approximate (mask sent as a 2nd picture) | yes (transparent-pixel mask) |
| Seed / negative prompt | seed yes · negative prompt only for non-turbo checkpoints | no / folded into the prompt | no / folded into the prompt |
| Transparent background | yes (rembg) | no — subject on white | yes |

Why local is the default: you have a CPU-only laptop and wanted no running costs. SD-Turbo is the practical size for that hardware
(1–4 denoising steps; FLUX.1-schnell is Apache-2.0 but a 12B model, too heavy for CPU). Hosted providers are for quality. List
several and they act as fallbacks in order: `ZC_IMAGE_PROVIDERS=local,gemini`. Background removal always prefers rembg when installed.

### Setup
```bash
cd backend
pip install -r requirements-images.txt          # CPU PyTorch, diffusers, rembg, OpenCV (~1 GB)
python -m app.images.local --download           # fetch SD-Turbo, U²-Net and the NSFW checker once (~3 GB)
uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8000
```
Hosted instead of (or as well as) local — keys live only in the server's environment:
```bash
export GEMINI_API_KEY=...        # needs billing enabled for image output
export OPENAI_API_KEY=...        # needs organization verification for GPT image models
export ZC_IMAGE_PROVIDERS=gemini,local
```
To let your Gemini chat model call the tools, add it to `ZC_MODELS`:
```json
[{"id":"gemini","label":"Gemini 2.5 Flash","provider":"openai","base_url":"https://generativelanguage.googleapis.com/v1beta/openai",
  "model":"gemini-2.5-flash","api_key_env":"GEMINI_API_KEY","tools":true,"vision":true}]
```
| Variable | Default | |
|---|---|---|
| `ZC_IMAGE_PROVIDERS` | `auto` | `auto` = every provider that is ready, local first; `none` turns images off |
| `ZC_IMAGE_ROUTER` | `auto` | `auto` · `rules` · `llm` |
| `ZC_IMAGE_RATE` | `30/3600` | requests per user per window (seconds) |
| `ZC_IMAGE_MAX_QUEUE` / `ZC_IMAGE_MAX_N` / `ZC_IMAGE_MAX_RES` | `3` / `4` / `1024` | server-wide jobs, images per request, longest side |
| `ZC_LOCAL_IMAGE_MODEL` | `stabilityai/sd-turbo` | any diffusers text-to-image checkpoint, e.g. `stabilityai/sdxl-turbo` (better, ~3× slower) |
| `ZC_LOCAL_STEPS` / `ZC_LOCAL_GUIDANCE` | 4 / 0 for turbo, 25 / 7 otherwise | |
| `ZC_LOCAL_DEVICE` | auto | `cpu` or `cuda` |
| `ZC_LOCAL_REMBG_MODEL` | `u2net` | e.g. `isnet-general-use` |
| `ZC_LOCAL_NSFW_CHECK` | `1` | output classifier `Falconsai/nsfw_image_detection`; images it flags are not returned |
| `ZC_LOCAL_IDLE_UNLOAD_S` | `900` | free the model's RAM after this long idle |
| `ZC_GEMINI_IMAGE_MODEL` · `ZC_OPENAI_IMAGE_MODEL` · `ZC_OPENAI_IMAGE_QUALITY` | `gemini-2.5-flash-image` · `gpt-image-1` · `medium` | |

### Safety, limits and resources
- **Prompts are checked before any provider is called.** Sexual content, anything sexual involving minors, "undressing" a photo of a person, gore and extremist propaganda are refused.
  Hosted providers' own refusals are reported as refusals. Local output passes an NSFW classifier.
- **Every image file is validated and labelled.** Uploads are decoded with size limits (40 MP, decompression bombs refused) and EXIF-rotated.
  Outputs are re-encoded (provider metadata dropped) and PNGs are labelled "AI-generated by zenvqo".
- **Limits and resources.** There's a per-user rate limit and one job per user at a time. A server-wide queue cap applies.
  The local model runs one job at a time, can be cancelled with Stop, and is unloaded after it sits idle.
- **Failures are retried or handed on.** Hosted calls retry rate limits and server errors with backoff.
  Configured providers fall back in order, and the reply says which one was used and why.
- **Logs** go to `zenvqo.images` as one JSON line per job: user id, operation, provider, status, duration, size.
  Prompt length is logged, the prompt text is not.

### Known limits of the local model (seen in the real-model runs)
- **Instruction edits are unreliable.** The local model can't follow instructions properly ("make it night time", "add a hat"). It repaints the whole picture with the new description, so the change shows up only some of the time.
  Gemini and OpenAI are instruction-tuned and do these edits properly; masked edits (Paint to edit) work well locally.
- **Large objects leave a patch when removed.** Object removal fills the masked area from its surroundings. The object goes away, but a large one can leave a smooth patch.
  Small objects come out clean. Pixels outside the mask never change.
- **Text in images and fine detail are weak** at 512px. Use 768px, `stabilityai/sdxl-turbo`, or a hosted provider for these.

### Using it from your phone
Run the server on your laptop with `--host 0.0.0.0` and open `http://<laptop-ip>:8000` in the phone's browser. Image generation
lives on the server. The standalone HTML file and the Android APK talk straight to a chat model and keep no server, so they
show no image tools — the app says so instead of pretending.

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

Image tests: `backend/tests/test_images.py` (mocked provider + fake Gemini/OpenAI servers checking the exact request formats),
`e2e/test_images_ui.py` (browser), and `backend/tests/test_images_real.py` (the real local model, opt-in with
`ZC_REAL_IMAGE_TESTS=1`). The workflow `.github/workflows/zenvqo-images-real.yml` runs the real model on a CPU runner and
publishes the pictures it made.

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
