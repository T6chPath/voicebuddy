import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Conversation, ModelInfo, UploadedFile } from "../api/types";
import { Composer, type ComposerHandle } from "../components/Composer";
import { ConfirmDialog, Modal } from "../components/Dialogs";
import { Icon } from "../components/Icon";
import { MessageView } from "../components/MessageView";
import { Sidebar } from "../components/Sidebar";
import { applyTheme } from "../state/session";
import { ToastProvider, useToasts } from "../state/toasts";
import { ACCEPT_LOCAL, pending, readLocal } from "./files";
import { buildMessages, demoStream, listModels, ProviderError, streamChat } from "./providers";
import { DEFAULT_SETTINGS, DEMO_MODEL, exportJson, importJson, load, save, StorageFullError, titleFrom, uid,
  type Data, type LocalMessage, type LocalSettings, type Server } from "./store";

// ---------------- store context ----------------
interface StoreCtx { data: Data; update: (fn: (d: Data) => Data) => void; models: ModelInfo[] }
const Ctx = createContext<StoreCtx | null>(null);
const useStore = () => useContext(Ctx)!;

function modelsFor(s: LocalSettings): ModelInfo[] {
  const out: ModelInfo[] = [{ id: DEMO_MODEL, label: "Demo (offline)", vision: true, description: "Built-in demo — no server needed" }];
  for (const srv of s.servers) {
    if (srv.models.length) for (const m of srv.models) out.push({ id: `${srv.id}::${m}`, label: `${srv.name} · ${m}`, vision: srv.vision, description: srv.baseUrl });
    else out.push({ id: `${srv.id}::`, label: srv.name, vision: srv.vision, description: srv.baseUrl });
  }
  return out;
}

function StoreProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Data>(() => load());
  const toasts = useToasts();
  const update = useCallback((fn: (d: Data) => Data) => {
    setData((d) => {
      const next = fn(d);
      try { save(next); } catch (e) {
        toasts.push({ kind: "error", text: e instanceof StorageFullError ? e.message : "Couldn't save to this device." });
      }
      return next;
    });
  }, [toasts]);
  useEffect(() => { applyTheme(data.settings); }, [data.settings]);
  const models = useMemo(() => modelsFor(data.settings), [data.settings]);
  return <Ctx.Provider value={{ data, update, models }}>{children}</Ctx.Provider>;
}

