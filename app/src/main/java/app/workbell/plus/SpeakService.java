package app.workbell.plus;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import java.util.Locale;

/**
 * Speaks an alert out loud with Android text-to-speech, like Work Bell for PC:
 * the sentence is said up to 3 times with a 3-second pause, on the ALARM volume,
 * and stops by itself (at most 45 seconds). A "Stop" button is shown while speaking.
 */
public class SpeakService extends Service implements TextToSpeech.OnInitListener {
    private static final String CHANNEL = "voice";
    private static final int NOTE_ID = 7342;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private TextToSpeech tts;
    private boolean ready;
    private String text;
    private int times = 3;

    /** Start speaking. Safe to call from an alarm (allowed to start a foreground service). */
    static boolean say(Context c, String text, int times) {
        try {
            Intent i = new Intent(c, SpeakService.class).putExtra("text", text).putExtra("times", times);
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
            else c.startService(i);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        showNotification();
        if (intent != null && "STOP".equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        String t = intent == null ? null : intent.getStringExtra("text");
        if (t == null || t.trim().isEmpty()) {
            stopSelf();
            return START_NOT_STICKY;
        }
        text = t.trim();
        times = Math.max(1, Math.min(5, intent.getIntExtra("times", 3)));
        handler.removeCallbacksAndMessages(null);
        handler.postDelayed(this::stopSelf, 45000);
        if (tts == null) tts = new TextToSpeech(getApplicationContext(), this);
        else if (ready) speakNow();
        return START_NOT_STICKY;
    }

    @SuppressWarnings("deprecation")
    private void showNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null && Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Spoken alerts",
                    NotificationManager.IMPORTANCE_LOW));
        }
        PendingIntent stop = PendingIntent.getService(this, 1,
                new Intent(this, SpeakService.class).setAction("STOP"),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL)
                : new Notification.Builder(this);
        b.setSmallIcon(android.R.drawable.ic_lock_silent_mode_off)
                .setContentTitle("Work Bell is speaking")
                .setContentText(text == null ? "Tap Stop to silence" : text)
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_pause, "Stop", stop).build());
        Notification n = b.build();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(NOTE_ID, n);
        }
    }

    @Override
    public void onInit(int status) {
        if (status != TextToSpeech.SUCCESS || tts == null) {
            stopSelf();
            return;
        }
        ready = true;
        Locale indianEnglish = new Locale("en", "IN");
        tts.setLanguage(tts.isLanguageAvailable(indianEnglish) >= TextToSpeech.LANG_AVAILABLE
                ? indianEnglish : Locale.getDefault());
        tts.setSpeechRate(0.9f); // a little slower, like the PC voice (Rate -1)
        tts.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build());
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override public void onStart(String utteranceId) { }
            @Override public void onDone(String utteranceId) {
                if ("end".equals(utteranceId)) handler.post(SpeakService.this::stopSelf);
            }
            @Override public void onError(String utteranceId) {
                handler.post(SpeakService.this::stopSelf);
            }
        });
        speakNow();
    }

    private void speakNow() {
        if (tts == null || text == null) return;
        tts.stop();
        for (int k = 0; k < times; k++) {
            boolean last = k == times - 1;
            tts.speak(text, k == 0 ? TextToSpeech.QUEUE_FLUSH : TextToSpeech.QUEUE_ADD, null, last ? "end" : "say" + k);
            if (!last) tts.playSilentUtterance(3000, TextToSpeech.QUEUE_ADD, "gap" + k);
        }
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (tts != null) {
            tts.stop();
            tts.shutdown();
            tts = null;
        }
        super.onDestroy();
    }
}
