package app.workbell.plus;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import org.json.JSONObject;

/** Receives the network result for each part of a sent SMS and updates the item's status. */
public class SmsResult extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        if (i == null) return;
        synchronized (Store.class) {
            JSONObject all = Store.jobs(c);
            String id = i.getStringExtra("id");
            JSONObject j = id == null ? null : all.optJSONObject(id);
            if (j == null || !String.valueOf(i.getStringExtra("run")).equals(j.optString("run"))) return;
            try {
                String partKey = "part_" + i.getIntExtra("part", 0);
                if (j.optBoolean(partKey)) return; // duplicate result
                j.put(partKey, true);
                if (getResultCode() == Activity.RESULT_OK) j.put("success", j.optInt("success") + 1);
                else j.put("failed", true);
                int parts = Math.max(1, j.optInt("parts", 1));
                int done = j.optInt("done") + 1;
                j.put("done", done);
                if (done >= parts) {
                    boolean failed = j.optBoolean("failed");
                    String status = failed ? "Failed or partially sent — check SMS app" : "Sent to network (delivery unconfirmed)";
                    j.put("status", status);
                    j.put("last", status + " · " + AlarmReceiver.time(System.currentTimeMillis()));
                    for (int k = 0; k < parts; k++) j.remove("part_" + k);
                    Store.notify(c, failed ? "Message not sent" : "SMS sent", j.optString("name"), ("f" + id).hashCode());
                }
                Store.put(c, all);
            } catch (Exception ignored) { }
        }
    }
}
