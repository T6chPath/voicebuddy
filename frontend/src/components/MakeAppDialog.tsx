import { useEffect, useId, useState } from "react";
import { apkAvailable, appName, asPage, buildApk, installApk, openApp, shareApk, type BuiltApp } from "../apk/apk";
import { fileSize } from "../lib/format";
import { Modal } from "./Dialogs";
import { Icon } from "./Icon";

// same colours and choice as the Android side (NativeApk.letterIcon), so the preview matches the real icon
const COLOURS = ["#0060E6", "#1F4E8C", "#7A3E9D", "#B4441F", "#2E7D32", "#8C5A00", "#00796B", "#37474F"];
function javaHash(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; return h; }
const colourFor = (name: string) => COLOURS[Math.abs(javaHash(name)) % COLOURS.length];

type Step = "form" | "building" | "built" | "installing" | "installed";

/** "Make app": a web page → an Android app (APK) built on this phone, then installed with Android's own installer. */
export function MakeAppDialog({ html, onClose }: { html: string; onClose: () => void }) {
  const titleId = useId();
  const [name, setName] = useState(() => appName(html));
  const [picture, setPicture] = useState<string>("");             // data: URL of the chosen icon picture
  const [step, setStep] = useState<Step>("form");
  const [app, setApp] = useState<BuiltApp | null>(null);
  const [error, setError] = useState("");
  const avail = apkAvailable();
  const label = name.trim() || "My app";

  useEffect(() => { setError(""); }, [name]);

  async function make() {
    setError("");
    setStep("building");
    try {
      const icon = picture ? picture.split(",", 2)[1] : "";
      const a = await buildApk(asPage(html, label), label, icon);
      setApp(a);
      setStep("built");
    } catch (e) {
      setError((e as Error).message || "Couldn't make the app.");
      setStep("form");
    }
  }

  async function install() {
    if (!app) return;
    setError("");
    setStep("installing");
    try {
      await installApk(app.id);
      setStep("installed");
    } catch (e) {
      setError((e as Error).message);
      setStep("built");
    }
  }

  function pick(f: File | undefined) {
    if (!f) return;
    const r = new FileReader();
    r.onload = () => setPicture(String(r.result || ""));
    r.readAsDataURL(f);
  }

  const busy = step === "building" || step === "installing";
  return (
    <Modal open onClose={() => { if (!busy) onClose(); }} title="Make an Android app" labelledBy={titleId}>
      <div className="make-app">
        <div className="app-preview" aria-hidden="true">
          <div className="app-icon" style={picture ? { backgroundImage: `url(${picture})` } : { background: colourFor(label) }}>
            {!picture && <span>{[...label][0]?.toUpperCase()}</span>}
          </div>
          <span className="app-icon-name">{label}</span>
        </div>

        {step === "form" || step === "building" ? (
          <>
            <p className="muted small-text make-app-lede">This page becomes an app on your phone: it opens full screen from its own icon and works offline.</p>
            <label className="field"><span>App name</span>
              <input value={name} maxLength={50} onChange={(e) => setName(e.target.value)} disabled={busy} />
            </label>
            <div className="field">
              <span>Icon</span>
              <div className="icon-pick">
                <label className="btn small">
                  <Icon name="image" size={16} /> {picture ? "Change picture" : "Use a picture"}
                  <input type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0])} disabled={busy} />
                </label>
                {picture && <button type="button" className="btn small" onClick={() => setPicture("")} disabled={busy}>Use the letter</button>}
              </div>
            </div>
            <p className="muted small-text">Page size: {fileSize(new Blob([html]).size)}</p>
            {!avail.ok && <p className="form-error" role="alert">{avail.reason}</p>}
            {error && <p className="form-error" role="alert">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
              <button type="button" className="btn primary" onClick={make} disabled={busy || !avail.ok}>
                {step === "building" ? <><span className="spinner" /> Making the app…</> : <><Icon name="download" size={16} /> Make app</>}
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="make-app-done" role="status">
              <Icon name="check" size={18} />
              {step === "installed" ? <span><strong>{app?.name}</strong> is installed. You'll find it with your other apps.</span>
                : <span><strong>{app?.name}</strong> is ready ({fileSize(app?.size || 0)}){app?.saved ? <> and saved in {app.saved}</> : null}.</span>}
            </p>
            {step !== "installed" && <p className="muted small-text">The first time, Android asks you to allow zenvqo to install apps — allow it, then tap Install again.</p>}
            {error && <p className="form-error" role="alert">{error}</p>}
            <div className="modal-actions">
              {app?.saved && <button type="button" className="btn" onClick={() => app && shareApk(app.id)}><Icon name="share" size={16} /> Share</button>}
              {step === "installed"
                ? <button type="button" className="btn primary" onClick={() => app && openApp(app.id)}>Open app</button>
                : <button type="button" className="btn primary" onClick={install} disabled={step === "installing"}>
                    {step === "installing" ? <><span className="spinner" /> Installing…</> : "Install"}
                  </button>}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