// ---------------- hash routing (works from file:// and inside the Android WebView) ----------------
function useHashRoute() {
  const read = () => (window.location.hash.match(/^#\/c\/([A-Za-z0-9_]+)$/) || [])[1] || null;
  const [id, setId] = useState<string | null>(read);
  useEffect(() => {
    const on = () => setId(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const navigate = useCallback((cid: string | null) => {
    const h = cid ? `#/c/${cid}` : "#/";
    if (window.location.hash !== h) window.location.hash = h;
    setId(cid);
  }, []);
  return { id, navigate };
}

export default function App() {
  return (
    <ToastProvider>
      <StoreProvider>
        <a className="skip" href="#composer-input">Skip to message box</a>
        <Workspace />
      </StoreProvider>
    </ToastProvider>
  );
}

function Workspace() {
  const { data, update } = useStore();
  const { id, navigate } = useHashRoute();
  const [drawer, setDrawer] = useState(false);
  const [query, setQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toDelete, setToDelete] = useState<Conversation | null>(null);
  const toasts = useToasts();

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? data.conversations.filter((c) => c.title.toLowerCase().includes(q) ||
      (data.messages[c.id] || []).some((m) => m.content.toLowerCase().includes(q))) : data.conversations;
    return [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at - a.updated_at);
  }, [data.conversations, data.messages, query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "o") { e.preventDefault(); navigate(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);

  const patchConv = (cid: string, p: Partial<Conversation>) =>
    update((d) => ({ ...d, conversations: d.conversations.map((c) => (c.id === cid ? { ...c, ...p } : c)) }));

  return (
    <div className="layout">
      <Sidebar open={drawer} onClose={() => setDrawer(false)} items={items} state="ready" query={query} onQuery={setQuery} onRetry={() => {}}
               activeId={id} onSelect={(cid) => { navigate(cid); setDrawer(false); }} onNew={() => { navigate(null); setDrawer(false); }}
               onRename={async (cid, title) => patchConv(cid, { title })} onPin={(c) => patchConv(c.id, { pinned: !c.pinned })}
               onDelete={setToDelete} user={{ id: "local", email: "Stored on this device", name: "You" }} onSettings={() => setSettingsOpen(true)} />
      <LocalChat conversationId={id} navigate={navigate} onOpenSidebar={() => setDrawer(true)} sidebarOpen={drawer} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ConfirmDialog open={!!toDelete} title="Delete conversation?" confirmLabel="Delete"
                     body={`“${toDelete?.title ?? ""}” will be permanently deleted from this device.`}
                     onConfirm={() => {
                       const c = toDelete!;
                       update((d) => { const m = { ...d.messages }; delete m[c.id]; return { ...d, conversations: d.conversations.filter((x) => x.id !== c.id), messages: m }; });
                       if (c.id === id) navigate(null);
                       toasts.push({ kind: "success", text: `Deleted “${c.title}”.` });
                     }} onClose={() => setToDelete(null)} />
    </div>
  );
}

// ---------------- chat ----------------
const SUGGESTIONS = ["Explain this code with an example", "Draft a polite email asking for leave", "Show a table comparing Python and JavaScript", "Summarise the file I attach"];

function LocalChat({ conversationId, navigate, onOpenSidebar, sidebarOpen }: {
  conversationId: string | null; navigate: (id: string | null) => void; onOpenSidebar: () => void; sidebarOpen: boolean;
}) {
  const { data, update, models } = useStore();
  const toasts = useToasts();
  const s = data.settings;
  const conv = data.conversations.find((c) => c.id === conversationId) || null;
  const stored = conversationId ? data.messages[conversationId] || [] : [];
  const [live, setLive] = useState<LocalMessage | null>(null);            // the reply being streamed (not yet saved)
  const [draftModel, setDraftModel] = useState(s.default_model);
  const [busy, setBusy] = useState(false);
  const [announce, setAnnounce] = useState("");
  const [atBottom, setAtBottom] = useState(true);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const model = conv?.model || draftModel;
  const messages = live ? [...stored.filter((m) => m.id !== live.id), live] : stored;

  useEffect(() => { if (!conversationId) setDraftModel(s.default_model); }, [conversationId, s.default_model]);
  useEffect(() => () => abort.current?.abort(), []);
  useLayoutEffect(() => { if (atBottom && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; });
  useEffect(() => { if (conversationId && !conv) navigate(null); }, [conversationId, conv, navigate]);

  const setMsgs = (cid: string, fn: (ms: LocalMessage[]) => LocalMessage[]) =>
    update((d) => ({ ...d, messages: { ...d.messages, [cid]: fn(d.messages[cid] || []) },
      conversations: d.conversations.map((c) => (c.id === cid ? { ...c, updated_at: Date.now() / 1000 } : c)) }));

  async function stream(cid: string, history: LocalMessage[], modelId: string) {
    const info = models.find((m) => m.id === modelId) || models[0];
    const srv = data.settings.servers.find((x) => modelId.startsWith(x.id + "::"));
    const reply: LocalMessage = { id: uid("msg"), role: "assistant", content: "", model: info.id, status: "streaming", error: null, attachments: [], created_at: Date.now() / 1000 };
    let text = "";
    let frame = 0;
    const flush = () => { frame = 0; setLive({ ...reply, content: text }); };
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy(true);
    setLive(reply);
    setAnnounce("Assistant is responding…");
    const msgs = buildMessages(history, s.system_prompt, info.vision);
    const onDelta = (t: string) => { text += t; if (!frame) frame = requestAnimationFrame(flush); };
    let status: LocalMessage["status"] = "complete", error: string | null = null;
    try {
      if (modelId === DEMO_MODEL || !srv) await demoStream(msgs, s.temperature, ctl.signal, onDelta);
      else await streamChat(srv, modelId.split("::")[1] || "default", msgs, s.temperature, ctl.signal, onDelta);
      if (ctl.signal.aborted) status = "stopped";
    } catch (e) {
      if ((e as Error).name === "AbortError") status = "stopped";
      else { status = "error"; error = e instanceof ProviderError ? e.message : "Something went wrong."; }
    } finally {
      if (frame) cancelAnimationFrame(frame);
      setMsgs(cid, (ms) => [...ms, { ...reply, content: text, status, error }]);
      setLive(null);
      setBusy(false);
      abort.current = null;
      setAnnounce(status === "complete" ? "Response complete." : status === "stopped" ? "Response stopped." : "The response failed: " + error);
      composer.current?.focus();
    }
  }

  async function send(text: string, files: UploadedFile[]): Promise<boolean> {
    if (busy) return false;
    const info = models.find((m) => m.id === model);
    if (files.some((f) => f.kind === "image") && !info?.vision) {
      toasts.push({ kind: "error", text: `“${info?.label}” can't read images. Choose a model marked “images” or remove the image.` });
      return false;
    }
    let cid = conversationId;
    if (!cid || !conv) {
      cid = uid("cnv");
      const now = Date.now() / 1000;
      const c: Conversation = { id: cid, title: titleFrom(text), model, pinned: false, created_at: now, updated_at: now };
      update((d) => ({ ...d, conversations: [c, ...d.conversations], messages: { ...d.messages, [cid!]: [] } }));
      navigate(cid);
    }
    const atts = files.map((f) => pending.get(f.id)!).filter(Boolean);
    files.forEach((f) => pending.delete(f.id));
    const user: LocalMessage = { id: uid("msg"), role: "user", content: text, model: null, status: "complete", error: null, attachments: atts, created_at: Date.now() / 1000 };
    setMsgs(cid, (ms) => [...ms, user]);
    setAtBottom(true);
    stream(cid, [...stored, user], model);
    return true;
  }

  function regenerate() {
    if (!conversationId || busy) return;
    const ms = [...stored];
    while (ms.length && ms[ms.length - 1].role === "assistant") ms.pop();
    if (!ms.length) return;
    setMsgs(conversationId, () => ms);
    stream(conversationId, ms, model);
  }

  function changeModel(next: string) {
    if (conv) update((d) => ({ ...d, conversations: d.conversations.map((c) => (c.id === conv.id ? { ...c, model: next } : c)) }));
    else setDraftModel(next);
  }

  return (
    <main className="chat" id="main" aria-label="Chat">
      <header className="chat-head">
        <button type="button" className="icon-btn only-mobile" aria-label="Open conversations" aria-expanded={sidebarOpen} aria-controls="sidebar" onClick={onOpenSidebar}>
          <Icon name="menu" />
        </button>
        <h1 className="chat-title" title={conv?.title || "New chat"}>{conv?.title || "New chat"}</h1>
        <label className="model-picker">
          <span className="sr-only">Model</span>
          <select value={models.some((m) => m.id === model) ? model : DEMO_MODEL} onChange={(e) => changeModel(e.target.value)} disabled={busy}>
            {models.map((m) => <option key={m.id} value={m.id}>{m.label}{m.vision && m.id !== DEMO_MODEL ? " · images" : ""}</option>)}
          </select>
        </label>
      </header>
      <div className="thread" ref={scroller} role="log" aria-label="Conversation" aria-live="off" tabIndex={-1}
           onScroll={() => { const el = scroller.current; if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80); }}>
        <div className="thread-inner">
          {messages.length === 0 && (
            <div className="empty">
              <h2>How can I help?</h2>
              <ul className="suggestions">
                {SUGGESTIONS.map((x) => <li key={x}><button type="button" className="suggestion" onClick={() => composer.current?.setText(x)}>{x}</button></li>)}
              </ul>
              <p className="muted small-text">Chats are saved only on this device. Connect your zenvqo server in Settings.</p>
            </div>
          )}
          {messages.map((m, i) => (
            <MessageView key={m.id} m={m} isLast={i === messages.length - 1} busy={busy} models={models} showTime={s.show_timestamps}
                         onRegenerate={regenerate} fileHref={(a) => (a as { dataUrl?: string }).dataUrl || null} />
          ))}
        </div>
      </div>
      {!atBottom && messages.length > 0 && (
        <button type="button" className="jump" aria-label="Jump to latest message" onClick={() => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" })}>
          <Icon name="down" size={16} />
        </button>
      )}
      <div className="sr-only" aria-live="polite" role="status">{announce}</div>
      <div className="composer-wrap">
        <Composer ref={composer} busy={busy} sendOnEnter={s.send_on_enter} onSend={send} onStop={() => abort.current?.abort()}
                  upload={readLocal} discard={(f) => pending.delete(f.id)} accept={ACCEPT_LOCAL} />
      </div>
    </main>
  );
}

// ---------------- settings ----------------
function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, update } = useStore();
  const toasts = useToasts();
  const [draft, setDraft] = useState<LocalSettings>(data.settings);
  const [tests, setTests] = useState<Record<string, string>>({});
  const [confirmWipe, setConfirmWipe] = useState(false);
  const fileIn = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setDraft(data.settings); setTests({}); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = <K extends keyof LocalSettings>(k: K, v: LocalSettings[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setSrv = (id: string, p: Partial<Server>) => setDraft((d) => ({ ...d, servers: d.servers.map((x) => (x.id === id ? { ...x, ...p } : x)) }));

  async function test(srv: Server) {
    setTests((t) => ({ ...t, [srv.id]: "Testing…" }));
    try {
      const ms = await listModels(srv, AbortSignal.timeout(8000));
      setSrv(srv.id, { models: ms.slice(0, 20) });
      setTests((t) => ({ ...t, [srv.id]: ms.length ? `Connected · ${ms.length} model(s)` : "Connected" }));
    } catch (e) {
      setTests((t) => ({ ...t, [srv.id]: (e instanceof ProviderError ? e.message : (e as Error).name === "TimeoutError" ? "Timed out after 8 s." : "Connection failed.") }));
    }
  }

  function saveAll() {
    const valid = draft.servers.every((x) => /^https?:\/\/[^\s]+$/i.test(x.baseUrl.trim()) && x.name.trim());
    if (!valid) { toasts.push({ kind: "error", text: "Each server needs a name and an http(s):// address." }); return; }
    const clean = { ...draft, servers: draft.servers.map((x) => ({ ...x, name: x.name.trim(), baseUrl: x.baseUrl.trim() })) };
    if (!modelsFor(clean).some((m) => m.id === clean.default_model)) clean.default_model = DEMO_MODEL;
    update((d) => ({ ...d, settings: clean }));
    toasts.push({ kind: "success", text: "Settings saved." });
    onClose();
  }

  function doExport() {
    const blob = new Blob([exportJson(data)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `zenvqo-chats-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function doImport(f: File) {
    try {
      const next = importJson(await f.text(), data);
      update(() => next);
      toasts.push({ kind: "success", text: `Imported ${next.conversations.length - data.conversations.length} conversation(s).` });
    } catch (e) {
      toasts.push({ kind: "error", text: (e as Error).message || "Import failed." });
    }
  }

  const mods = modelsFor(draft);
  return (
    <Modal open={open} onClose={onClose} title="Settings" labelledBy="settings-title">
      <form className="settings" onSubmit={(e) => { e.preventDefault(); saveAll(); }}>
        <fieldset>
          <legend>Model servers</legend>
          <p className="hint">OpenAI-compatible servers, e.g. llama-server running zenvqo on your laptop. On a phone use the laptop's Wi-Fi address,
            like <code>http://192.168.1.20:8080/v1</code>, and start the server with <code>--host 0.0.0.0</code>.</p>
          {draft.servers.map((srv, i) => (
            <div key={srv.id} className="server-card">
              <label className="field"><span>Name</span><input value={srv.name} maxLength={40} onChange={(e) => setSrv(srv.id, { name: e.target.value })} /></label>
              <label className="field"><span>Address (base URL)</span>
                <input value={srv.baseUrl} inputMode="url" autoCapitalize="off" spellCheck={false} placeholder="http://192.168.1.20:8080/v1"
                       onChange={(e) => setSrv(srv.id, { baseUrl: e.target.value, models: [] })} /></label>
              <label className="field"><span>API key (optional, stored on this device)</span>
                <input type="password" value={srv.apiKey} autoComplete="off" onChange={(e) => setSrv(srv.id, { apiKey: e.target.value })} /></label>
              <label className="check"><input type="checkbox" checked={srv.vision} onChange={(e) => setSrv(srv.id, { vision: e.target.checked })} /> This server's model can read images</label>
              <div className="server-actions">
                <button type="button" className="btn small" onClick={() => test(srv)}>Test connection</button>
                {draft.servers.length > 1 && <button type="button" className="btn small" onClick={() => setDraft((d) => ({ ...d, servers: d.servers.filter((x) => x.id !== srv.id) }))}>Remove</button>}
                <span className="test-result" role="status" aria-label={`Server ${i + 1} status`}>{tests[srv.id] || ""}</span>
              </div>
            </div>
          ))}
          <button type="button" className="btn small" onClick={() => setDraft((d) => ({ ...d, servers: [...d.servers, { id: uid("srv"), name: "New server", baseUrl: "http://", apiKey: "", vision: false, models: [] }] }))}>
            <Icon name="plus" size={14} /> Add server
          </button>
        </fieldset>
        <fieldset>
          <legend>Chat</legend>
          <label className="field"><span>Default model</span>
            <select value={mods.some((m) => m.id === draft.default_model) ? draft.default_model : DEMO_MODEL} onChange={(e) => set("default_model", e.target.value)}>
              {mods.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select></label>
          <div className="field">
            <span><label htmlFor="temperature">Creativity (temperature)</label>: <output htmlFor="temperature">{draft.temperature.toFixed(1)}</output></span>
            <input id="temperature" type="range" min={0} max={2} step={0.1} value={draft.temperature} onChange={(e) => set("temperature", Number(e.target.value))} />
          </div>
          <label className="field"><span>Custom instructions</span>
            <textarea rows={3} maxLength={4000} value={draft.system_prompt} onChange={(e) => set("system_prompt", e.target.value)} placeholder="e.g. Answer in simple Hindi." /></label>
          <label className="check"><input type="checkbox" checked={draft.send_on_enter} onChange={(e) => set("send_on_enter", e.target.checked)} /> Enter sends the message</label>
          <label className="check"><input type="checkbox" checked={draft.show_timestamps} onChange={(e) => set("show_timestamps", e.target.checked)} /> Show message times</label>
        </fieldset>
        <fieldset>
          <legend>Appearance</legend>
          <div className="segmented" role="radiogroup" aria-label="Theme">
            {(["system", "light", "dark"] as const).map((t) => (
              <label key={t} className={draft.theme === t ? "on" : ""}><input type="radio" name="theme" checked={draft.theme === t} onChange={() => set("theme", t)} />{t[0].toUpperCase() + t.slice(1)}</label>
            ))}
          </div>
          <label className="field"><span>Text size</span>
            <select value={draft.font_size} onChange={(e) => set("font_size", e.target.value as LocalSettings["font_size"])}>
              <option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option>
            </select></label>
        </fieldset>
        <fieldset>
          <legend>Your data</legend>
          <p className="hint">{data.conversations.length} conversation(s) saved on this device only. Exports leave out API keys.</p>
          <div className="server-actions">
            <button type="button" className="btn small" onClick={doExport}>Export chats</button>
            <button type="button" className="btn small" onClick={() => fileIn.current?.click()}>Import chats</button>
            <input ref={fileIn} type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) doImport(f); e.target.value = ""; }} />
            <button type="button" className="btn small danger" onClick={() => setConfirmWipe(true)}>Delete all data</button>
          </div>
        </fieldset>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary">Save</button>
        </div>
      </form>
      <ConfirmDialog open={confirmWipe} title="Delete all data?" confirmLabel="Delete everything"
                     body="All conversations and settings on this device will be erased. This can't be undone."
                     onConfirm={() => { update(() => ({ v: 1, conversations: [], messages: {}, settings: { ...DEFAULT_SETTINGS } })); window.location.hash = "#/"; onClose(); }}
                     onClose={() => setConfirmWipe(false)} />
    </Modal>
  );
}
