"""Streaming chat over Server-Sent Events, with image tools.

POST /api/conversations/{id}/messages     {"content", "model"?, "file_ids"?, "image"?}   → text/event-stream
POST /api/conversations/{id}/regenerate                                                   → text/event-stream
Events:
  meta {user_message, assistant_message} · delta {text} · done {status, title}
  tool {name, op, status, args}           — an image tool started (status "running") or finished ("done" / "failed")
  progress {fraction, text}               — image progress
  image {attachment}                      — a finished image, already stored and saved on the assistant message
  error {code, message, retryable}

Routing (ZC_IMAGE_ROUTER): "auto" = clear requests go straight to the tool by rules; anything else goes to the chat model,
which may call generate_image / edit_image if it supports tools. "rules" never asks the model; "llm" always does.
If the client disconnects, the partial reply is saved with status 'stopped' and image work is cancelled.
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from ..config import Settings
from ..db import Database, new_id, now
from ..deps import current_user, get_db, get_settings
from ..images.base import ImageError
from ..images.intent import TOOLS, Plan, clean_edit, clean_prompt, detect, plan_from_tool
from ..images.safety import SafetyBlocked
from ..images.service import ImageService, conversation_images
from ..images.spec import ImageRequest
from ..providers import ProviderError, provider_for
from ..schemas import MessageIn
from .conversations import msg_out, owned

router = APIRouter(prefix="/api/conversations", tags=["chat"])
log = logging.getLogger("zenvqo.chat")
BASE_SYSTEM = ("You are zenvqo, a helpful assistant who explains things clearly. Use Markdown when it helps (lists, tables, fenced code with a language). "
               "How to write answers: begin with the direct answer in one or two clear sentences, with no preamble such as “Great question” and without repeating the question. Then explain in short paragraphs of two to four sentences, one idea per paragraph, in simple everyday words; explain any technical term the first time you use it. Match the length to the question: a simple question gets a short, complete answer; a question that needs explaining gets a well-organised explanation. For longer explanations use ## headings for the main parts (for example what it is, how it works, an example, why it matters), **bold** the few key terms the reader should remember, numbered lists for steps and processes, bullet lists for features, causes or types, a table for comparisons, and a worked example or a real-life analogy when it makes the idea easier to understand. To highlight something, write a blockquote that starts with a bold label: > **Tip:** …, > **Note:** …, > **Important:** …, > **Example:** … ; end a longer explanation with > **In short:** and a one- or two-sentence summary. Use these sparingly — at most a few per answer. Never write one long wall of text, and don\"t pad the answer. Reply in the same language and style the user writes in (Hinglish if they write Hinglish). (When the user asks for a PDF, a picture or a graph, the instructions for those come first.) "
               "Write mathematics in LaTeX: inline as $...$ and displayed equations as $$...$$ on their own lines. "
               "For a large project (an app, a website, a game, a program with several files): start with a short plan and the file tree, then give EVERY file complete (no placeholders like '... rest of the code' or 'same as before'), each in its own code block with the file's path written on the line just before it as **`path/to/file.ext`**; finish with how to run it. The app shows the whole project as a .zip download (and web projects can become an Android app). Long answers are fine: if your reply is cut off, the app asks you to continue. When the user asks to change a project, give the complete new version of each changed file. When the user asks for a website, web page, web app or game in HTML, make it large, rich and complete — like a real product, not a demo: every section it needs (for a website: a header with navigation, a hero, several content sections, cards or a gallery, a contact form, a footer), full CSS (a colour theme, good typography, responsive layout for phones and computers, hover states, smooth transitions) and working JavaScript for every button, menu, form and tab. Long code is expected — hundreds or thousands of lines is fine; never shorten it, skip parts, or leave 'add more here' or TODO comments. Under the code the app shows “View site” (opens the page running, like a website) and “Make app” (turns it into an Android app): after the code, say in one short sentence to tap “View site” to see it. The app can turn a web page into a real Android app (APK) on the phone: when the user wants an app, a tool, a game or a website, or asks to convert HTML into an APK, write the complete app as ONE self-contained HTML file (inline CSS and JavaScript, no external files, mobile-friendly, data kept in localStorage when it should be remembered) in a single ```html code block, with a <title> that names the app; then say in one short sentence to tap “Make app” under the code to build and install it. Never say you can't make APK files or Android apps. The app can also make a Google Play package (for publishing on the Play Store): a folder with the app as a signed Android App Bundle (.aab, targeting Android 16 / API 36 as Google Play requires), store icon, feature graphic, screenshots, listing texts, privacy policy, data-safety answers, the upload key and a step-by-step guide. When the user wants to publish on Google Play or turn an APK into a Play Console upload: for a web page, write it as one self-contained HTML file as above and say to tap “Make app” → “Google Play”; for an APK zenvqo made (attached), say to tap “Google Play” on the file. Explain that Google Play takes .aab files, not .apk, for new apps; that a developer account costs a one-time US$25; and that new personal accounts must run a closed test with 12 testers for 14 days before publishing. APKs not made from a web page can't be converted: they need their source project (Android Studio → Build → Generate Signed App Bundle). When the user asks for a PDF (quiz, notes, paragraph, worksheet…), write the complete content as a well-structured Markdown document that starts with a # title — the app turns your reply into a PDF file automatically, so never say you can't create PDFs. "
               "When the user shares a photo or image, look at it carefully and explain everything in it: what it shows, all visible text (read it out exactly), objects, numbers, diagrams, charts, problems or questions written in it (a photo is often a cropped question from a book, worksheet or exam paper: first write the question out exactly, then solve it fully step by step and give the final answer clearly; if there are several questions, answer each one; if part is blurry or cut off, say which part), people's actions and expressions (never identify real people from their faces), and what it means — then answer the user's question about it. "
               "When files are attached (<attached_file>), including PDFs, answer from their content: quote it where useful, mention the page for PDFs, and say plainly when the answer isn't in the file. "
               "When the user asks to plot, graph, draw or visualise a function, equation, curve or surface (2D or 3D), draw it: write a fenced code block with the language plot, one equation per line in plain maths notation (not LaTeX), for example ```plot\ny = sin(x)\ny = x^2/4\n```. Supported lines: y = f(x); x = f(y); any equation in x and y (x^2 + y^2 = 25); inequalities, shaded (y > x^2); polar r = f(theta); parametric x = f(t), y = g(t); points (2, 3); a domain at the end ({0 <= x <= 4}); 3D surfaces z = f(x, y); any equation in x, y, z (x^2 + y^2 + z^2 = 9); 3D curves x = f(t), y = g(t), z = h(t); parametric surfaces in u and v; options x: -5..5, y: …, z: …, t: 0..2pi, title: …; parameters with a slider a = 1 [0..5]. Use ^ for powers, sqrt, abs, ln, log (base 10), pi, e; implicit multiplication like 2x is fine. Choose ranges that show the interesting part. The app draws an interactive graph (zoom, trace, roots and turning points marked), so never say you can't draw graphs; after the block, briefly explain the key features (domain, intercepts, asymptotes, turning points, shape).")
TOOL_NAME = {"generate": "generate_image"}


def sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def get_images(request: Request) -> ImageService:
    return request.app.state.images


def user_settings(db: Database, uid: str) -> dict:
    row = db.one("SELECT data FROM settings WHERE user_id = ?", (uid,))
    return json.loads(row["data"]) if row else {}


def image_system(svc: ImageService, tools_on: bool) -> str:
    if svc.available and tools_on:
        return ("\n\nYou can create and edit images with the generate_image and edit_image tools — call them whenever the "
                "user wants a picture made or changed; never say you are text-only. Images in this chat are numbered "
                "#1, #2… (see the [Image #N …] notes). Write tool prompts in English.")
    if svc.available:
        return "\n\nThis app creates and edits images for the user automatically when they ask for one."
    return ("\n\nImage generation is not available on this server. Technical reason: " + svc.unavailable_reason() +
            " If the user asks for an image, say that and give this reason; do not claim to be text-only.")


def build_messages(db: Database, uid: str, cid: str, s_user: dict, model_cfg, upto_id: str | None = None,
                   extra_system: str = "") -> list[dict]:
    """System prompt + history (newest first until the char budget is used) with attachments inlined."""
    system = BASE_SYSTEM + extra_system + (("\n\n" + s_user["system_prompt"]) if s_user.get("system_prompt") else "")
    rows = db.all("SELECT * FROM messages WHERE conversation_id = ? AND user_id = ? AND status != 'error' ORDER BY created_at",
                  (cid, uid))
    if upto_id:
        idx = next(i for i, r in enumerate(rows) if r["id"] == upto_id)
        rows = rows[: idx + 1]
    numbers = {im["id"]: im["n"] for im in conversation_images(db, uid, cid)}
    out, used = [], len(system)
    for r in reversed(rows):
        content = r["content"]
        atts = json.loads(r["attachments"])
        images = []
        for a in atts:
            if a.get("generated"):
                content += f"\n[Image #{numbers.get(a['id'], '?')} generated ({a.get('width')}×{a.get('height')}): " \
                           f"{(a.get('meta') or {}).get('scene') or (a.get('meta') or {}).get('prompt', '')}]"
                continue
            f = db.one("SELECT * FROM files WHERE id = ? AND user_id = ?", (a["id"], uid))
            if not f:
                continue
            if f["kind"] == "image":
                images.append(f)
                content += f"\n[Image #{numbers.get(f['id'], '?')} attached by the user: {f['name']}]"
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


def _resolve_source(ref: str, explicit: str | None, attached: list[str], ctx: list[dict]) -> str | None:
    known = {c["id"] for c in ctx}
    if explicit:                       # ownership already checked in send()
        return explicit
    if ref == "attached" and attached:
        return attached[-1]
    if ref.startswith("#") and ref[1:].isdigit():
        k = int(ref[1:])
        if 1 <= k <= len(ctx):
            return ctx[k - 1]["id"]
    if ref in known:
        return ref
    if attached:
        return attached[-1]
    return ctx[-1]["id"] if ctx else None


def _to_request(plan: Plan, opts: dict, source: str | None, ctx: list[dict]) -> ImageRequest:
    def pick(name, default):
        v = getattr(plan, name, None)
        return v if v not in (None, "") else (opts.get(name) if opts.get(name) not in (None, "") else default)
    scene = next((c["scene"] for c in ctx if c["id"] == source and c["generated"]), "")
    return ImageRequest(op=plan.op, prompt=plan.prompt, negative_prompt=pick("negative_prompt", ""), style=pick("style", "none"),
                        aspect_ratio=pick("aspect_ratio", "1:1"), resolution=pick("resolution", 512), seed=pick("seed", None),
                        n=pick("n", 1), output_format=pick("output_format", "png"), strength=opts.get("strength") or 0.6,
                        source_id=source if plan.op != "generate" else None, mask_id=opts.get("mask_id"),
                        background=plan.background, context_prompt=scene)


def _caption(req: ImageRequest, atts: list[dict], notes: list[str]) -> str:
    n = len(atts)
    what = {"generate": (f"Here's your image of **{req.prompt}**." if n == 1 else f"Here are {n} images of **{req.prompt}**."),
            "edit": "Here's the edited image.", "variations": f"Here {'is a variation' if n == 1 else f'are {n} variations'}.",
            "style": f"Here it is in **{req.style.replace('-', ' ')}** style.", "inpaint": "Here's the image with the painted area changed.",
            "remove_object": f"Removed **{req.prompt or 'the object'}**.", "remove_background": "Background removed.",
            "replace_background": f"Background replaced with **{req.background or req.prompt}**."}[req.op]
    a = atts[0]["meta"]
    detail = f"{a['provider']} · {a['model'].split('/')[-1]} · {atts[0]['width']}×{atts[0]['height']}"
    if a.get("seed") is not None:
        detail += f" · seed {a['seed']}" + ("…" if n > 1 else "")
    lines = [what, "", f"_{detail}_"]
    lines += [f"- {x}" for x in notes]
    lines += ["", "Ask for changes in your own words (for example “make it night time”), or use the buttons on the image."]
    return "\n".join(lines)


def _stream(request: Request, db: Database, s: Settings, uid: str, cid: str, model_id: str, user_msg: dict | None,
            s_user: dict, upto_id: str | None, opts: dict, user_text: str, attached: list[str]):
    svc: ImageService = request.app.state.images
    cfg = s.model(model_id)
    provider = provider_for(cfg, s.echo_delay_s)
    mode = s.image_router if s.image_router in ("auto", "rules", "llm") else "auto"
    tools_on = bool(cfg.tools) and mode != "rules" and cfg.provider == "openai"
    msgs = build_messages(db, uid, cid, s_user, cfg, upto_id, image_system(svc, tools_on))
    ctx = conversation_images(db, uid, cid)
    rows = db.all("SELECT role, attachments FROM messages WHERE conversation_id = ? AND user_id = ? ORDER BY created_at", (cid, uid))
    prev_assist = next((r for r in reversed(rows[:-1]) if r["role"] == "assistant"), None)
    last_reply_has_image = bool(prev_assist and any(a.get("kind") == "image" for a in json.loads(prev_assist["attachments"])))
    aid, t = new_id("msg"), now()
    db.run("INSERT INTO messages (id, conversation_id, user_id, role, content, model, status, created_at) "
           "VALUES (?,?,?,?,?,?,?,?)", (aid, cid, uid, "assistant", "", model_id, "streaming", t + 0.001))
    temperature = float(s_user.get("temperature", 0.7))

    async def gen():
        text, status, out_atts, meta = "", "streaming", [], {}
        yield sse("meta", {"user_message": user_msg, "assistant_message": {"id": aid, "model": model_id}})
        try:
            plan: Plan | None = None
            llm_answered = False
            tool_call = None
            if opts.get("op"):
                plan = Plan(op=opts["op"], prompt=(clean_prompt(user_text) if opts["op"] == "generate" else clean_edit(user_text)),
                            image_ref="attached" if attached else "latest", via="ui")
                if opts["op"] in ("remove_background", "variations"):
                    plan.prompt = ""
                if opts["op"] == "replace_background":
                    plan.background = plan.prompt
            elif mode != "llm":
                plan = detect(user_text, attached_image=bool(attached or opts.get("source_id")), has_images=bool(ctx),
                              last_reply_has_image=last_reply_has_image)
                if plan:
                    for k in ("style", "aspect_ratio", "n", "seed", "negative_prompt", "output_format", "resolution"):
                        if getattr(plan, k) is None and opts.get(k) is not None:
                            setattr(plan, k, opts[k])
            if plan is None and tools_on and svc.available:
                try:
                    async for kind, val in provider.events(msgs, temperature, TOOLS):
                        if kind == "text":
                            text += val
                            yield sse("delta", {"text": val})
                        elif kind == "tool_calls":
                            for c in val:
                                try:
                                    args = json.loads(c["arguments"] or "{}")
                                except json.JSONDecodeError:
                                    continue
                                p = plan_from_tool(c["name"], args if isinstance(args, dict) else {})
                                if p:
                                    plan, tool_call = p, c
                                    break
                    llm_answered = True
                except ProviderError as e:
                    if e.code != "tools_unsupported":
                        raise
                    log.info("model %s rejected tools; using rules", model_id)
                    plan = detect(user_text, attached_image=bool(attached), has_images=bool(ctx), last_reply_has_image=last_reply_has_image)

            if plan and plan.clarify:
                text += plan.clarify
                yield sse("delta", {"text": plan.clarify})
            elif plan and not svc.available:
                msg = ("I can't make or edit images on this server right now. Technical reason: " + svc.unavailable_reason())
                text += msg
                yield sse("delta", {"text": msg})
            elif plan:
                source = _resolve_source(plan.image_ref, opts.get("source_id"), attached, ctx)
                req = _to_request(plan, opts, source, ctx)
                tname = TOOL_NAME.get(req.op, "edit_image")
                args = {"op": req.op, "prompt": req.prompt, "style": req.style, "aspect_ratio": req.aspect_ratio,
                        "n": req.n, "seed": req.seed, "source_id": req.source_id, "mask": bool(req.mask_id), "via": plan.via}
                meta["tool"] = {"name": tname, "args": args}
                yield sse("tool", {"name": tname, "op": req.op, "status": "running", "args": args})
                q: asyncio.Queue = asyncio.Queue()
                task = asyncio.create_task(svc.run(uid, cid, req, lambda f, s_: q.put_nowait((f, s_)), user_text))
                try:
                    while not task.done():
                        try:
                            f, s_ = await asyncio.wait_for(q.get(), timeout=0.5)
                            yield sse("progress", {"fraction": round(max(0.0, min(1.0, f)), 3), "text": s_})
                        except asyncio.TimeoutError:
                            pass
                    out_atts, notes = task.result()
                except BaseException:
                    task.cancel()
                    raise
                for a in out_atts:
                    yield sse("image", {"attachment": a})
                db.run("UPDATE messages SET attachments = ? WHERE id = ? AND user_id = ?", (json.dumps(out_atts), aid, uid))
                yield sse("tool", {"name": tname, "op": req.op, "status": "done", "images": [a["id"] for a in out_atts]})
                caption = None
                if tool_call and llm_answered:
                    caption = await _follow_up(provider, msgs, tool_call, out_atts, notes, ctx, temperature)
                caption = caption or _caption(req, out_atts, notes)
                sep = "\n\n" if text else ""
                text += sep + caption
                yield sse("delta", {"text": sep + caption})
            elif not llm_answered:
                async for delta in provider.stream(msgs, temperature):
                    text += delta
                    yield sse("delta", {"text": delta})
            status = "complete"
            title = _maybe_title(db, uid, cid)
            yield sse("done", {"status": status, "title": title, "message_id": aid})
        except SafetyBlocked as e:
            msg = f"{e} I can make something else — try a different idea."
            text += ("\n\n" if text else "") + msg
            yield sse("delta", {"text": msg})
            if meta.get("tool"):
                yield sse("tool", {"name": meta["tool"]["name"], "status": "failed", "code": "safety"})
            status = "complete"
            yield sse("done", {"status": status, "title": _maybe_title(db, uid, cid), "message_id": aid})
        except (ProviderError, ImageError) as e:
            status = "error"
            if meta.get("tool"):
                yield sse("tool", {"name": meta["tool"]["name"], "status": "failed", "code": e.code})
            db.run("UPDATE messages SET error = ? WHERE id = ?", (str(e), aid))
            yield sse("error", {"code": e.code, "message": str(e), "retryable": e.retryable, "message_id": aid})
        finally:
            if status == "streaming":
                status = "stopped"                                   # client went away mid-stream
            db.run("UPDATE messages SET content = ?, status = ?, meta = ? WHERE id = ? AND user_id = ?",
                   (text, status, json.dumps(meta), aid, uid))
            db.run("UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?", (now(), cid, uid))

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


async def _follow_up(provider, msgs, call, atts, notes, ctx, temperature) -> str | None:
    """Give the tool result back to the chat model so it can describe what it made, in the user's language."""
    base_n = len(ctx)
    result = {"ok": True, "images": [{"ref": f"#{base_n + i + 1}", "width": a["width"], "height": a["height"],
                                      "provider": a["meta"]["provider"], "seed": a["meta"].get("seed")} for i, a in enumerate(atts)],
              "notes": notes, "shown_to_user": True}
    convo = msgs + [{"role": "assistant", "content": None, "tool_calls": [
        {"id": call.get("id") or "call_1", "type": "function", "function": {"name": call["name"], "arguments": call["arguments"] or "{}"}}]},
        {"role": "tool", "tool_call_id": call.get("id") or "call_1", "content": json.dumps(result)}]
    try:
        out = ""
        async for kind, val in provider.events(convo, temperature):
            if kind == "text":
                out += val
        return out.strip() or None
    except ProviderError:
        return None


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
def send(cid: str, body: MessageIn, request: Request, user: dict = Depends(current_user), db: Database = Depends(get_db),
         s: Settings = Depends(get_settings)):
    conv = owned(db, cid, user["id"])
    model_id = body.model or conv["model"]
    cfg = s.model(model_id)
    if not cfg:
        raise HTTPException(400, "Unknown model.")
    svc: ImageService = request.app.state.images
    atts = []
    for fid in dict.fromkeys(body.file_ids):
        f = db.one("SELECT id, name, mime, size, kind FROM files WHERE id = ? AND user_id = ?", (fid, user["id"]))
        if not f:
            raise HTTPException(400, "An attached file was not found. Remove it and try again.")
        if f["kind"] == "image" and not cfg.vision and not svc.available:
            raise HTTPException(400, f"“{cfg.label}” can't read images. Choose a vision model or remove the image.")
        atts.append(f)
    opts = body.image.model_dump(exclude_none=True) if body.image else {}
    for key in ("source_id", "mask_id"):
        if opts.get(key) and not db.one("SELECT id FROM files WHERE id = ? AND user_id = ? AND kind = 'image'", (opts[key], user["id"])):
            raise HTTPException(400, "The image to edit was not found.")
    if model_id != conv["model"]:
        db.run("UPDATE conversations SET model = ? WHERE id = ? AND user_id = ?", (model_id, cid, user["id"]))
    mid = new_id("msg")
    db.run("INSERT INTO messages (id, conversation_id, user_id, role, content, model, status, attachments, created_at, meta) "
           "VALUES (?,?,?,?,?,?,?,?,?,?)", (mid, cid, user["id"], "user", body.content, None, "complete", json.dumps(atts), now(),
                                            json.dumps({"image": opts} if opts else {})))
    user_msg = msg_out(db.one("SELECT * FROM messages WHERE id = ?", (mid,)))
    attached = [a["id"] for a in atts if a["kind"] == "image"]
    return _stream(request, db, s, user["id"], cid, model_id, user_msg, user_settings(db, user["id"]), None, opts, body.content, attached)


