import { useEffect, useId, useState } from "react";
import { api } from "../api/client";
import { asPage, appName } from "../apk/apk";
import { aiListing, draftListing, hasUploadKey, makePlayPackage, nextVersionCode, packageProblem, playAvailable, rememberVersion,
  sharePlay, suggestPackage, type PlayResult } from "../apk/play";
import { fileSize } from "../lib/format";
import { Modal } from "./Dialogs";
import { Icon } from "./Icon";

const COLOURS = ["#0060E6", "#1F4E8C", "#7A3E9D", "#B4441F", "#2E7D32", "#8C5A00", "#00796B", "#37474F"];
function javaHash(s: string) { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; return h; }
const colourFor = (name: string) => COLOURS[Math.abs(javaHash(name)) % COLOURS.length];

export interface PlayTarget { html: string; name?: string; icon?: string | null; error?: string }

/** "Google Play package": a web page (or an app zenvqo made) → a folder with the .aab, store listing, pictures, privacy
 *  policy, data-safety answers, upload key and a step-by-step guide for Google Play Console. */
export function PlayDialog({ target, onClose }: { target: PlayTarget; onClose: () => void }) {
  const titleId = useId();
  const [name, setName] = useState(() => (target.name || appName(target.html)).slice(0, 30));
  const [pkg, setPkg] = useState(() => suggestPackage(target.name || appName(target.html)));
  const [pkgTouched, setPkgTouched] = useState(false);
  const [versionCode, setVersionCode] = useState(1);
  const [versionName, setVersionName] = useState("1.0");
  const [picture, setPicture] = useState<string>(target.icon || "");
  const [draft] = useState(() => draftListing(target.html, (target.name || appName(target.html)).slice(0, 30)));
  const [short, setShort] = useState(draft.short);
  const [full, setFull] = useState(draft.full);
  const [email, setEmail] = useState("");
  const [writing, setWriting] = useState(false);
  const [aiNote, setAiNote] = useState("");
  const [step, setStep] = useState<"form" | "building" | "done">("form");
  const [doing, setDoing] = useState("");
  const [error, setError] = useState(target.error || "");
  const [result, setResult] = useState<PlayResult | null>(null);
  const avail = playAvailable();
  const problem = packageProblem(pkg);
  const update = !problem && hasUploadKey(pkg);

  useEffect(() => { if (!pkgTouched) setPkg(suggestPackage(name)); }, [name, pkgTouched]);
  useEffect(() => {                                                    // a new package starts at 1; an update goes up by one
    if (problem) return;
    const n = nextVersionCode(pkg);
    setVersionCode(n);
    setVersionName(n === 1 ? "1.0" : `1.${n - 1}`);
  }, [pkg, problem]);

  async function write() {
    setWriting(true);
    setAiNote("");
    const r = await aiListing(target.html, name, (p) => api.quickText(p));
    setWriting(false);
    if (r) { setShort(r.short); setFull(r.full); setAiNote("Written by your AI — read it and change anything that isn't right."); }
    else setAiNote("Your AI couldn't write it right now (set one up in Settings → Connection). The draft from the page is kept.");
  }

  function pick(f: File | undefined) {
    if (!f) return;
    const r = new FileReader();
    r.onload = () => setPicture(String(r.result || ""));
    r.readAsDataURL(f);
  }

  async function make() {
    if (problem || !name.trim()) return;
    setError("");
    setStep("building");
    setDoing("Making the app bundle…");
    try {
      const label = name.trim();
      const r = await makePlayPackage({ html: asPage(target.html, label), name: label, pkg, versionCode, versionName: versionName.trim() || "1.0",
        icon: picture ? picture.split(",", 2)[1] : "", short: short.trim(), full: full.trim(), email: email.trim(), website: "" }, setDoing);
      rememberVersion(pkg, versionCode);
      setResult(r);
      setStep("done");
    } catch (e) {
      setError((e as Error).message || "Couldn't make the Google Play package.");
      setStep("form");
    }
  }

  const busy = step === "building";
  const label = name.trim() || "My app";
  if (!target.html) {
    return (
      <Modal open onClose={onClose} title="Google Play package" labelledBy={titleId}>
        <p className="form-error" role="alert">{target.error || "This file isn't an app made from a web page."}</p>
        <p className="muted small-text">zenvqo can turn apps made from a web page (like the ones “Make app” builds) into a Google Play package.
          Other APKs have to be rebuilt as an App Bundle from their source project — in Android Studio: Build → Generate Signed App Bundle.</p>
        <div className="modal-actions"><button type="button" className="btn primary" onClick={onClose}>OK</button></div>
      </Modal>
    );
  }
  return (
    <Modal open onClose={() => { if (!busy) onClose(); }} title="Google Play package" labelledBy={titleId}>
      <div className="make-app play">
        <div className="app-preview" aria-hidden="true">
          <div className="app-icon" style={picture ? { backgroundImage: `url(${picture})` } : { background: colourFor(label) }}>
            {!picture && <span>{[...label][0]?.toUpperCase()}</span>}
          </div>
          <span className="app-icon-name">{label}</span>
        </div>

        {step !== "done" ? (
          <>
            <p className="muted small-text make-app-lede">Makes a folder with everything Google Play Console needs: the app as an
              App Bundle (.aab), store pictures and screenshots, the listing texts, a privacy policy, data-safety answers and a step-by-step guide.</p>
            <label className="field"><span>App name <em className="count">{name.length}/30</em></span>
              <input value={name} maxLength={30} onChange={(e) => setName(e.target.value)} disabled={busy} />
            </label>
            <label className="field"><span>Package name</span>
              <input value={pkg} onChange={(e) => { setPkgTouched(true); setPkg(e.target.value.trim()); }} disabled={busy} spellCheck={false}
                     autoCapitalize="off" aria-invalid={!!problem} aria-describedby={`${titleId}-pkg`} />
              <small id={`${titleId}-pkg`} className={problem ? "form-error" : "muted small-text"}>
                {problem || (update ? "You made this app before: this will be an update, signed with the same key."
                  : "Your app's ID on Google Play. It must be unique and can never be changed after the first upload.")}
              </small>
            </label>
            <div className="field-row">
              <label className="field"><span>Version code</span>
                <input type="number" min={1} value={versionCode} onChange={(e) => setVersionCode(Math.max(1, Math.floor(+e.target.value || 1)))} disabled={busy} />
              </label>
              <label className="field"><span>Version name</span>
                <input value={versionName} maxLength={20} onChange={(e) => setVersionName(e.target.value)} disabled={busy} />
              </label>
            </div>
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
            <label className="field"><span>Short description <em className="count">{short.length}/80</em></span>
              <input value={short} maxLength={80} onChange={(e) => setShort(e.target.value)} disabled={busy} />
            </label>
            <label className="field"><span>Full description <em className="count">{full.length}/4000</em></span>
              <textarea value={full} maxLength={4000} rows={6} onChange={(e) => setFull(e.target.value)} disabled={busy} />
            </label>
            <div className="icon-pick">
              <button type="button" className="btn small" onClick={() => void write()} disabled={busy || writing}>
                {writing ? <><span className="spinner" /> Writing…</> : <><Icon name="wand" size={16} /> Write with AI</>}
              </button>
              {aiNote && <span className="muted small-text" role="status">{aiNote}</span>}
            </div>
            <label className="field"><span>Your email <span className="muted">(optional — for the privacy policy and store page)</span></span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} autoComplete="email" />
            </label>
            {!avail.ok && <p className="form-error" role="alert">{avail.reason}</p>}
            {error && <p className="form-error" role="alert">{error}</p>}
            <div className="modal-actions">
              <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
              <button type="button" className="btn primary" onClick={() => void make()} disabled={busy || !avail.ok || !!problem || !name.trim()}>
                {busy ? <><span className="spinner" /> {doing}</> : <><Icon name="download" size={16} /> Make package</>}
              </button>
            </div>
          </>
        ) : result && (
          <>
            <p className="make-app-done" role="status">
              <Icon name="check" size={18} />
              <span><strong>{label}</strong> is ready for Google Play ({fileSize(result.size)}){result.saved ? <> — saved in <strong>{result.saved}</strong></> : null}.</span>
            </p>
            <ul className="play-files">
              <li><Icon name="archive" size={16} /> <span><strong>{result.aabName}</strong> — the app to upload ({fileSize(result.aab)}), version {result.versionName} ({result.versionCode})</span></li>
              <li><Icon name="image" size={16} /> <span>Store icon, feature graphic and {result.shots} screenshot{result.shots === 1 ? "" : "s"}{result.shots < 2 ? " (Play needs 2 — add one from your phone)" : ""}</span></li>
              <li><Icon name="doc" size={16} /> <span>Listing texts, privacy policy, data-safety answers and HOW-TO-PUBLISH.txt</span></li>
              <li><Icon name="pin" size={16} /> <span>Upload key ({result.newKey ? "new" : "same as before"}) — keep it private and keep a copy safe</span></li>
            </ul>
            <p className="muted small-text">Unzip it, then follow HOW-TO-PUBLISH.txt: create the app in Play Console, fill in the listing, and upload the .aab.
              New personal developer accounts must first run a closed test with 12 testers for 14 days.</p>
            <div className="modal-actions">
              {result.saved && <button type="button" className="btn" onClick={() => sharePlay(result.id)}><Icon name="share" size={16} /> Share</button>}
              <button type="button" className="btn primary" onClick={onClose}>Done</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
