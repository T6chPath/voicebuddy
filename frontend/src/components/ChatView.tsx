import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, ApiError, regenerate as apiRegenerate, sendMessage, type StreamHandlers } from "../api/client";
import type { Conversation, Message, UploadedFile } from "../api/types";
import { useSession } from "../state/session";
import { useToasts } from "../state/toasts";
import { Composer, type ComposerHandle } from "./Composer";
import { Icon } from "./Icon";
import { MessageView } from "./MessageView";

interface Props {
  conversationId: string | null;
  navigate: (to: string, replace?: boolean) => void;
  onConversationChange: (c: Partial<Conversation> & { id: string }, created?: boolean) => void;
  onOpenSidebar: () => void;
  sidebarOpen: boolean;
}

const SUGGESTIONS = ["Explain this code with an example", "Draft a polite email asking for leave", "Show a table comparing Python and JavaScript", "Summarise the file I attach"];

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
        patchLast((m) => ({ ...m, status: "error", error: e.message }));
        setAnnounce("The response failed: " + e.message);
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

  async function send(text: string, files: UploadedFile[]): Promise<boolean> {
    if (busy) return false;
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
      await runStream((signal) => sendMessage(id, { content: text, model, file_ids: files.map((f) => f.id) },
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
              <ul className="suggestions">
                {SUGGESTIONS.map((s) => (
                  <li key={s}><button type="button" className="suggestion" onClick={() => composer.current?.setText(s)}>{s}</button></li>
                ))}
              </ul>
            </div>
          )}
          {loadState === "idle" && messages.map((m, i) => (
            <MessageView key={m.id} m={m} isLast={i === messages.length - 1} busy={busy} models={models}
                         showTime={settings.show_timestamps} onRegenerate={regenerate} />
          ))}
        </div>
      </div>

      {!atBottom && messages.length > 0 && (
        <button type="button" className="jump" onClick={jumpToLatest} aria-label="Jump to latest message">
          <Icon name="down" size={16} />
        </button>
      )}
      <div className="sr-only" aria-live="polite" role="status">{announce}</div>
      <div className="composer-wrap">
        <Composer ref={composer} busy={busy} sendOnEnter={settings.send_on_enter} onSend={send} onStop={stop} />
        <p className="disclaimer">AI replies can be wrong. Check important information.</p>
      </div>
    </main>
  );
}
