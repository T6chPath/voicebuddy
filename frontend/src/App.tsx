import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api/client";
import type { Conversation } from "./api/types";
import { AuthPage } from "./components/AuthPage";
import { ChatView } from "./components/ChatView";
import { ConfirmDialog, SettingsDialog } from "./components/Dialogs";
import { Sidebar } from "./components/Sidebar";
import { useRoute } from "./lib/router";
import { SessionProvider, useSession } from "./state/session";
import { ToastProvider, useToasts } from "./state/toasts";

export default function App() {
  return (
    <ToastProvider>
      <SessionProvider>
        <a className="skip" href="#composer-input">Skip to message box</a>
        <OfflineBanner />
        <Shell />
      </SessionProvider>
    </ToastProvider>
  );
}

function Shell() {
  const { status, retry } = useSession();
  if (status === "loading") return <div className="splash" role="status" aria-live="polite"><span className="spinner big" aria-hidden="true" /><span className="sr-only">Loading…</span></div>;
  if (status === "offline") return (
    <main className="splash" id="main">
      <div className="state-box" role="alert">
        <p>Can't reach the zenvqo server.</p>
        <button type="button" className="btn primary" onClick={retry}>Try again</button>
      </div>
    </main>
  );
  if (status === "signed-out") return <AuthPage />;
  return <Workspace />;
}

function Workspace() {
  const { user, signOut } = useSession();
  const toasts = useToasts();
  const { conversationId, navigate } = useRoute();
  const [items, setItems] = useState<Conversation[]>([]);
  const [listState, setListState] = useState<"loading" | "ready" | "error">("loading");
  const [query, setQuery] = useState("");
  const [drawer, setDrawer] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toDelete, setToDelete] = useState<Conversation | null>(null);
  const reqId = useRef(0);

  const reload = useCallback((q: string) => {
    const id = ++reqId.current;
    setListState("loading");
    api.conversations(q)
      .then((r) => { if (id === reqId.current) { setItems(r.items); setListState("ready"); } })
      .catch(() => { if (id === reqId.current) setListState("error"); });
  }, []);

  useEffect(() => {                                   // debounce search typing
    const t = window.setTimeout(() => reload(query), query ? 250 : 0);
    return () => window.clearTimeout(t);
  }, [query, reload]);

  const newChat = useCallback(() => { navigate("/"); setDrawer(false); }, [navigate]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "o") { e.preventDefault(); newChat(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newChat]);

  const onConversationChange = useCallback((c: Partial<Conversation> & { id: string }, created = false) => {
    setItems((xs) => {
      if (created) return [c as Conversation, ...xs];
      const next = xs.map((x) => (x.id === c.id ? { ...x, ...c } : x));
      return [...next].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated_at - a.updated_at);
    });
  }, []);

  async function rename(id: string, title: string) {
    try { const c = await api.updateConversation(id, { title }); onConversationChange(c); }
    catch (e) { toasts.push({ kind: "error", text: e instanceof ApiError ? e.message : "Rename failed." }); }
  }
  async function pin(c: Conversation) {
    try { const u = await api.updateConversation(c.id, { pinned: !c.pinned }); onConversationChange(u); }
    catch (e) { toasts.push({ kind: "error", text: e instanceof ApiError ? e.message : "Couldn't update." }); }
  }
  async function remove(c: Conversation) {
    try {
      await api.deleteConversation(c.id);
      setItems((xs) => xs.filter((x) => x.id !== c.id));
      if (c.id === conversationId) navigate("/", true);
      toasts.push({ kind: "success", text: `Deleted “${c.title}”.` });
    } catch (e) { toasts.push({ kind: "error", text: e instanceof ApiError ? e.message : "Delete failed." }); }
  }

  return (
    <div className="layout">
      <Sidebar open={drawer} onClose={() => setDrawer(false)} items={items} state={listState} query={query} onQuery={setQuery}
               onRetry={() => reload(query)} activeId={conversationId}
               onSelect={(id) => { navigate(`/c/${id}`); setDrawer(false); }} onNew={newChat}
               onRename={rename} onPin={pin} onDelete={setToDelete} user={user!} onSettings={() => setSettingsOpen(true)} onSignOut={signOut} />
      <ChatView conversationId={conversationId} navigate={navigate} onConversationChange={onConversationChange}
                onOpenSidebar={() => setDrawer(true)} sidebarOpen={drawer} />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ConfirmDialog open={!!toDelete} title="Delete conversation?" confirmLabel="Delete"
                     body={`“${toDelete?.title ?? ""}” and its messages will be permanently deleted.`}
                     onConfirm={() => toDelete && remove(toDelete)} onClose={() => setToDelete(null)} />
    </div>
  );
}

function OfflineBanner() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, []);
  return online ? null : <div className="offline" role="alert">You're offline. Messages will fail until your connection returns.</div>;
}
