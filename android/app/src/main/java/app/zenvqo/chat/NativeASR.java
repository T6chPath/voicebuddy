package app.zenvqo.chat;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONObject;

import java.util.ArrayList;

/**
 * The phone's speech recognizer for the web app's voice mode, exposed as window.ZenvqoASR.
 * Events go back through window.__zasr(event, data): begin · level (dB) · partial (text) · final (text) · error (code) · end.
 * Asks for the microphone permission the first time it is used; the system shows its own mic indicator while it listens.
 */
final class NativeASR implements RecognitionListener {
    static final int REQ_MIC = 7101;
    private final Activity activity;
    private final WebView web;
    private SpeechRecognizer rec;
    private String pendingLang;
    private long lastLevel;
    private boolean finished;

    NativeASR(Activity activity, WebView web) {
        this.activity = activity;
        this.web = web;
    }

    @JavascriptInterface
    public String status() {
        return SpeechRecognizer.isRecognitionAvailable(activity) ? "ready" : "unavailable";
    }

    @JavascriptInterface
    public void start(final String lang, final boolean partial) {
        activity.runOnUiThread(() -> {
            if (!SpeechRecognizer.isRecognitionAvailable(activity)) {
                send("error", "unavailable");
                send("end", "");
                return;
            }
            if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                pendingLang = lang;
                activity.requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                return;
            }
            listen(lang);
        });
    }

    /** MainActivity forwards onRequestPermissionsResult here. */
    void onPermission(boolean granted) {
        String lang = pendingLang;
        pendingLang = null;
        if (lang == null) return;
        if (granted) listen(lang);
        else {
            send("error", "9");
            send("end", "");
        }
    }

    private void listen(String lang) {
        if (rec == null) {
            rec = SpeechRecognizer.createSpeechRecognizer(activity);
            rec.setRecognitionListener(this);
        } else rec.cancel();
        finished = false;
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        if ("auto".equals(lang)) {
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-IN");
            if (Build.VERSION.SDK_INT >= 33) {                      // let Android pick between Indian English and Hindi
                ArrayList<String> allowed = new ArrayList<>();
                allowed.add("en-IN");
                allowed.add("hi-IN");
                i.putExtra(RecognizerIntent.EXTRA_ENABLE_LANGUAGE_DETECTION, true);
                i.putStringArrayListExtra(RecognizerIntent.EXTRA_LANGUAGE_DETECTION_ALLOWED_LANGUAGES, allowed);
            }
        } else {
            i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        }
        rec.startListening(i);
    }

    @JavascriptInterface
    public void stop() {
        activity.runOnUiThread(() -> { if (rec != null) rec.stopListening(); });
    }

    @JavascriptInterface
    public void cancel() {
        activity.runOnUiThread(() -> { if (rec != null) rec.cancel(); finished = true; });
    }

    void shutdown() {
        if (rec != null) rec.destroy();
        rec = null;
    }

    // ---- RecognitionListener (main thread) ----
    @Override public void onReadyForSpeech(Bundle params) { }
    @Override public void onBeginningOfSpeech() { send("begin", ""); }

    @Override
    public void onRmsChanged(float rmsdB) {
        long t = System.currentTimeMillis();
        if (t - lastLevel > 90) {
            lastLevel = t;
            send("level", String.valueOf(rmsdB));
        }
    }

    @Override public void onBufferReceived(byte[] buffer) { }
    @Override public void onEndOfSpeech() { }

    @Override
    public void onError(int error) {
        if (finished) return;
        finished = true;
        send("error", String.valueOf(error));
        send("end", "");
    }

    @Override
    public void onResults(Bundle results) {
        if (finished) return;
        finished = true;
        send("final", first(results));
        send("end", "");
    }

    @Override public void onPartialResults(Bundle partial) { String t = first(partial); if (!t.isEmpty()) send("partial", t); }
    @Override public void onEvent(int eventType, Bundle params) { }

    private static String first(Bundle b) {
        ArrayList<String> r = b == null ? null : b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return r == null || r.isEmpty() || r.get(0) == null ? "" : r.get(0);
    }

    private void send(String ev, String data) {
        final String js = "window.__zasr&&window.__zasr(" + JSONObject.quote(ev) + "," + JSONObject.quote(data) + ")";
        web.post(() -> web.evaluateJavascript(js, null));
    }
}
