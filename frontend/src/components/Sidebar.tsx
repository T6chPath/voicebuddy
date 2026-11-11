import { Logo } from "./Brand";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { LOCAL_MODE } from "../api/client";
import type { Conversation, User } from "../api/types";
import { groupConversations } from "../lib/format";
import { Icon } from "./Icon";

interface Props {
  open: boolean;
  onClose: () => void;
  items: Conversation[];
  state: "loading" | "ready" | "error";
  query: string;
  onQuery: (q: string) => void;
  onRetry: () => void;
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => Promise<void>;
  onPin: (c: Conversation) => void;
  onDelete: (c: Conversation) => void;
  user: User;
  onSettings: () => void;
  onSignOut?: () => void;
}

export function Sidebar(p: Props) {
  const ref = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<string | null>(null);

  // mobile drawer: Esc closes, focus moves into the drawer when it opens
  useEffect(() => {
    if (!p.open) return;
    const first = ref.current?.querySelector<HTMLElement>("button, input");
    first?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") p.onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p.open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); search.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const groups = groupConversations(p.items);
  return (
    <>
      <div className={`scrim${p.open ? " show" : ""}`} onClick={p.onClose} aria-hidden="true" />
      <nav id="sidebar" ref={ref} className={`sidebar${p.open ? " open" : ""}`} aria-label="Conversations">
        <div className="side-brand" aria-hidden="true"><Logo /> zenvqo</div>
        <div className="side-top">
          <button type="button" className="btn primary wide" onClick={p.onNew}>
            <Icon name="plus" /> New chat
          </button>
          <button type="button" className="icon-btn only-mobile" aria-label="Close conversations" onClick={p.onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="search">
          <Icon name="search" size={16} />
          <label htmlFor="conv-search" className="sr-only">Search conversations</label>
          <input id="conv-search" ref={search} type="search" placeholder="Search (Ctrl+K)" value={p.query} onChange={(e) => p.onQuery(e.target.value)} />
        </div>
        <div className="conv-scroll">
          {p.state === "loading" && p.items.length === 0 && (
            <ul className="conv-skeleton" aria-label="Loading conversations">{[1, 2, 3, 4, 5].map((i) => <li key={i} className="sk" />)}</ul>
          )}
          {p.state === "error" && (
            <div className="state-box small" role="alert">
              <p>Couldn't load conversations.</p>
              <button type="button" className="btn small" onClick={p.onRetry}>Retry</button>
            </div>
          )}
          {p.state === "ready" && p.items.length === 0 && (
            <p className="muted pad">{p.query ? `No chats match “${p.query}”.` : "No conversations yet."}</p>
          )}
          {groups.map((g) => (
            <section key={g.label} aria-labelledby={`g-${g.label}`}>
              <h2 className="group-label" id={`g-${g.label}`}>{g.label}</h2>
              <ul className="conv-list">
                {g.items.map((c) => (
                  <li key={c.id} className={`conv${c.id === p.activeId ? " active" : ""}`}>
                    {editing === c.id ? (
                      <RenameForm c={c} onDone={() => setEditing(null)} onRename={p.onRename} />
                    ) : (
                      <>
                        <a href={LOCAL_MODE ? `#/c/${c.id}` : `/c/${c.id}`} className="conv-link" aria-current={c.id === p.activeId ? "page" : undefined}
                           onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); p.onSelect(c.id); }}>
                          {c.pinned && <span className="pin-dot" aria-label="Pinned" role="img"><Icon name="pin" size={12} /></span>}
                          <span className="conv-title">{c.title}</span>
                        </a>
                        <div className="conv-actions">
                          <button type="button" className="icon-btn small" aria-label={`Rename “${c.title}”`} onClick={() => setEditing(c.id)}><Icon name="edit" size={14} /></button>
                          <button type="button" className="icon-btn small" aria-label={c.pinned ? `Unpin “${c.title}”` : `Pin “${c.title}”`} aria-pressed={c.pinned} onClick={() => p.onPin(c)}><Icon name="pin" size={14} /></button>
                          <button type="button" className="icon-btn small danger" aria-label={`Delete “${c.title}”`} onClick={() => p.onDelete(c)}><Icon name="trash" size={14} /></button>
                        </div>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <div className="side-bottom">
          <div className="me" title={p.user.email}>
            <span className="avatar" aria-hidden="true">{p.user.name.slice(0, 1).toUpperCase()}</span>
            <span className="me-name">{p.user.name}</span>
          </div>
          <button type="button" className="icon-btn" aria-label="Settings" title="Settings" onClick={p.onSettings}><Icon name="settings" /></button>
          {!LOCAL_MODE && <button type="button" className="icon-btn" aria-label="Sign out" title="Sign out" onClick={p.onSignOut}><Icon name="logout" /></button>}
        </div>
      </nav>
    </>
  );
}

function RenameForm({ c, onDone, onRename }: { c: Conversation; onDone: () => void; onRename: (id: string, t: string) => Promise<void> }) {
  const [v, setV] = useState(c.title);
  const [busy, setBusy] = useState(false);
  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const t = v.trim();
    if (!t || t === c.title) return onDone();
    setBusy(true);
    try { await onRename(c.id, t); } finally { setBusy(false); onDone(); }
  }
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onDone(); } };
  return (
    <form className="rename" onSubmit={submit}>
      <label className="sr-only" htmlFor={`rn-${c.id}`}>New title</label>
      <input id={`rn-${c.id}`} autoFocus value={v} maxLength={120} onChange={(e) => setV(e.target.value)} onKeyDown={onKey} onBlur={() => submit()} disabled={busy} />
    </form>
  );
}
