package com.voicebuddy.app

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast

/**
 * The background helper that finishes jobs by itself (presses Send, starts the video, flips
 * switches). The user never sees it as a feature: Android asks for its permission once, the
 * first time it's needed, and the command that needed it runs right after.
 *  - With the one-time PC grant (tools/AutoTap-Hamesha-ON.bat) it switches itself on silently.
 *  - Otherwise one short "allow once" dialog opens zenvqo.voice's own switch, and the app
 *    comes back by itself and finishes the command.
 */
object AutoTapHelper {

    private const val PREFS = "autotap"
    private const val KEY_WAITING = "waiting_since"
        private const val KEY_PENDING = "pending_command"
    private const val KEY_WANTED = "wanted"
    private const val KEY_UNLOCKING = "unlocking_since"

    /**
     * Android 13+ blocks the switch of apps installed from an APK file ("Restricted setting")
     * until "Allow restricted settings" is tapped in App info. Apps from the Play Store aren't blocked.
     */
    fun isRestricted(c: Context): Boolean {
        if (Build.VERSION.SDK_INT < 33) return false
        return try {
            val ops = c.getSystemService(Context.APP_OPS_SERVICE) as android.app.AppOpsManager
            ops.unsafeCheckOpNoThrow("android:access_restricted_settings", android.os.Process.myUid(), c.packageName) !=
                android.app.AppOpsManager.MODE_ALLOWED
        } catch (e: Exception) {
            false
        }
    }

    /** The user's choice on the home-screen switch (default ON). */
    fun wanted(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_WANTED, true)
    private fun setWanted(c: Context, on: Boolean) =
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_WANTED, on).apply()

    /**
     * Switch flipped ON. Instant if the one-time PC permission exists; otherwise goes straight to
     * zenvqo.voice's own switch (no extra dialog) and comes back by itself. Returns true if already on.
     */
    fun switchOn(a: Activity, pendingCommand: String? = null): Boolean {
        setWanted(a, true)
        if (isOn(a) || tryEnableSilently(a)) return true
        if (pendingCommand != null) a.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(KEY_PENDING, pendingCommand).apply()
        if (isRestricted(a)) unlockFirst(a) else openSwitch(a)
        return false
    }

    /** Switch flipped OFF: always instant (an app may turn its own helper off). */
    fun switchOff(c: Context) {
        setWanted(c, false)
        PendingAction.clear()
        val svc = AutoTapService.instance
        if (svc != null) svc.disableSelf()
        else if (c.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) == PackageManager.PERMISSION_GRANTED) {
            try {
                val me = component(c).flattenToString()
                val cr = c.contentResolver
                val list = Settings.Secure.getString(cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
                    .split(':').filter { it.isNotBlank() && !it.equals(me, true) }
                Settings.Secure.putString(cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, list.joinToString(":"))
            } catch (e: Exception) {
            }
        }
    }

    /**
     * Back from Android's switch page but still OFF: on Android 13+ the switch is usually greyed out
     * for apps installed from an APK, so explain the one fix. Shown once per attempt.
     */
    fun checkReturned(a: Activity) {
        val p = a.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        // Back from App info: if unlocked now, go straight on to the switch
        val unlocking = p.getLong(KEY_UNLOCKING, 0)
        if (unlocking != 0L) {
            p.edit().remove(KEY_UNLOCKING).apply()
            if (!isOn(a) && !isRestricted(a) && System.currentTimeMillis() - unlocking < 10 * 60_000) {
                openSwitch(a)
                return
            }
        }
        val since = p.getLong(KEY_WAITING, 0)
        if (since == 0L || isOn(a)) return
        p.edit().remove(KEY_WAITING).remove(KEY_PENDING).apply()
    }

    /** Step 1 of 2 on blocked phones: App info → ⋮ → Allow restricted settings. */
    private fun unlockFirst(a: Activity) {
        a.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putLong(KEY_UNLOCKING, System.currentTimeMillis()).apply()
        a.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${a.packageName}")))
        Toast.makeText(a, "Upar right ⋮ dabao → “Allow restricted settings” → wapas aao", Toast.LENGTH_LONG).show()
    }

    fun component(c: Context) = ComponentName(c, AutoTapService::class.java)

    fun isOn(c: Context): Boolean = SettingsActivity.isAutoTapOn(c)

    /** Switches the helper on without any screen, if the app was given WRITE_SECURE_SETTINGS once. */
    fun tryEnableSilently(c: Context): Boolean {
        if (!wanted(c)) return isOn(c)
        if (c.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) != PackageManager.PERMISSION_GRANTED) return isOn(c)
        return try {
            val me = component(c).flattenToString()
            val cr = c.contentResolver
            val current = Settings.Secure.getString(cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
            val listed = current.split(':').any { it.equals(me, true) }
            if (listed && Settings.Secure.getInt(cr, Settings.Secure.ACCESSIBILITY_ENABLED, 0) == 1) return true
            val list = current.split(':').filter { it.isNotBlank() && it != me } + me
            Settings.Secure.putString(cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, list.joinToString(":"))
            Settings.Secure.putInt(cr, Settings.Secure.ACCESSIBILITY_ENABLED, 1)
            true
        } catch (e: Exception) {
            false
        }
    }

    /**
     * Ready to do things by itself? If not, asks once and remembers [pendingCommand] so it runs
     * automatically the moment permission is given. Returns true when the job can go ahead now.
     */
    fun ensureReady(a: Activity, pendingCommand: String? = null): Boolean {
        if (isOn(a) || tryEnableSilently(a)) return true
        Toast.makeText(a, "“zenvqo.voice” ON karo — phir ye kaam apne aap ho jayega", Toast.LENGTH_LONG).show()
        return switchOn(a, pendingCommand)
    }

    /** The command that was waiting for permission (taken once). */
    fun takePending(c: Context): String? {
        val p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val cmd = p.getString(KEY_PENDING, null)
        p.edit().remove(KEY_PENDING).apply()
        return cmd
    }

    /** Opens zenvqo.voice's own switch; falls back to the Accessibility list with our row highlighted. */
    private fun openSwitch(a: Activity) {
        markWaiting(a)
        val flat = component(a).flattenToString()
        val details = Intent("android.settings.ACCESSIBILITY_DETAILS_SETTINGS")
            .putExtra(Intent.EXTRA_COMPONENT_NAME, flat)
        val list = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
            putExtra(":settings:fragment_args_key", flat)
            putExtra(":settings:show_fragment_args", Bundle().apply { putString(":settings:fragment_args_key", flat) })
        }
        for (i in listOf(details, list)) {
            try {
                if (i.resolveActivity(a.packageManager) != null) {
                    a.startActivity(i)
                    return
                }
            } catch (e: Exception) {
            }
        }
        a.startActivity(Intent(Settings.ACTION_SETTINGS))
    }

    private fun markWaiting(c: Context) =
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong(KEY_WAITING, System.currentTimeMillis()).apply()

    /** Called when the helper starts: if the user just gave permission, bring zenvqo.voice back to finish the job. */
    fun onServiceStarted(c: Context) {
        val p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val since = p.getLong(KEY_WAITING, 0)
        if (since == 0L || System.currentTimeMillis() - since > 10 * 60_000) return
        p.edit().remove(KEY_WAITING).apply()
        c.startActivity(
            Intent(c, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_AUTOTAP_DONE, true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        )
    }
}
