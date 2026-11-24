package app.workbell.plus;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.telephony.SmsManager;
import android.telephony.SubscriptionManager;

import org.json.JSONObject;

import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Date;

/**
 * Runs at the scheduled time, even when the app is closed or the phone is locked.
 * auto = true  -> sends the SMS from the default SIM.
 * auto = false -> shows a notification and SPEAKS the alert, like Work Bell for PC:
 *                 "Suraj, it is time for Study maths."  /  "Suraj, today is Mom's birthday."
 */
public class AlarmReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context c, Intent intent) {
        String id = intent == null ? null : intent.getStringExtra("id");
        if (id == null) return;
        synchronized (Store.class) {
            JSONObject all = Store.jobs(c);
            JSONObject j = all.optJSONObject(id);
            if (j == null || !j.optBoolean("enabled")) return;
            long at = j.optLong("at");
            long now = System.currentTimeMillis();
            try {
                if (at - 2000 > now) {          // fired too early (clock changed): re-arm
                    Store.schedule(c, j);
                    return;
                }
                if (now - at > Store.LATE) {
                    j.put("status", "Missed");
                    j.put("last", "More than 6 hours late — not sent");
                } else if (!j.optBoolean("auto")) {
                    String say = phrase(c, id, j);
                    boolean speak = j.optBoolean("speak", true);
                    j.put("status", speak ? "Spoken" : "Reminder shown");
                    j.put("last", (speak ? "Spoken at " : "Reminder shown at ") + time(now));
                    Store.notify(c, j.optString("name", "Work Bell"), say, id.hashCode());
                    if (speak) SpeakService.say(c, say, 3);
                } else {
                    sendSms(c, j, id, now);
                }
                Store.advance(c, j);
            } catch (Exception e) {
                try {
                    j.put("status", "Failed — " + e.getMessage());
                } catch (Exception ignored) { }
            }
            Store.put(c, all);
        }
    }

    /** The sentence to speak. Uses the "say" field if the app supplied one. */
    static String phrase(Context c, String id, JSONObject j) {
        String say = j.optString("say", "").trim();
        if (!say.isEmpty()) return say;
        String user = Store.userName(c);
        String first = user.isEmpty() ? "" : user.split("\\s+")[0] + ", ";
        String name = j.optString("name", "").replaceFirst("^(Work|Reminder): ", "").trim();
        String s = id.startsWith("o")
                ? first + "today is " + name + "."
                : first + "it is time for " + name + ".";
        return Character.toUpperCase(s.charAt(0)) + s.substring(1);
    }

    static String time(long t) {
        return DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date(t));
    }

    @SuppressWarnings("deprecation")
    static void sendSms(Context c, JSONObject j, String id, long now) throws Exception {
        try {
            int sub = SubscriptionManager.getDefaultSmsSubscriptionId();
            if (sub < 0) throw new Exception("Choose a default SMS SIM");
            SmsManager sm = Build.VERSION.SDK_INT >= 31
                    ? c.getSystemService(SmsManager.class).createForSubscriptionId(sub)
                    : SmsManager.getSmsManagerForSubscriptionId(sub);
            String message = j.getString("message");
            ArrayList<String> parts = sm.divideMessage(message);
            String run = id + "_" + now;
            j.put("run", run);
            j.put("parts", parts.size());
            j.put("done", 0);
            j.put("success", 0);
            j.put("failed", false);
            j.put("status", "Sending — awaiting network result");
            j.put("last", "Submitted at " + time(now));
            ArrayList<PendingIntent> sent = new ArrayList<>();
            for (int k = 0; k < parts.size(); k++) {
                Intent r = new Intent(c, SmsResult.class)
                        .setData(Uri.parse("workbell://result/" + id + "/" + run + "/" + k))
                        .putExtra("id", id)
                        .putExtra("run", run)
                        .putExtra("part", k);
                sent.add(PendingIntent.getBroadcast(c, 0, r,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
            }
            sm.sendMultipartTextMessage(j.getString("phone"), null, parts, sent, null);
        } catch (Exception e) {
            j.put("status", "Failed — check permission, SIM or signal");
            j.put("last", String.valueOf(e.getMessage()));
            Store.notify(c, "Message not sent", j.optString("name") + ": " + e.getMessage(), ("f" + id).hashCode());
        }
    }
}
