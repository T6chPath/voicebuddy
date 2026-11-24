package app.workbell.plus;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/** "Background mode": a small ongoing notification that keeps Work Bell alive so alarms always fire. */
public class SmsGuard extends Service {
    private static final int NOTE_ID = 7341;

    static boolean start(Context c) {
        try {
            Store.prefs(c).edit().putBoolean("guard_on", true).apply();
            Intent i = new Intent(c, SmsGuard.class);
            if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
            else c.startService(i);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    static void stop(Context c) {
        Store.prefs(c).edit().putBoolean("guard_on", false).apply();
        c.stopService(new Intent(c, SmsGuard.class));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null && Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(new NotificationChannel("sms_background", "Background SMS",
                    NotificationManager.IMPORTANCE_LOW));
        }
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, PickActivity.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, "sms_background")
                : new Notification.Builder(this);
        Notification n = b.setSmallIcon(android.R.drawable.ic_popup_reminder)
                .setContentTitle("Work Bell Plus: background mode")
                .setContentText("Voice alerts and scheduled SMS stay active. Open the app to manage or stop.")
                .setOngoing(true)
                .setContentIntent(open)
                .build();
        try {
            if (Build.VERSION.SDK_INT >= 34) startForeground(NOTE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            else startForeground(NOTE_ID, n);
        } catch (Exception e) {
            stopSelf();
            return START_NOT_STICKY;
        }
        Store.restore(this);
        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        Store.restore(this);
        super.onTaskRemoved(rootIntent);
    }
}
