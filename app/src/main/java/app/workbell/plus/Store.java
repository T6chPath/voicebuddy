package app.workbell.plus;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;

import org.json.JSONObject;

import java.util.Calendar;
import java.util.Iterator;

/**
 * All scheduled items (occasions, work, reminders) as one JSON object, keyed by id.
 * Uses the same storage as earlier Work Bell Plus versions ("occasions" / "jobs"),
 * so schedules saved before this update are kept.
 */
public final class Store {
    static final String PREFS = "occasions";
    static final String KEY = "jobs";
    /** An alarm that arrives later than this is reported as missed instead of being sent. */
    static final long LATE = 6L * 60 * 60 * 1000;

    private Store() {}

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static synchronized JSONObject jobs(Context c) {
        try {
            return new JSONObject(prefs(c).getString(KEY, "{}"));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    static synchronized void put(Context c, JSONObject all) {
        prefs(c).edit().putString(KEY, all.toString()).commit();
    }

    static boolean exact(Context c) {
        if (Build.VERSION.SDK_INT < 31) return true;
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        return am != null && am.canScheduleExactAlarms();
    }

    /** Same intent (action + data) as earlier versions, so old alarms can still be found and cancelled. */
    static PendingIntent pending(Context c, String id) {
        Intent i = new Intent(c, AlarmReceiver.class)
                .setAction("DUE")
                .setData(Uri.parse("workbell://occasion/" + id))
                .putExtra("id", id);
        return PendingIntent.getBroadcast(c, 0, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void schedule(Context c, JSONObject j) throws Exception {
        if (!j.optBoolean("enabled")) return;
        if (!exact(c)) throw new Exception("Alarm permission missing");
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) throw new Exception("Alarm service unavailable");
        am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, j.getLong("at"), pending(c, j.getString("id")));
    }

    static void cancelAlarm(Context c, String id) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(pending(c, id));
    }

    static synchronized void cancel(Context c, String id) {
        cancelAlarm(c, id);
        JSONObject all = jobs(c);
        all.remove(id);
        put(c, all);
    }

    /** Re-arm every enabled item (after opening the app, reboot, update or time change). */
    static synchronized void restore(Context c) {
        JSONObject all = jobs(c);
        long now = System.currentTimeMillis();
        Iterator<String> it = all.keys();
        while (it.hasNext()) {
            JSONObject j = all.optJSONObject(it.next());
            if (j == null || !j.optBoolean("enabled")) continue;
            try {
                if (j.optLong("at") < now - LATE) {
                    j.put("status", "Missed");
                    j.put("last", "Missed while phone unavailable — not sent");
                    advance(c, j);
                } else {
                    schedule(c, j); // a time a little in the past fires straight away
                }
            } catch (Exception e) {
                try { j.put("status", "Needs alarm permission — open app"); } catch (Exception ignored) { }
            }
        }
        put(c, all);
    }

    /** Yearly items move to next year (Feb 29 -> Feb 28 when needed); everything else is switched off. */
    static void advance(Context c, JSONObject j) throws Exception {
        if (!j.optBoolean("yearly")) {
            j.put("enabled", false);
            return;
        }
        Calendar cal = Calendar.getInstance();
        cal.setTimeInMillis(j.getLong("at"));
        int month = j.optInt("month", cal.get(Calendar.MONTH));
        int day = j.optInt("day", cal.get(Calendar.DAY_OF_MONTH));
        long now = System.currentTimeMillis();
        int year = cal.get(Calendar.YEAR);
        do {
            year++;
            cal.set(Calendar.DAY_OF_MONTH, 1);
            cal.set(Calendar.YEAR, year);
            cal.set(Calendar.MONTH, month);
            cal.set(Calendar.DAY_OF_MONTH, Math.min(day, cal.getActualMaximum(Calendar.DAY_OF_MONTH)));
        } while (cal.getTimeInMillis() <= now && year < 3000);
        j.put("at", cal.getTimeInMillis());
        j.put("enabled", true);
        schedule(c, j);
    }

    static void notify(Context c, String title, String text, int notificationId) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel("occasions", "Occasion messages",
                    NotificationManager.IMPORTANCE_DEFAULT));
        }
        PendingIntent open = PendingIntent.getActivity(c, 0,
                new Intent(c, PickActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(c, "occasions")
                : new Notification.Builder(c);
        b.setSmallIcon(android.R.drawable.ic_popup_reminder)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .setContentIntent(open)
                .setAutoCancel(true)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setShowWhen(true)
                .setWhen(System.currentTimeMillis());
        nm.notify(notificationId, b.build());
    }

    static String userName(Context c) {
        return prefs(c).getString("user_name", "").trim();
    }
}