@router.post("/{cid}/regenerate")
def regenerate(cid: str, request: Request, user: dict = Depends(current_user), db: Database = Depends(get_db),
               s: Settings = Depends(get_settings)):
    """Replace the last assistant reply (or answer an unanswered/failed last user message)."""
    conv = owned(db, cid, user["id"])
    rows = db.all("SELECT id, role FROM messages WHERE conversation_id = ? AND user_id = ? ORDER BY created_at", (cid, user["id"]))
    while rows and rows[-1]["role"] == "assistant":
        db.run("DELETE FROM messages WHERE id = ? AND user_id = ?", (rows.pop()["id"], user["id"]))
    if not rows:
        raise HTTPException(400, "Nothing to regenerate.")
    if not s.model(conv["model"]):
        raise HTTPException(400, "Unknown model.")
    last = db.one("SELECT * FROM messages WHERE id = ?", (rows[-1]["id"],))
    opts = dict(json.loads(last.get("meta") or "{}").get("image") or {})
    opts.pop("seed", None)                                  # a regenerate should give a new picture
    attached = [a["id"] for a in json.loads(last["attachments"]) if a.get("kind") == "image"]
    return _stream(request, db, s, user["id"], cid, conv["model"], None, user_settings(db, user["id"]), rows[-1]["id"],
                   opts, last["content"], attached)
