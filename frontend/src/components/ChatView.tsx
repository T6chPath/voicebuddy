import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, ApiError, fileUrl, LOCAL_MODE, regenerate as apiRegenerate, sendMessage, type StreamHandlers, uploadFile } from "../api/client";
import type { Attachment, Conversation, ImageCaps, ImageOptions, Message, UploadedFile } from "../api/types";
import { useSession } from "../state/session";
import { useToasts } from "../state/toasts";
import { Composer, type ComposerHandle } from "./Composer";
import { Icon } from "./Icon";
import { changedOpts, DEFAULT_IMAGE_OPTS, type ImageAction, ImageSettings, Lightbox, MaskEditor } from "./ImageViews";
import { MessageView } from "./MessageView";

interface Props {
  conversationId: string | null;
  navigate: (to: string, replace?: boolean) => void;
  onConversationChange: (c: Partial<Conversation> & { id: string }, created?: boolean) => void;
  onOpenSidebar: () => void;
  sidebarOpen: boolean;
}

const SUGGESTIONS = ["Explain this code with an example", "Draft a polite email asking for leave", "Show a table comparing Python and JavaScript", "Summarise the file I attach"];
const IMAGE_SUGGESTIONS = ["Generate an image of a futuristic city at sunset", "Make a logo for a chai shop called Garam", "Create a realistic portrait of an old fisherman", "Explain this code with an example"];

