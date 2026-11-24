package app.workbell.plus;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.telephony.SubscriptionManager;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

import java.util.ArrayList;

/**
 * Functions the page calls as window.OccasionNative.* and window.ContactNative.*
 * (same names as earlier versions) plus speak() and setName() for voice alerts.
 */
public class Bridge {
    private final MainActivity a;

    Bridge(MainActivity activity) {
        a = activity;
    }

    private boolean granted(String permission) {
        return a.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean notificationsAllowed() {
        return Build.VERSION.SDK_INT < 33 || granted("android.permission.POST_NOTIFICATIONS");
    }

    // ---------- schedules ----------

    @JavascriptInterface
    public String jobs() {
        return Store.jobs(a).toString();
    }

    @JavascriptInterface
    public String status() {
        try {
            JSONObject o = new JSONObject();
            o.put("sms", granted(Manifest.permission.SEND_SMS));
            o.put("exact", Store.exact(a));
            o.put("notifications", notificationsAllowed());
            o.put("sim", SubscriptionManager.getDefaultSmsSubscriptionId() >= 0);
            o.put("voice", true);
            return o.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    /** Saves (or replaces) one item and arms its alarm. Returns "" on success, otherwise a message. */
    @JavascriptInterface
    public String save(String json) {
        try {
            JSONObject j = new JSONObject(json);
            String id = j.getString("id");
            if (!id.matches("[a-zA-Z0-9_-]{1,80}")) return "Invalid id";
            if (j.getLong("at") < System.currentTimeMillis() - 60000) return "Choose a future date and time.";
            boolean sms = j.optBoolean("auto");
            if (sms) {
                if (!granted(Manifest.permission.SEND_SMS)) return "Enable SMS permission first.";
                if (SubscriptionManager.getDefaultSmsSubscriptionId() < 0) return "Select a default SMS SIM in phone settings first.";
                if (!j.optString("phone").matches("\\+[1-9][0-9]{7,14}")) return "Use a valid international phone number.";
                String m = j.optString("message");
                if (m.trim().isEmpty() || m.length() > 500) return "Message must contain 1 to 500 characters.";
            }
            if (!Store.exact(a)) return "Enable Alarms & reminders first.";
            synchronized (Store.class) {
                JSONObject all = Store.jobs(a);
                JSONObject old = all.optJSONObject(id);
                if (old != null) Store.cancelAlarm(a, id);
                j.put("enabled", true);
                j.put("status", sms ? "Scheduled SMS" : "Voice alert scheduled");
                j.put("last", old == null ? "" : old.optString("last"));
                all.put(id, j);
                Store.put(a, all);
                Store.schedule(a, j);
            }
            return "";
        } catch (Exception e) {
            return "Could not schedule: " + e.getMessage();
        }
    }

    @JavascriptInterface
    public void cancel(String id) {
        if (id != null) Store.cancel(a, id);
    }

    // ---------- voice ----------

    /** Speak now (used by "Test voice"). */
    @JavascriptInterface
    public boolean speak(String text) {
        return SpeakService.say(a, text, 1);
    }

    /** The user's name, spoken in every alert ("Suraj, it is time for ..."). */
    @JavascriptInterface
    public void setName(String name) {
        Store.prefs(a).edit().putString("user_name", name == null ? "" : name.trim()).apply();
    }

    // ---------- permissions & settings ----------

    @JavascriptInterface
    public void permissions() {
        a.runOnUiThread(() -> {
            ArrayList<String> need = new ArrayList<>();
            if (!granted(Manifest.permission.SEND_SMS)) need.add(Manifest.permission.SEND_SMS);
            if (!notificationsAllowed()) need.add("android.permission.POST_NOTIFICATIONS");
            if (need.isEmpty()) a.js("if(window.refreshNative)refreshNative();if(window.renderHealth)renderHealth()");
            else a.requestPermissions(need.toArray(new String[0]), MainActivity.ASK_PERMISSIONS);
        });
    }

    @JavascriptInterface
    public void exact() {
        a.runOnUiThread(() -> {
            if (Build.VERSION.SDK_INT >= 31) {
                try {
                    a.startActivity(new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                            Uri.parse("package:" + a.getPackageName())));
                    return;
                } catch (Exception ignored) { }
            }
            openAppSettings();
        });
    }

    @JavascriptInterface
    public void appSettings() {
        a.runOnUiThread(this::openAppSettings);
    }

    private void openAppSettings() {
        try {
            a.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + a.getPackageName())));
        } catch (Exception ignored) { }
    }

    @JavascriptInterface
    public boolean batteryReady() {
        PowerManager pm = (PowerManager) a.getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(a.getPackageName());
    }

    /** One-tap "Allow Work Bell to always run in the background?" dialog; falls back to the battery list. */
    @JavascriptInterface
    public boolean batterySettings() {
        try {
            a.startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + a.getPackageName())));
            return true;
        } catch (Exception e) {
            try {
                a.startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
                return true;
            } catch (Exception e2) {
                return false;
            }
        }
    }

    // ---------- background mode & contacts ----------

    @JavascriptInterface
    public boolean startGuard() {
        return SmsGuard.start(a);
    }

    @JavascriptInterface
    public void stopGuard() {
        SmsGuard.stop(a);
    }

    @JavascriptInterface
    public void pick() {
        a.runOnUiThread(a::pickContact);
    }
}
