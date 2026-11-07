import { api, LOCAL_MODE, ttsSpeak } from "../api/client";
import type { TTSCatalog } from "../api/types";
import { BrowserEngine, NativeEngine, ServerEngine, speech, type VoiceOption } from "./player";

let catalog: TTSCatalog | null = null;
let ready: Promise<void> | null = null;
let serverLoaded = false;

/** Register the device engines (Android TTS bridge or the browser's Web Speech). */
export function setupSpeech(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    if (window.ZenvqoTTS) speech.register(new NativeEngine(window.ZenvqoTTS));                // Android app
    else if (typeof window.speechSynthesis === "object" && typeof window.SpeechSynthesisUtterance === "function") speech.register(new BrowserEngine());
  })();
  return ready;
}

/** Server voices need a signed-in session: call once the chat is showing. */
export async function loadServerVoices(): Promise<void> {
  await setupSpeech();
  if (LOCAL_MODE || serverLoaded) return;
  serverLoaded = true;
  {
    {
      try {
        catalog = await api.ttsVoices();
        if (catalog.available) {
          const ready = catalog.engines.filter((e) => e.ready);
          speech.register(new ServerEngine(ttsSpeak, async () => (catalog?.voices || []) as VoiceOption[],
            { speed: ready.some((e) => e.speed), style: ready.some((e) => e.style) }));
          speech.setServerReason(null);
        } else speech.setServerReason(catalog.reason);
      } catch { serverLoaded = false; speech.setServerReason("the server's voice list couldn't be loaded"); }
    }
  }
}

export const serverCatalog = () => catalog;
