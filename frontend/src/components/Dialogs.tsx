import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, clearAllLocalData, fetchServerModels, LOCAL_MODE, PRESETS } from "../api/client";
import type { ModelInfo, UserSettings } from "../api/types";
import { isMac } from "../lib/format";
import { useSession } from "../state/session";
import { Icon } from "./Icon";

/** Native <dialog> + showModal(): built-in focus trapping, Esc to close, inert background, top layer. */
export function Modal({ open, onClose, title, children, labelledBy }: { open: boolean; onClose: () => void; title: string; children: ReactNode; labelledBy: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) { opener.current = document.activeElement; d.showModal(); }
    if (!open && d.open) { d.close(); (opener.current as HTMLElement | null)?.focus?.(); }
  }, [open]);
  return (
    <dialog ref={ref} className="modal" aria-labelledby={labelledBy} onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose(); }}
            onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="modal-inner">
        <header className="modal-head">
          <h2 id={labelledBy}>{title}</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}><Icon name="close" /></button>
        </header>
        {open && children}
      </div>
    </dialog>
  );
}

export function ConfirmDialog({ open, title, body, confirmLabel, onConfirm, onClose }: {
  open: boolean; title: string; body: string; confirmLabel: string; onConfirm: () => Promise<void> | void; onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal open={open} onClose={onClose} title={title} labelledBy="confirm-title">
      <p>{body}</p>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose} autoFocus>Cancel</button>
        <button type="button" className="btn danger" disabled={busy} aria-busy={busy}
                onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); onClose(); } }}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { settings, models, saveSettings, user } = useSession();
  const [draft, setDraft] = useState<UserSettings>(settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // reset the form only when the dialog opens (not when a save updates `settings`, which would hide "Saved")
  useEffect(() => { if (open) { setDraft(settings); setError(null); setSaved(false); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = <K extends keyof UserSettings>(k: K, v: UserSettings[K]) => { setDraft((d) => ({ ...d, [k]: v })); setSaved(false); };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try { await saveSettings(draft); setSaved(true); }
    catch (err) { setError(err instanceof ApiError ? err.message : "Couldn't save settings."); }
    finally { setBusy(false); }
  }
  const mod = isMac() ? "⌘" : "Ctrl";
  return (
    <Modal open={open} onClose={onClose} title="Settings" labelledBy="settings-title">
      <form className="settings" onSubmit={submit}>
        {LOCAL_MODE && <ConnectionFields draft={draft} set={set} />}
        <fieldset>
          <legend>Appearance</legend>
          <div className="segmented" role="radiogroup" aria-label="Theme">
            {(["system", "light", "dark"] as const).map((t) => (
              <label key={t} className={draft.theme === t ? "on" : ""}>
                <input type="radio" name="theme" value={t} checked={draft.theme === t} onChange={() => set("theme", t)} />
                {t[0].toUpperCase() + t.slice(1)}
              </label>
            ))}
          </div>
          <label className="field">
            <span>Text size</span>
            <select value={draft.font_size} onChange={(e) => set("font_size", e.target.value as UserSettings["font_size"])}>
              <option value="small">Small</option><option value="medium">Medium</option><option value="large">Large</option>
            </select>
          </label>
          <label className="check"><input type="checkbox" checked={draft.show_timestamps} onChange={(e) => set("show_timestamps", e.target.checked)} /> Show message times</label>
        </fieldset>
        <fieldset>
          <legend>Chat</legend>
          <label className="field">
            <span>Default model</span>
            <select value={draft.default_model} onChange={(e) => set("default_model", e.target.value)}>
              {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              {!models.some((m) => m.id === draft.default_model) && <option value={draft.default_model}>{draft.default_model.replace(/^srv:/, "")}</option>}
            </select>
          </label>
          <div className="field">
            <span><label htmlFor="temperature">Creativity (temperature)</label>: <output htmlFor="temperature">{draft.temperature.toFixed(1)}</output></span>
            <input id="temperature" type="range" min={0} max={2} step={0.1} value={draft.temperature} onChange={(e) => set("temperature", Number(e.target.value))}
                   aria-valuetext={`${draft.temperature.toFixed(1)}${draft.temperature < 0.4 ? ", precise" : draft.temperature > 1.2 ? ", very creative" : ""}`} />
          </div>
          <label className="field">
            <span>Custom instructions</span>
            <textarea rows={4} maxLength={4000} value={draft.system_prompt} onChange={(e) => set("system_prompt", e.target.value)}
                      placeholder="e.g. Answer in simple Hindi. Keep replies short." />
            <small className="hint">{draft.system_prompt.length} / 4000 — added to every conversation.</small>
          </label>
          <label className="check"><input type="checkbox" checked={draft.send_on_enter} onChange={(e) => set("send_on_enter", e.target.checked)} /> Enter sends the message (otherwise {mod}+Enter)</label>
        </fieldset>
        <details>
          <summary>Keyboard shortcuts</summary>
          <dl className="keys">
            <dt><kbd>{mod}</kbd>+<kbd>K</kbd></dt><dd>Search conversations</dd>
            <dt><kbd>{mod}</kbd>+<kbd>Shift</kbd>+<kbd>O</kbd></dt><dd>New chat</dd>
            <dt><kbd>Esc</kbd></dt><dd>Stop generating / close panels</dd>
            <dt><kbd>Shift</kbd>+<kbd>Enter</kbd></dt><dd>New line</dd>
          </dl>
        </details>
        {LOCAL_MODE ? <ClearData /> : <p className="muted small-text">Signed in as {user?.email}</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <span className="saved" role="status">{saved ? "Saved" : ""}</span>
          <button type="button" className="btn" onClick={onClose}>Close</button>
          <button type="submit" className="btn primary" disabled={busy} aria-busy={busy}>{busy && <span className="spinner" aria-hidden="true" />}Save</button>
        </div>
      </form>
    </Modal>
  );
}

/** Standalone app: where the model lives. Talks straight to an OpenAI-compatible server (llama-server, Ollama…). */
/** Prefer a fast, capable general chat model when the service lists many. */
function pickModel(ms: ModelInfo[]): ModelInfo {
  const prefs = [/gemini-2\.5-flash$/, /gemini-.*flash$/, /llama-3\.3-70b-versatile/, /gpt-oss-120b/, /llama/, /qwen/];
  for (const re of prefs) { const m = ms.find((x) => re.test(x.id) && !/lite|preview|exp|thinking/.test(x.id)); if (m) return m; }
  for (const re of prefs) { const m = ms.find((x) => re.test(x.id)); if (m) return m; }
  return ms[0];
}

function ConnectionFields({ draft, set }: { draft: UserSettings; set: <K extends keyof UserSettings>(k: K, v: UserSettings[K]) => void }) {
  const [state, setState] = useState<{ kind: "idle" | "testing" | "ok" | "error"; text?: string; models?: ModelInfo[] }>({ kind: "idle" });
  async function test() {
    setState({ kind: "testing" });
    try {
      const ms = await fetchServerModels(draft);
      if (!ms.length) { setState({ kind: "error", text: "Connected, but the server listed no models." }); return; }
      const pick = pickModel(ms);
      if (draft.default_model === "echo" || !draft.default_model || !ms.some((m) => m.id === draft.default_model)) set("default_model", pick.id);
      setState({ kind: "ok", text: `Connected — using ${pick.label}. Tap Save, then start chatting.`, models: ms });
    } catch (e) {
      setState({ kind: "error", text: e instanceof ApiError ? e.message : "Connection failed." });
    }
  }
  const preset = PRESETS.find((p) => p.url && p.url === (draft.server_url ?? "").replace(/\/+$/, "")) ?? (draft.server_url ? PRESETS.find((p) => p.id === "custom")! : undefined);
  return (
    <fieldset>
      <legend>Connection</legend>
      <div className="field">
        <span id="preset-label">AI service</span>
        <div className="preset-grid" role="group" aria-labelledby="preset-label">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" className={"btn preset" + (preset?.id === p.id ? " on" : "")} aria-pressed={preset?.id === p.id}
                    onClick={() => { set("server_url", p.url); setState({ kind: "idle" }); }}>{p.label}</button>
          ))}
        </div>
        {preset?.keyUrl && (
          <small className="hint">Get a free key at <a href={preset.keyUrl} target="_blank" rel="noreferrer">{preset.keyUrl.replace("https://", "")}</a> (sign in, “Create API key”, copy it), then paste it below.</small>
        )}
      </div>
      <label className="field">
        <span>Server address</span>
        <input type="text" inputMode="url" placeholder="http://192.168.1.20:8080" value={draft.server_url ?? ""} autoComplete="off" spellCheck={false}
               onChange={(e) => set("server_url", e.target.value)} />
        <small className="hint">Your laptop running llama-server (start it with <code>--host 0.0.0.0</code>), Ollama, or any OpenAI-compatible API. Leave empty to use only the demo model.</small>
      </label>
      <label className="field">
        <span>API key{preset?.needsKey ? "" : " (optional)"}</span>
        <input type="password" value={draft.api_key ?? ""} autoComplete="off" onChange={(e) => set("api_key", e.target.value)} />
        <small className="hint">Stored only on this device.</small>
      </label>
      <div className="conn-row">
        <button type="button" className="btn small" onClick={test} disabled={state.kind === "testing" || !draft.server_url} aria-busy={state.kind === "testing"}>
          {state.kind === "testing" && <span className="spinner" aria-hidden="true" />}Test connection
        </button>
        <span role="status" className={state.kind === "error" ? "conn-err" : state.kind === "ok" ? "conn-ok" : ""}>{state.text}</span>
      </div>
    </fieldset>
  );
}

function ClearData() {
  const [done, setDone] = useState(false);
  return (
    <p className="muted small-text">
      Chats are stored only on this device.{" "}
      <button type="button" className="btn-link" onClick={async () => {
        if (!window.confirm("Delete all chats and files stored on this device?")) return;
        await clearAllLocalData();
        setDone(true);
        window.location.hash = "#/";
        window.location.reload();
      }}>{done ? "Cleared" : "Delete all local chats"}</button>
    </p>
  );
}
