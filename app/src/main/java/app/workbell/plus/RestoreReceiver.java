package app.workbell.plus;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** After a reboot, app update, clock change or alarm-permission change: re-arm everything. */
public class RestoreReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context c, Intent i) {
        Store.restore(c);
        String action = i == null ? null : i.getAction();
        boolean bootOrUpdate = Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action);
        if (bootOrUpdate && Store.prefs(c).getBoolean("guard_on", false)) {
            SmsGuard.start(c); // background mode comes back on by itself after a restart
        }
    }
}
