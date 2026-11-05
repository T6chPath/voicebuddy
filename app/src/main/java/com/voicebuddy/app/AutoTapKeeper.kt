package com.voicebuddy.app

import android.Manifest
import android.app.AlarmManager
import android.app.Application
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings

/**
 * Keeps Auto-Tap ON by itself once the one-time permission (WRITE_SECURE_SETTINGS) is given.
 * Android normally turns accessibility apps off after an update, a crash or a battery clean-up;
 * this switches it straight back on:
 *  - when the phone restarts and after every zenvqo.voice update   (Keeper receiver)
 *  - the moment the setting changes while the app is in memory      (ContentObserver)
 *  - every 15 minutes in the background                             (inexact alarm)
 *  - whenever the app, its tile or its button is opened             (AutoTapHelper.tryEnableSilently)
 */
object AutoTapKeeper {

    fun canKeepOn(c: Context): Boolean =
        c.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) == PackageManager.PERMISSION_GRANTED

    fun isBatteryFree(c: Context): Boolean =
        (c.getSystemService(Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(c.packageName)

    /** Re-enables Auto-Tap if needed and makes sure the watchers are running. */
    fun ensure(c: Context) {
        val app = c.applicationContext
        if (!canKeepOn(app)) return
        AutoTapHelper.tryEnableSilently(app)
        watch(app)
        scheduleCheck(app)
    }

    private var observer: ContentObserver? = null

    private fun watch(c: Context) {
        if (observer != null) return
        val main = Handler(Looper.getMainLooper())
        val o = object : ContentObserver(main) {
            override fun onChange(selfChange: Boolean, uri: Uri?) {
                // Small delay: let Android finish its own change, then put Auto-Tap back
                main.postDelayed({ AutoTapHelper.tryEnableSilently(c) }, 1500)
            }
        }
        val cr = c.contentResolver
        cr.registerContentObserver(Settings.Secure.getUriFor(Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES), false, o)
        cr.registerContentObserver(Settings.Secure.getUriFor(Settings.Secure.ACCESSIBILITY_ENABLED), false, o)
        observer = o
    }

    private fun scheduleCheck(c: Context) {
        val am = c.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pi = PendingIntent.getBroadcast(
            c, 42, Intent(c, Keeper::class.java).setAction(ACTION_CHECK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        am.setInexactRepeating(
            AlarmManager.ELAPSED_REALTIME, SystemClock.elapsedRealtime() + AlarmManager.INTERVAL_FIFTEEN_MINUTES,
            AlarmManager.INTERVAL_FIFTEEN_MINUTES, pi
        )
    }

    /** Asks Android not to put zenvqo.voice to sleep (phones like Xiaomi, Oppo, Vivo, Realme kill Auto-Tap otherwise). */
    fun batteryIntent(c: Context): Intent =
        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${c.packageName}"))

    const val ACTION_CHECK = "com.voicebuddy.app.CHECK_AUTOTAP"

    /** Phone restart, app update and the 15-minute check all land here. */
    class Keeper : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) = ensure(context)
    }
}

/** Starts the keeper as soon as the app's process starts, for any reason. */
class VoiceBuddyApp : Application() {
    override fun onCreate() {
        super.onCreate()
        AutoTapKeeper.ensure(this)
    }
}
