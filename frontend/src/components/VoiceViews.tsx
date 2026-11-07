import { useEffect, useState, type KeyboardEvent, type PointerEvent } from "react";
import { voice, type Phase, type VoiceInputSettings, type VoiceState } from "../voice/session";
import { Icon } from "./Icon";

export function useVoice(): VoiceState {
  const [s, setS] = useState(voice.state);
  useEffect(() => voice.subscribe(setS), []);
  return s;
}

function phaseText(s: VoiceState): string {
  const t: Record<Phase, string> = {
    off: "", starting: "Starting the microphone…", error: "Voice mode stopped",
    listening: s.muted ? "Muted — unmute to talk" : "Listening… just speak",
    ptt: s.muted ? "Muted" : "Hold the mic button and talk",
    hearing: "Hearing you…", transcribing: "Transcribing…", thinking: "Thinking…",
    speaking: s.recognizer === "server" && voice.settings.bargeIn && s.handsFree ? "Speaking — talk to interrupt" : "Speaking — tap the mic to interrupt",
  };
  return t[s.phase];
}

const sec = (ms: number | null) => (ms == null ? "–" : `${(ms / 1000).toFixed(1)} s`);

export function VoicePanel() {
  const s = useVoice();
  if (s.phase === "off") return null;
  const ptt = !s.handsFree && s.phase !== "speaking" && s.phase !== "thinking";
  const last = s.turns[s.turns.length - 1];
  const orbProps = ptt ? {
    onPointerDown: (e: PointerEvent) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); voice.pttDown(); },
    onPointerUp: () => voice.pttUp(), onPointerCancel: () => voice.pttUp(),
    onKeyDown: (e: KeyboardEvent) => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); voice.pttDown(); } },
    onKeyUp: (e: KeyboardEvent) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); voice.pttUp(); } },
  } : { onClick: () => voice.tap() };
  const label = ptt ? "Hold to talk" : s.phase === "speaking" || s.phase === "thinking" ? "Interrupt and talk" : "Microphone";
  return (
    <section className={`voice-panel phase-${s.phase}`} aria-label="Voice conversation">
      <button type="button" className={`orb${s.micOn && !s.muted ? " live" : ""}`} aria-label={label} aria-pressed={ptt ? s.phase === "hearing" : undefined}
              style={{ ["--lvl" as string]: String(s.level) }} disabled={s.phase === "starting" || s.phase === "error" || s.phase === "transcribing"} {...orbProps}>
        <Icon name={s.muted ? "micOff" : "mic"} size={26} />
      </button>
      <div className="voice-status">
        <strong role="status" aria-live="polite">{phaseText(s)}</strong>
        {s.partial && <p className="voice-partial" aria-live="off">{s.partial}</p>}
        {s.error && <p className="form-error" role="alert">{s.error}</p>}
        {!s.error && s.notice && <p className="muted small-text">{s.notice}</p>}
        {last && (
          <p className="voice-latency muted small-text" data-heard-ms={last.heardMs ?? ""} data-audio-ms={last.firstAudioMs ?? ""}>
            Last turn: heard in {sec(last.heardMs)}{last.decodeMs != null ? ` (decode ${sec(last.decodeMs)})` : ""} · reply started {sec(last.firstTokenMs)} later ·
            voice after {sec(last.firstAudioMs)} · {last.transport}
          </p>
        )}
      </div>
      <div className="voice-ctl">
        <div className="segmented small" role="radiogroup" aria-label="Talking mode">
          <label className={s.handsFree ? "on" : ""}><input type="radio" name="vmode" checked={s.handsFree} onChange={() => voice.setHandsFree(true)} />Hands-free</label>
          <label className={!s.handsFree ? "on" : ""}><input type="radio" name="vmode" checked={!s.handsFree} onChange={() => voice.setHandsFree(false)} />Push-to-talk</label>
        </div>
        <button type="button" className={`btn small${s.muted ? " on" : ""}`} aria-pressed={s.muted} onClick={() => voice.setMuted(!s.muted)}
                disabled={s.phase === "error"}>
          <Icon name={s.muted ? "micOff" : "mic"} size={14} /> {s.muted ? "Unmute" : "Mute"}
        </button>
        <button type="button" className="btn small danger" onClick={() => voice.end()}><Icon name="hangup" size={14} /> End voice</button>
      </div>
    </section>
  );
}

export function MicIndicator() {
  const s = useVoice();
  if (!s.micOn || s.muted || s.phase === "off") return null;
  return <span className="rec-dot" role="status" title="The microphone is on">Mic on</span>;
}

export function VoiceInputPanel() {
  const [s, setS] = useState<VoiceInputSettings>(voice.settings);
  const [opts, setOpts] = useState(voice.options());
  useEffect(() => { void voice.loadServer().then(() => setOpts(voice.options())); }, []);
  const set = (p: Partial<VoiceInputSettings>) => { const n = { ...s, ...p }; setS(n); voice.updateSettings(n); };
  const name = { server: "Server (Whisper, live captions)", native: "This phone's speech recognition", browser: "This browser's speech recognition" };
  return (
    <fieldset>
      <legend>Voice input</legend>
      {!opts.length ? <p className="form-error" role="alert">{voice.whyUnavailable()}</p> : <>
        <label className="field"><span>Recognise speech with</span>
          <select value={s.engine} onChange={(e) => set({ engine: e.target.value as VoiceInputSettings["engine"] })}>
            <option value="auto">Automatic ({name[opts[0]]})</option>
            {opts.map((o) => <option key={o} value={o}>{name[o]}</option>)}
          </select>
          {opts.includes("browser") && <small className="hint">Browser recognition sends your audio to the browser maker's speech service.</small>}
        </label>
        <label className="field"><span>Spoken language</span>
          <select value={s.lang} onChange={(e) => set({ lang: e.target.value as VoiceInputSettings["lang"] })}>
            <option value="auto">Detect automatically</option><option value="en">English</option><option value="hi">Hindi</option>
            <option value="hinglish">Hinglish (mixed)</option>
          </select>
        </label>
        <div className="field">
          <span><label htmlFor="v-end">Pause before I answer</label>: <output htmlFor="v-end">{(s.endSilenceMs / 1000).toFixed(1)} s</output></span>
          <input id="v-end" type="range" min={400} max={2000} step={100} value={s.endSilenceMs} onChange={(e) => set({ endSilenceMs: Number(e.target.value) })} />
          <small className="hint">Shorter feels snappier; longer lets you pause mid-sentence (“matlab…”) without being cut off.</small>
        </div>
        <label className="check"><input type="checkbox" checked={s.handsFree} onChange={(e) => set({ handsFree: e.target.checked })} /> Hands-free (keep listening after each answer)</label>
        <label className="check"><input type="checkbox" checked={s.bargeIn} onChange={(e) => set({ bargeIn: e.target.checked })} /> Interrupt the assistant by speaking (server recognition)</label>
        <label className="check"><input type="checkbox" checked={s.noiseSuppression} onChange={(e) => set({ noiseSuppression: e.target.checked })} /> Reduce background noise</label>
        <p className="muted small-text">Audio is only captured while voice mode is on (you'll see “Mic on”). It's sent over the same secure connection as your chats, transcribed in memory, and never saved.</p>
      </>}
    </fieldset>
  );
}
