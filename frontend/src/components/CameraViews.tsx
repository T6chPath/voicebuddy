// Take a photo with the phone/laptop camera, inside the app: live viewfinder, switch front/back, capture, then crop, resize
// or rotate it (PhotoCrop) — retake or use it.
// The photo goes into the message like an attached image; the AI explains it when the message is sent.
// Nothing is recorded or kept: the camera runs only while this window is open, and only the photo you choose is used.
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { PhotoCrop } from "./PhotoCrop";

type Facing = "environment" | "user";
type Phase = "starting" | "live" | "preview" | "error";

const MAX_SIDE = 2048;                      // sharp enough to read printed text, small enough to send quickly

export function cameraSupported(): boolean {
  return !!navigator.mediaDevices?.getUserMedia;
}

function cameraError(e: unknown): string {
  const name = (e as Error)?.name || "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Camera permission was denied. Allow the camera for zenvqo in your phone's settings, then try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera was found on this device.";
  if (name === "NotReadableError" || name === "AbortError") return "The camera is busy — close other apps that use it and try again.";
  return "The camera couldn't be started.";
}

export function CameraDialog({ onPhoto, onClose }: { onPhoto: (f: File) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const fallback = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const [facing, setFacing] = useState<Facing>("environment");
  const [phase, setPhase] = useState<Phase>("starting");
  const [error, setError] = useState("");
  const [shot, setShot] = useState<{ url: string; blob: Blob } | null>(null);
  const [cameras, setCameras] = useState(0);

  const stop = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }, []);

  const start = useCallback(async (want: Facing) => {
    stop();
    setPhase("starting");
    setError("");
    if (!cameraSupported()) { setPhase("error"); setError("This browser can't open the camera here."); return; }
    try {
      let s: MediaStream;
      try {
        s = await navigator.mediaDevices.getUserMedia({ audio: false,
          video: { facingMode: { ideal: want }, width: { ideal: 1920 }, height: { ideal: 1080 } } });
      } catch (e) {
        if ((e as Error).name !== "OverconstrainedError") throw e;
        s = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
      }
      stream.current = s;
      const v = video.current;
      if (v) { v.srcObject = s; await v.play().catch(() => {}); }
      setPhase("live");
      navigator.mediaDevices.enumerateDevices?.().then((d) => setCameras(d.filter((x) => x.kind === "videoinput").length)).catch(() => {});
    } catch (e) {
      setPhase("error");
      setError(cameraError(e));
    }
  }, [stop]);

  useEffect(() => { void start(facing); }, [facing, start]);
  useEffect(() => () => stop(), [stop]);
  useEffect(() => () => { if (shot?.url) URL.revokeObjectURL(shot.url); }, [shot]);
  useEffect(() => {                                   // Escape closes; focus starts inside the dialog
    dialog.current?.focus();
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);

  function capture() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const k = Math.min(1, MAX_SIDE / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(v.videoWidth * k);
    c.height = Math.round(v.videoHeight * k);
    const ctx = c.getContext("2d")!;
    if (facing === "user") { ctx.translate(c.width, 0); ctx.scale(-1, 1); }   // selfie preview is mirrored; keep the photo as seen
    ctx.drawImage(v, 0, 0, c.width, c.height);
    c.toBlob((b) => {
      if (!b) return;
      stop();                                         // camera off while you look at the photo
      setShot({ url: URL.createObjectURL(b), blob: b });
      setPhase("preview");
    }, "image/jpeg", 0.9);
  }

  function use(b: Blob) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    onPhoto(new File([b], `photo-${stamp}.jpg`, { type: "image/jpeg" }));
    onClose();
  }

  function retake() {
    setShot(null);
    void start(facing);
  }

  return (
    <div className="camera-backdrop" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="camera" role="dialog" aria-modal="true" aria-label="Take a photo" ref={dialog} tabIndex={-1}>
        {phase === "preview" && shot ? (
          <>
            <PhotoCrop photo={shot.blob} alt="The photo you took" backLabel="Retake" onBack={retake} onUse={(b) => use(b)} />
            <p className="camera-note">Drag the corners to crop to just your question, then tap <strong>Use photo</strong>.</p>
          </>
        ) : <>
        <div className="camera-view">
          <video ref={video} playsInline muted aria-label="Camera preview" className={facing === "user" ? "mirror" : ""}
                 hidden={phase === "error"} />
          {phase === "starting" && <p className="camera-msg" role="status">Starting the camera…</p>}
          {phase === "error" && (
            <div className="camera-msg" role="alert">
              <p>{error}</p>
              <button type="button" className="btn" onClick={() => fallback.current?.click()}>Choose a photo instead</button>
              <input ref={fallback} type="file" accept="image/*" capture="environment" hidden
                     onChange={(e) => { const f = e.target.files?.[0]; if (f) { setShot({ url: "", blob: f }); setPhase("preview"); } }} />
            </div>
          )}
        </div>
        <div className="camera-bar">
          <button type="button" className="icon-btn" aria-label="Close camera" onClick={onClose}><Icon name="close" /></button>
          <button type="button" className="shutter" aria-label="Take photo" onClick={capture} disabled={phase !== "live"} />
          <button type="button" className="icon-btn" aria-label={facing === "environment" ? "Switch to front camera" : "Switch to back camera"}
                  onClick={() => setFacing((f) => (f === "environment" ? "user" : "environment"))} disabled={phase === "starting" || cameras === 1}>
            <Icon name="flip" />
          </button>
        </div>
        <p className="camera-note">Point at your question. The camera is on only while this window is open; nothing is saved until you tap <strong>Use photo</strong>.</p>
        </>}
      </div>
    </div>
  );
}