export function ChatView({ conversationId, navigate, onConversationChange, onOpenSidebar, sidebarOpen }: Props) {
  const { settings, models } = useSession();
  const toasts = useToasts();
  const [messages, setMessages] = useState<Message[]>([]);
  const [title, setTitle] = useState("New chat");
  const [model, setModel] = useState<string>(settings.default_model || models[0]?.id || "");
  const [loadState, setLoadState] = useState<"idle" | "loading" | "error" | "missing">("idle");
  const [busy, setBusy] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [atBottom, setAtBottom] = useState(true);
  const abort = useRef<AbortController | null>(null);
  const justCreated = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const pendingText = useRef("");
  const raf = useRef(0);
  const [caps, setCaps] = useState<ImageCaps | null>(null);
  const [imageOpts, setImageOpts] = useState<ImageOptions>({ ...DEFAULT_IMAGE_OPTS });
  const [showImageSettings, setShowImageSettings] = useState(false);
  const [target, setTarget] = useState<Attachment | null>(null);
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const [masking, setMasking] = useState<Attachment | null>(null);
  const imagesOn = !!caps?.available;

  useEffect(() => {
    let live = true;
    api.imageCaps().then((c) => live && setCaps(c)).catch(() => live && setCaps(null));
    return () => { live = false; };
  }, []);
  useEffect(() => { setTarget(null); setMasking(null); setViewing(null); }, [conversationId]);

  const numbers = (() => {
    const map = new Map<string, number>();
    for (const m of messages) for (const a of m.attachments) if (a.kind === "image" && !map.has(a.id)) map.set(a.id, map.size + 1);
    return map;
  })();
  const numberOf = (id: string) => numbers.get(id);

  // ----- load conversation -----
  const load = useCallback((id: string) => {
    const ctl = new AbortController();
    setLoadState("loading");
    api.conversation(id, ctl.signal)
      .then((c) => { setMessages(c.messages); setTitle(c.title); setModel(c.model); setLoadState("idle"); })
      .catch((e) => {
        if ((e as Error).name === "AbortError") return;
        setLoadState(e instanceof ApiError && e.status === 404 ? "missing" : "error");
      });
    return ctl;
  }, []);

  useEffect(() => {
    // first message of a new chat changes the URL while its reply is streaming: keep that stream alive
    if (conversationId && justCreated.current === conversationId) { justCreated.current = null; return; }
    abort.current?.abort();
    if (!conversationId) {
      setMessages([]); setTitle("New chat"); setLoadState("idle");
      setModel(settings.default_model || models[0]?.id || "");
      composer.current?.focus();
      return;
    }
    const ctl = load(conversationId);
    return () => ctl.abort();
  }, [conversationId, load]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (!conversationId && settings.default_model) setModel(settings.default_model); }, [settings.default_model, conversationId]);

  // ----- scrolling: follow the stream only if the user is already at the bottom -----
  const onScroll = () => {
    const el = scroller.current;
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };
  useLayoutEffect(() => {
    if (atBottom && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [messages, atBottom]);
  const jumpToLatest = () => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });

  // ----- streaming helpers -----
  const patchLast = (fn: (m: Message) => Message) =>
    setMessages((ms) => (ms.length && ms[ms.length - 1].role === "assistant" ? [...ms.slice(0, -1), fn(ms[ms.length - 1])] : ms));

  const flushDeltas = () => {
    raf.current = 0;
    const chunk = pendingText.current;
    pendingText.current = "";
    if (chunk) patchLast((m) => ({ ...m, content: m.content + chunk }));
  };

  function handlers(cid: string, onMetaUser?: (m: Message) => void): StreamHandlers {
    return {
      onMeta: (d) => {
        if (d.user_message) onMetaUser?.(d.user_message);
        patchLast((m) => ({ ...m, id: d.assistant_message.id, model: d.assistant_message.model }));
      },
      onDelta: (t) => {                                 // batch tokens per animation frame: smooth even on slow phones
        pendingText.current += t;
        if (!raf.current) raf.current = requestAnimationFrame(flushDeltas);
      },
      onDone: (d) => {
        flushDeltas();
        patchLast((m) => ({ ...m, status: "complete" }));
        if (d.title) { setTitle(d.title); onConversationChange({ id: cid, title: d.title, updated_at: Date.now() / 1000 }); }
        else onConversationChange({ id: cid, updated_at: Date.now() / 1000 });
        setAnnounce("Response complete.");
      },
      onError: (e) => {
        flushDeltas();
        patchLast((m) => ({ ...m, status: "error", error: e.message, tool: m.tool && { ...m.tool, status: "failed" } }));
        setAnnounce("The response failed: " + e.message);
      },
      onTool: (t) => {
        patchLast((m) => ({ ...m, tool: { name: t.name, op: t.op || m.tool?.op || "generate", status: t.status,
          fraction: t.status === "done" ? 1 : m.tool?.fraction || 0, text: m.tool?.text || "" } }));
        if (t.status === "running") setAnnounce("Working on the image…");
      },
      onProgress: (p) => patchLast((m) => (m.tool ? { ...m, tool: { ...m.tool, fraction: p.fraction, text: p.text } } : m)),
      onImage: (a) => {
        patchLast((m) => ({ ...m, attachments: [...m.attachments, a] }));
        setAnnounce("Image ready.");
      },
    };
  }

  async function runStream(start: (signal: AbortSignal) => Promise<void>) {
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy(true);
    setAnnounce("Assistant is responding…");
    try {
      await start(ctl.signal);
      if (ctl.signal.aborted) {
        flushDeltas();
        patchLast((m) => ({ ...m, status: "stopped" }));
        setAnnounce("Response stopped.");
      }
    } catch (e) {
      flushDeltas();
      const msg = e instanceof ApiError ? e.message : "Something went wrong.";
      patchLast((m) => ({ ...m, status: "error", error: msg }));
      setAnnounce("The response failed: " + msg);
      throw e;
    } finally {
      setBusy(false);
      abort.current = null;
      composer.current?.focus();
    }
  }

  const placeholder = (): Message => ({ id: "pending-a-" + Date.now(), role: "assistant", content: "", model, status: "streaming", error: null, attachments: [], created_at: Date.now() / 1000 });

  async function send(text: string, files: UploadedFile[], override?: ImageOptions): Promise<boolean> {
    if (busy) return false;
    const image: ImageOptions | undefined = imagesOn
      ? { ...changedOpts(imageOpts), ...(target ? { source_id: target.id } : {}), ...(override || {}) } : undefined;
    let cid = conversationId;
    if (!cid) {
      try {
        const c = await api.createConversation(model || undefined);
        cid = c.id;
        justCreated.current = c.id;
        onConversationChange(c, true);
        navigate(`/c/${c.id}`);
      } catch (e) {
        toasts.push({ kind: "error", text: e instanceof ApiError ? e.message : "Couldn't start a new chat." });
        return false;
      }
    }
    const userMsg: Message = { id: "pending-u-" + Date.now(), role: "user", content: text, model: null, status: "complete", error: null,
      attachments: files.map(({ id, name, mime, size, kind }) => ({ id, name, mime, size, kind })), created_at: Date.now() / 1000, pending: true };
    setMessages((ms) => [...ms, userMsg, placeholder()]);
    setAtBottom(true);
    const id = cid;
    try {
      if (imageOpts.op === "generate") setImageOpts((o) => ({ ...o, op: undefined }));      // one-shot toggle
      setTarget(null);
      await runStream((signal) => sendMessage(id, { content: text, model, file_ids: files.map((f) => f.id),
        ...(image && Object.keys(image).length ? { image } : {}) },
        handlers(id, (server) => setMessages((ms) => ms.map((m) => (m.id === userMsg.id ? server : m)))), signal));
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
        // rejected before streaming (e.g. image sent to a text-only model): undo and keep the draft
        setMessages((ms) => ms.filter((m) => m.id !== userMsg.id && !(m.role === "assistant" && m.status === "error" && !m.content && m.id.startsWith("pending"))));
        toasts.push({ kind: "error", text: e.message });
        return false;
      }
      return true;
    }
  }

  async function regenerate() {
    if (!conversationId || busy) return;
    setMessages((ms) => {
      const out = [...ms];
      while (out.length && out[out.length - 1].role === "assistant") out.pop();
      return [...out, placeholder()];
    });
    const id = conversationId;
    try {
      await runStream((signal) => apiRegenerate(id, handlers(id), signal));
    } catch { /* shown inline */ }
  }

  async function changeModel(next: string) {
    const prev = model;
    setModel(next);
    if (conversationId) {
      try { await api.updateConversation(conversationId, { model: next }); onConversationChange({ id: conversationId, model: next }); }
      catch (e) { setModel(prev); toasts.push({ kind: "error", text: e instanceof ApiError ? e.message : "Couldn't switch model." }); }
    }
  }

  async function imageAction(action: ImageAction, a: Attachment) {
    const n = numberOf(a.id);
    const label = n ? `image #${n}` : "this image";
    if (action === "open") setViewing(a);
    else if (action === "edit") { setTarget(a); composer.current?.focus(); }
    else if (action === "mask") setMasking(a);
    else if (action === "variations") await send(`Make variations of ${label}`, [], { op: "variations", source_id: a.id, n: imageOpts.n && imageOpts.n > 1 ? imageOpts.n : 3 });
    else if (action === "remove_background") await send(`Remove the background of ${label}`, [], { op: "remove_background", source_id: a.id, output_format: "png" });
  }

  async function applyMask(a: Attachment, mask: Blob, instruction: string) {
    setMasking(null);
    try {
      const up = await uploadFile(new File([mask], "mask.png", { type: "image/png" }), () => {}).promise;
      const n = numberOf(a.id);
      const text = instruction ? `In ${n ? "image #" + n : "the image"}, replace the painted area with ${instruction}` : `Remove the painted area from ${n ? "image #" + n : "the image"}`;
      await send(text, [], instruction ? { op: "inpaint", source_id: a.id, mask_id: up.id } : { op: "remove_object", source_id: a.id, mask_id: up.id });
      api.deleteFile(up.id).catch(() => {});
    } catch (e) {
      toasts.push({ kind: "error", text: e instanceof ApiError ? e.message : "Couldn't upload the mask." });
    }
  }

  const stop = () => abort.current?.abort();
  useEffect(() => () => { abort.current?.abort(); if (raf.current) cancelAnimationFrame(raf.current); }, []);

  const current = models.find((m) => m.id === model);
  return (
    <main className="chat" id="main" aria-label="Chat">
      <header className="chat-head">
        <button type="button" className="icon-btn only-mobile" aria-label="Open conversations" aria-expanded={sidebarOpen}
                aria-controls="sidebar" onClick={onOpenSidebar}>
          <Icon name="menu" />
        </button>
        <h1 className="chat-title" title={title}>{title}</h1>
        <label className="model-picker">
          <span className="sr-only">Model</span>
          <select value={model} onChange={(e) => changeModel(e.target.value)} disabled={busy || models.length === 0}
                  aria-describedby={current?.description ? "model-desc" : undefined}>
            {models.map((m) => <option key={m.id} value={m.id}>{m.label}{m.vision ? " · images" : ""}</option>)}
          </select>
          {current?.description && <span id="model-desc" className="sr-only">{current.description}</span>}
        </label>
      </header>

      <div className="thread" ref={scroller} onScroll={onScroll} role="log" aria-label="Conversation" aria-live="off" tabIndex={-1}>
        <div className="thread-inner">
          {loadState === "loading" && (
            <div className="skeleton-thread" aria-label="Loading conversation" role="status">
              <div className="sk sk-user" /><div className="sk sk-bot" /><div className="sk sk-bot short" />
            </div>
          )}
          {loadState === "error" && (
            <div className="state-box" role="alert">
              <p>Couldn't load this conversation.</p>
              <button type="button" className="btn" onClick={() => conversationId && load(conversationId)}>Try again</button>
            </div>
          )}
          {loadState === "missing" && (
            <div className="state-box" role="alert">
              <p>This conversation doesn't exist or was deleted.</p>
              <button type="button" className="btn primary" onClick={() => navigate("/")}>Start a new chat</button>
            </div>
          )}
          {loadState === "idle" && messages.length === 0 && (
            <div className="empty">
              <h2>How can I help?</h2>
              {LOCAL_MODE && (settings.default_model === "echo" || !settings.server_url) && (
                <div className="setup-card" role="note">
                  <strong>Connect a real AI to get answers</strong>
                  <p>Right now only the offline demo is on, so it can't answer questions. Google Gemini is free: get a key in AI Studio and paste it in Settings → Connection.</p>
                  <button type="button" className="btn primary" onClick={() => window.dispatchEvent(new Event("zc:open-settings"))}>Connect AI</button>
                </div>
              )}
              <ul className="suggestions">
                {(imagesOn ? IMAGE_SUGGESTIONS : SUGGESTIONS).map((s) => (
                  <li key={s}><button type="button" className="suggestion" onClick={() => composer.current?.setText(s)}>{s}</button></li>
                ))}
              </ul>
            </div>
          )}
          {loadState === "idle" && messages.map((m, i) => (
            <MessageView key={m.id} m={m} isLast={i === messages.length - 1} busy={busy} models={models}
                         showTime={settings.show_timestamps} onRegenerate={regenerate}
                         onImageAction={imageAction} imageActions={imagesOn && !busy} numberOf={numberOf} />
          ))}
        </div>
      </div>

      {!atBottom && messages.length > 0 && (
        <button type="button" className="jump" onClick={jumpToLatest} aria-label="Jump to latest message">
          <Icon name="down" size={16} />
        </button>
      )}
      <div className="sr-only" aria-live="polite" role="status">{announce}</div>
      {viewing && <Lightbox a={viewing} src={fileUrl(viewing.id)} download={fileUrl(viewing.id, true)} onClose={() => setViewing(null)} onAction={imageAction} />}
      {masking && <MaskEditor a={masking} src={fileUrl(masking.id)} onCancel={() => setMasking(null)} onApply={(b, t) => applyMask(masking, b, t)} />}
      <div className="composer-wrap">
        <Composer ref={composer} busy={busy} sendOnEnter={settings.send_on_enter} onSend={(t, f) => send(t, f)} onStop={stop}
                  placeholder={target ? `Describe the change to image #${numberOf(target.id) ?? ""}…` : imageOpts.op === "generate" ? "Describe the image to create…" : undefined}
                  tools={imagesOn ? (
                    <button type="button" className={`icon-btn${showImageSettings || Object.keys(changedOpts(imageOpts)).length ? " on" : ""}`}
                            aria-label="Image settings" title="Image settings" aria-expanded={showImageSettings} onClick={() => setShowImageSettings((x) => !x)}>
                      <Icon name="sliders" />
                    </button>) : undefined}
                  popover={showImageSettings && caps ? <ImageSettings caps={caps} opts={imageOpts} setOpts={setImageOpts} onClose={() => setShowImageSettings(false)} /> : undefined}
                  banner={target ? (
                    <div className="edit-target" role="status">
                      <img src={fileUrl(target.id)} alt="" />
                      <span>Editing <strong>image #{numberOf(target.id)}</strong> — describe the change</span>
                      <button type="button" className="icon-btn small" aria-label="Stop editing this image" onClick={() => setTarget(null)}><Icon name="close" size={14} /></button>
                    </div>) : imageOpts.op === "generate" ? (
                    <div className="edit-target" role="status"><Icon name="image" size={16} /><span>Your next message will create an image</span>
                      <button type="button" className="icon-btn small" aria-label="Cancel image mode" onClick={() => setImageOpts((o) => ({ ...o, op: undefined }))}><Icon name="close" size={14} /></button>
                    </div>) : undefined} />
        <p className="disclaimer">AI replies can be wrong. Check important information.</p>
      </div>
    </main>
  );
}
