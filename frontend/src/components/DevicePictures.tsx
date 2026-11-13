import { useEffect, useState } from "react";
import type { UserSettings } from "../api/types";
import { DEVICE_MODELS, QUALITY, TAESD, deviceBridge, deviceInfo, downloadModel, type DeviceInfo, type DeviceModel } from "../images/device";

type Set = <K extends keyof UserSettings>(k: K, v: UserSettings[K]) => void;

const mb = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} GB` : `${Math.round(n)} MB`);

/** Settings → Pictures on this phone: download the picture model once, then pictures are made without internet. */
export function DevicePicturesPanel({ draft, set }: { draft: UserSettings; set: Set }) {
  const [info, setInfo] = useState<DeviceInfo | null>(() => deviceInfo());
  const [dl, setDl] = useState<{ id: string; done: number; total: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const refresh = () => setInfo(deviceInfo());
  useEffect(() => { refresh(); }, []);
  if (!deviceBridge()) return null;
  if (!info?.engine) {
    return (
      <fieldset>
        <legend>Pictures on this phone</legend>
        <p className="muted small-text">This copy of the app doesn't include the picture maker for this phone ({info?.abi || "unknown processor"}). Pictures are made by the free online service.</p>
      </fieldset>
    );
  }
  const has = (m: DeviceModel) => (info.files[m.file] || 0) > m.mb * 0.5 * 1048576;
  const ready = DEVICE_MODELS.filter(has);
  const chosen = ready.find((m) => m.id === draft.device_model) || ready[0];

  async function get(m: DeviceModel) {
    setErr(null);
    if (info && info.freeMB < m.mb + 300) { setErr(`Not enough free space: the model needs ${mb(m.mb)} and the phone has ${mb(info.freeMB)} free.`); return; }
    setDl({ id: m.id, done: 0, total: m.mb * 1048576 });
    try {
      await downloadModel(m, (done, total, what) => setDl({ id: m.id, done: what === TAESD.file ? total : done, total }));
      set("device_model", m.id);
      if (!draft.image_engine) set("image_engine", "auto");
    } catch (e) {
      const msg = (e as Error).message;
      if (msg !== "cancelled") setErr(`The download stopped: ${msg}. Tap Download again to continue where it stopped.`);
    } finally {
      setDl(null);
      refresh();
    }
  }
  function remove(m: DeviceModel) {
    if (!window.confirm(`Delete ${m.label} from this phone? (${mb(m.mb)})`)) return;
    deviceBridge()!.remove(m.file);
    refresh();
  }

  return (
    <fieldset className="device-pictures">
      <legend>Pictures on this phone</legend>
      <p className="muted small-text">
        Download a picture model once and your phone makes pictures by itself — no internet, nothing sent anywhere.
        SDXS makes a picture in seconds; SD-Turbo takes longer and draws more detail. This phone: {mb(info.ramMB)} memory, {mb(info.freeMB)} free space.
      </p>
      <ul className="device-models">
        {DEVICE_MODELS.map((m) => {
          const here = has(m), going = dl?.id === m.id;
          const low = info.ramMB < m.minRamMB;
          return (
            <li key={m.id}>
              <div>
                <strong>{m.label}</strong> <span className="muted">({mb(m.mb)})</span>
                {here && <span className="chip ok">Downloaded</span>}
                <div className="muted small-text">{m.note}{low ? " This phone may not have enough memory for it." : ""}</div>
                {going && dl && (
                  <div className="dl-progress">
                    <progress max={dl.total} value={dl.done} aria-label={`Downloading ${m.label}`} />
                    <span className="small-text">{mb(dl.done / 1048576)} of {mb(dl.total / 1048576)}</span>
                  </div>
                )}
              </div>
              <div className="device-model-actions">
                {going ? <button type="button" className="btn small" onClick={() => deviceBridge()!.cancelDownload()}>Cancel</button>
                  : here ? <button type="button" className="btn small" onClick={() => remove(m)}>Delete</button>
                  : <button type="button" className="btn small primary" disabled={!!dl} onClick={() => get(m)}>Download</button>}
              </div>
            </li>
          );
        })}
      </ul>
      {err && <p className="form-error" role="alert">{err}</p>}
      {ready.length > 0 && <>
        {ready.length > 1 && (
          <label className="field"><span>Model to use</span>
            <select value={chosen?.id} onChange={(e) => set("device_model", e.target.value)}>
              {ready.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </select>
          </label>
        )}
        {chosen?.oneStep && (
          <label className="check">
            <input type="checkbox" checked={draft.device_best !== false} onChange={(e) => set("device_best", e.target.checked)} />
            Best of 2: draw two pictures and keep the one that matches your words best (needs your chat AI; about twice as long)
          </label>
        )}
        <label className="field"><span>Picture size</span>
          <select value={draft.device_size || "auto"} onChange={(e) => set("device_size", e.target.value as UserSettings["device_size"])}>
            <option value="auto">Quick — under 10 seconds (smaller on a slow phone)</option>
            <option value="full">Full size, 512×512 — slower</option>
          </select>
        </label>
        {!chosen?.oneStep && <label className="field"><span>Quality</span>
          <select value={draft.device_quality || "fast"} onChange={(e) => set("device_quality", e.target.value as UserSettings["device_quality"])}>
            {Object.entries(QUALITY).map(([k, q]) => <option key={k} value={k}>{q.label}</option>)}
          </select>
        </label>}
      </>}
      <div className="field">
        <span id="engine-label">Make pictures</span>
        <div className="segmented" role="radiogroup" aria-labelledby="engine-label">
          {([["auto", "Automatic"], ["device", "Phone only"], ["online", "Online"]] as const).map(([v, label]) => (
            <label key={v} className={(draft.image_engine || "auto") === v ? "on" : ""}>
              <input type="radio" name="image_engine" value={v} checked={(draft.image_engine || "auto") === v} onChange={() => set("image_engine", v)} />
              {label}
            </label>
          ))}
        </div>
        <small className="hint">
          {(draft.image_engine || "auto") === "auto" ? "Uses this phone once a model is downloaded (and the online service if that fails)."
            : draft.image_engine === "device" ? "Never uses the internet for pictures." : "Always uses the free online service."}
        </small>
      </div>
    </fieldset>
  );
}
