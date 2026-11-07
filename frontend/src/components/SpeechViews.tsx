import { useEffect, useState } from "react";
import { speech, type SpeechState, type VoiceOption, type VoiceSettings } from "../speech/player";
import { serverCatalog } from "../speech/setup";
import type { SpeechLang } from "../speech/text";
import { Icon } from "./Icon";

export function useSpeech(): SpeechState {
  const [s, setS] = useState(speech.state);
  useEffect(() => speech.subscribe(setS), []);
  return s;
}

const active = (s: SpeechState, id: string) => s.messageId === id && (s.status === "loading" || s.status === "playing" || s.status === "paused");

/** Play / Pause / Resume / Stop / Replay for one reply. */
export function SpeakControls({ id, text }: { id: string; text: string }) {
  const s = useSpeech();
  const on = active(s, id);
  const errorHere = s.messageId === id && s.status === "error";
  if (!on) {
    return (
      <>
        <button type="button" className="icon-btn" aria-label="Read aloud" title="Read aloud"
                onClick={() => { speech.unlock(); speech.play(id, text); }}>
          <Icon name="speaker" size={16} />
        </button>
        {errorHere && <span className="speak-error" role="alert">{s.error}</span>}
      </>
    );
  }
  return (
    <span className="speak-ctl" role="group" aria-label="Speech controls">
      {s.status === "paused"
        ? <button type="button" className="icon-btn on" aria-label="Resume reading" title="Resume" onClick={() => speech.resume()}><Icon name="play" size={16} /></button>
        : <button type="button" className="icon-btn on" aria-label="Pause reading" title="Pause" onClick={() => speech.pause()}><Icon name="pause" size={16} /></button>}
      <button type="button" className="icon-btn" aria-label="Stop reading" title="Stop" onClick={() => speech.stop()}><Icon name="stop" size={16} /></button>
      <button type="button" className="icon-btn" aria-label="Replay from the start" title="Replay" onClick={() => { speech.unlock(); speech.replay(id, text); }}><Icon name="replay" size={16} /></button>
      <span className="muted small-text" aria-live="off">
        {s.status === "loading" && s.index === 0 ? "Preparing voice…" : `${Math.min(s.index + 1, Math.max(s.total, 1))} / ${s.total}${s.streaming ? "+" : ""}`}
      </span>
    </span>
  );
}

/** The sentence being spoken, with the current word marked when the engine reports word timing. */
export function NowSpeaking({ id }: { id: string }) {
  const s = useSpeech();
  if (!active(s, id) || !s.current) return null;
  const t = s.current.text;
  const w = s.word && s.word.len > 0 ? s.word : s.word ? { start: s.word.start, len: (t.slice(s.word.start).match(/^\S+/)?.[0].length || 0) } : null;
  return (
    <p className={`now-speaking${s.status === "paused" ? " paused" : ""}`} lang={s.current.lang === "hi" ? "hi" : "en"} aria-hidden="true">
      {w ? <>{t.slice(0, w.start)}<mark>{t.slice(w.start, w.start + w.len)}</mark>{t.slice(w.start + w.len)}</> : <mark className="whole">{t}</mark>}
    </p>
  );
}

export function AutoSpeakToggle() {
  const [on, setOn] = useState(speech.settings.autoSpeak);
  useSpeech();
  return (
    <button type="button" className={`icon-btn${on ? " on" : ""}`} aria-pressed={on} title={on ? "Auto-speak is on" : "Speak replies automatically"}
            aria-label="Speak replies automatically"
            onClick={() => {
              const next = !on;
              speech.unlock();
              speech.updateSettings({ ...speech.settings, autoSpeak: next });
              if (!next) speech.stop();
              setOn(next);
            }}>
      <Icon name={on ? "speaker" : "speakerOff"} />
    </button>
  );
}

const LANGS: { code: "auto" | SpeechLang; name: string }[] = [
  { code: "auto", name: "Detect automatically" }, { code: "en", name: "English" }, { code: "hi", name: "Hindi" },
  { code: "hinglish", name: "Hinglish (Hindi in English letters)" }, { code: "es", name: "Spanish" }, { code: "fr", name: "French" },
  { code: "it", name: "Italian" }, { code: "pt", name: "Portuguese" },
];
const ENGINE_LABEL = { server: "Server voices (neural)", native: "This phone's voices", browser: "This browser's voices" };

