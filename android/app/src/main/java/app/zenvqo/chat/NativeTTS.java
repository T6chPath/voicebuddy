package app.zenvqo.chat;

import android.content.Context;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Locale;
import java.util.Set;

/**
 * The phone's own text-to-speech engine for the web app (Android WebView has no Web Speech API).
 * Exposed to JavaScript as window.ZenvqoTTS. Events go back through window.__ztts(id, event, a, b):
 * "range" (word start, end) · "done" · "stop" (interrupted) · "error" (a = -2 when the language isn't installed).
 * QUEUE_FLUSH means a new sentence always replaces the current one, so two replies never overlap.
 */
final class NativeTTS implements TextToSpeech.OnInitListener {
    private final WebView web;
    private final TextToSpeech tts;
    private volatile int state = 0;                 // 0 starting, 1 ready, -1 failed
    private Object[] pending;                       // a speak() that arrived before the engine was ready

    NativeTTS(Context ctx, WebView web) {
        this.web = web;
        this.tts = new TextToSpeech(ctx.getApplicationContext(), this);
    }

    @Override
    public void onInit(int status) {
        state = status == TextToSpeech.SUCCESS ? 1 : -1;
        if (state == 1) {
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) { }
                @Override public void onDone(String id) { send(id, "done", 0, 0); }
                @Override @SuppressWarnings("deprecation") public void onError(String id) { send(id, "error", -1, 0); }
                @Override public void onError(String id, int code) { send(id, "error", code, 0); }
                @Override public void onStop(String id, boolean interrupted) { send(id, "stop", 0, 0); }
                @Override public void onRangeStart(String id, int start, int end, int frame) { send(id, "range", start, end); }
            });
        }
        Object[] p = pending;
        pending = null;
        if (p != null) {
            if (state == 1) speak((String) p[0], (String) p[1], (String) p[2], (Double) p[3], (Double) p[4], (Double) p[5], (String) p[6]);
            else send((String) p[0], "error", -1, 0);
        }
    }

    @JavascriptInterface
    public void speak(String id, String text, String lang, double rate, double pitch, double volume, String voice) {
        if (state == 0) {
            pending = new Object[]{id, text, lang, rate, pitch, volume, voice};
            return;
        }
        if (state < 0) {
            send(id, "error", -1, 0);
            return;
        }
        boolean voiceSet = false;
        if (voice != null && !voice.isEmpty()) {
            Set<Voice> all = tts.getVoices();
            if (all != null) {
                for (Voice v : all) {
                    if (v.getName().equals(voice)) {
                        voiceSet = tts.setVoice(v) == TextToSpeech.SUCCESS;
                        break;
                    }
                }
            }
        }
        if (!voiceSet) {
            int r = tts.setLanguage(Locale.forLanguageTag(lang));
            if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) {
                send(id, "error", -2, 0);
                return;
            }
        }
        tts.setSpeechRate((float) Math.max(0.25, Math.min(3.0, rate)));
        tts.setPitch((float) Math.max(0.25, Math.min(3.0, pitch)));
        Bundle params = new Bundle();
        params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, (float) Math.max(0, Math.min(1, volume)));
        if (tts.speak(text, TextToSpeech.QUEUE_FLUSH, params, id) != TextToSpeech.SUCCESS) send(id, "error", -1, 0);
    }

    @JavascriptInterface
    public void stop() {
        if (state == 1) tts.stop();
    }

    @JavascriptInterface
    public String status() {
        return state == 1 ? "ready" : state == 0 ? "starting" : "failed";
    }

    @JavascriptInterface
    public String voices() {
        JSONArray out = new JSONArray();
        if (state != 1) return out.toString();
        Set<Voice> all = tts.getVoices();
        if (all == null) return out.toString();
        try {
            for (Voice v : all) {
                String lang = v.getLocale().getLanguage();
                if (!lang.equals("en") && !lang.equals("hi") && !lang.equals("es") && !lang.equals("fr") && !lang.equals("it") && !lang.equals("pt")) continue;
                Set<String> f = v.getFeatures();
                if (f != null && f.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
                JSONObject o = new JSONObject();
                o.put("name", v.getName());
                o.put("locale", v.getLocale().toLanguageTag());
                o.put("local", !v.isNetworkConnectionRequired());
                out.put(o);
            }
        } catch (Exception ignored) {
            // JSONException cannot happen for these values
        }
        return out.toString();
    }

    void shutdown() {
        tts.stop();
        tts.shutdown();
    }

    private void send(String id, String ev, int a, int b) {
        final String js = "window.__ztts&&window.__ztts(" + JSONObject.quote(id) + "," + JSONObject.quote(ev) + "," + a + "," + b + ")";
        web.post(() -> web.evaluateJavascript(js, null));
    }
}