export function VoiceSettingsPanel() {
  const [s, setS] = useState<VoiceSettings>(speech.settings);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  useSpeech();
  const set = (p: Partial<VoiceSettings>) => { const n = { ...s, ...p }; setS(n); speech.updateSettings(n); };
  const eng = speech.engine();
  useEffect(() => { let live = true; speech.voices().then((v) => live && setVoices(v)); return () => { live = false; }; }, [s.engine, eng?.id]);
  const avail = speech.available();
  const cat = serverCatalog();
  const forLang = (l: SpeechLang) => voices.filter((v) => v.engine === "server" || v.engine === "kokoro" || v.engine === "gemini" || v.engine === "openai"
    ? v.langs.includes(l) : v.langs.some((x) => x.startsWith(l === "hinglish" ? "en-in" : l === "hi" ? "hi" : l)));
  const notes = eng?.id === "server" ? cat?.engines.filter((e) => e.ready).flatMap((e) => e.notes) || [] : [];
  return (
    <fieldset>
      <legend>Voice</legend>
      {!eng ? <p className="form-error" role="alert">{speech.whyUnavailable()}</p> : <>
        <label className="field"><span>Read replies with</span>
          <select value={s.engine} onChange={(e) => set({ engine: e.target.value as VoiceSettings["engine"], voices: {} })}>
            <option value="auto">Automatic ({ENGINE_LABEL[eng.id]})</option>
            {avail.map((id) => <option key={id} value={id}>{ENGINE_LABEL[id]}</option>)}
          </select>
          {eng.id === "server" && cat && <small className="hint">Using {cat.engines.filter((x) => x.ready).map((x) => `${x.name} (${x.model})`).join(", ")}.</small>}
          {eng.id === "native" && <small className="hint">Uses your phone's text-to-speech engine. Install Hindi voice data in Android Settings → Text-to-speech if Hindi is silent.</small>}
        </label>
        <label className="check"><input type="checkbox" checked={s.autoSpeak} onChange={(e) => { speech.unlock(); set({ autoSpeak: e.target.checked }); }} /> Speak replies automatically</label>
        <label className="field"><span>Language</span>
          <select value={s.lang} onChange={(e) => set({ lang: e.target.value as VoiceSettings["lang"] })}>
            {LANGS.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
          </select>
          <small className="hint">Automatic picks Hindi for Devanagari, Hinglish for Hindi typed in English letters, English otherwise — per sentence, so mixed replies switch voice.</small>
        </label>
        {eng.id === "server" ? (
          <div className="field"><span id="g-label">Voice type</span>
            <div className="segmented" role="radiogroup" aria-labelledby="g-label">
              {(["female", "male"] as const).map((g) => (
                <label key={g} className={s.gender === g ? "on" : ""}>
                  <input type="radio" name="voice-gender" checked={s.gender === g} onChange={() => set({ gender: g, voices: {} })} />
                  {g === "female" ? "Female-sounding" : "Male-sounding"}
                </label>))}
            </div>
          </div>
        ) : <p className="muted small-text">Your device doesn't say which of its voices sound male or female — pick one below and press Test.</p>}
        {(["en", "hi", "hinglish"] as SpeechLang[]).map((l) => (
          <div key={l} className="field voice-row">
            <label htmlFor={`voice-${l}`}>{l === "en" ? "English voice" : l === "hi" ? "Hindi voice" : "Hinglish voice"}</label>
            <div className="conn-row">
              <select id={`voice-${l}`} value={s.voices[l] || ""} onChange={(e) => set({ voices: { ...s.voices, [l]: e.target.value || undefined } })}>
                <option value="">Automatic</option>
                {forLang(l).filter((v) => eng.id !== "server" || s.gender === v.gender || v.gender === "unspecified").map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
              </select>
              <button type="button" className="btn small" onClick={() => { speech.unlock(); speech.test(l); }}>Test</button>
            </div>
          </div>
        ))}
        <div className="field">
          <span><label htmlFor="v-speed">Speed</label>: <output htmlFor="v-speed">{s.speed.toFixed(2)}×</output></span>
          <input id="v-speed" type="range" min={0.5} max={2} step={0.05} value={s.speed} onChange={(e) => set({ speed: Number(e.target.value) })} />
        </div>
        {eng.caps.pitch ? (
          <div className="field">
            <span><label htmlFor="v-pitch">Pitch</label>: <output htmlFor="v-pitch">{s.pitch.toFixed(2)}</output></span>
            <input id="v-pitch" type="range" min={0.5} max={2} step={0.05} value={s.pitch} onChange={(e) => set({ pitch: Number(e.target.value) })} />
          </div>
        ) : <p className="muted small-text">Pitch: not adjustable with server voices (none of the server engines offer it).</p>}
        <div className="field">
          <span><label htmlFor="v-volume">Volume</label>: <output htmlFor="v-volume">{Math.round(s.volume * 100)}%</output></span>
          <input id="v-volume" type="range" min={0} max={1} step={0.05} value={s.volume} onChange={(e) => set({ volume: Number(e.target.value) })} />
        </div>
        {eng.caps.style ? (
          <label className="field"><span>Speaking style (optional)</span>
            <input type="text" maxLength={120} placeholder="e.g. warm and friendly, calm, cheerful" value={s.style} onChange={(e) => set({ style: e.target.value })} />
            <small className="hint">Used by Gemini / OpenAI voices only; the local Kokoro voice reads every style the same way.</small>
          </label>
        ) : null}
        {notes.map((n) => <p key={n} className="muted small-text">{n}</p>)}
        <p className="muted small-text">Voice settings are saved on this device straight away.</p>
      </>}
    </fieldset>
  );
}
