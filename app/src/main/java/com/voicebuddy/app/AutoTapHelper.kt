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
import androidx.appcompat.app.AlertDialog

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
    private const val KEY_ASKED = "asked_once"
    private const val KEY_PENDING = "pending_command"

    fun component(c: Context) = ComponentName(c, AutoTapService::class.java)

    fun isOn(c: Context): Boolean = SettingsActivity.isAutoTapOn(c)

    /** Switches the helper on without any screen, if the app was given WRITE_SECURE_SETTINGS once. */
    fun tryEnableSilently(c: Context): Boolean {
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
        val p = a.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (pendingCommand != null) p.edit().putString(KEY_PENDING, pendingCommand).apply()
        p.edit().putBoolean(KEY_ASKED, true).apply()
        askPermission(a)
        return false
    }

    /** First launch: ask once, together with the other permissions. */
    fun askOnce(a: Activity) {
        val p = a.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (isOn(a) || tryEnableSilently(a) || p.getBoolean(KEY_ASKED, false)) return
        p.edit().putBoolean(KEY_ASKED, true).apply()
        askPermission(a)
    }

    /** The command that was waiting for permission (taken once). */
    fun takePending(c: Context): String? {
        val p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val cmd = p.getString(KEY_PENDING, null)
        p.edit().remove(KEY_PENDING).apply()
        return cmd
    }

    private fun askPermission(a: Activity) {
        val restricted = Build.VERSION.SDK_INT >= 33
        val steps = buildString {
            append("Message apne aap bhejne, video chalane aur baaki kaam khud karne ke liye Android ek baar permission maangta hai.\n\n")
            append("1. “Permission do” dabao\n")
            append("2. “zenvqo.voice” ON karo → Allow\n")
            append("3. App wapas aayega aur aapka kaam khud kar dega")
            if (restricted) append("\n\nSwitch grey hai? “Switch band hai” dabao.")
        }
        val b = AlertDialog.Builder(a)
            .setTitle("Bas ek baar")
            .setMessage(steps)
            .setPositiveButton("Permission do") { _, _ -> openSwitch(a) }
            .setNegativeButton("Baad mein") { _, _ -> takePending(a) }
        if (restricted) b.setNeutralButton("Switch band hai") { _, _ -> openRestrictedHelp(a) }
        b.show()
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
                    Toast.makeText(a, "“zenvqo.voice” ON karo", Toast.LENGTH_LONG).show()
                    return
                }
            } catch (e: Exception) {
            }
        }
        a.startActivity(Intent(Settings.ACTION_SETTINGS))
    }

    /** Android 13+: App info → ⋮ → "Allow restricted settings", then the switch works. */
    private fun openRestrictedHelp(a: Activity) {
        markWaiting(a)
        AlertDialog.Builder(a)
            .setTitle("Switch band hai?")
            .setMessage(
                "Android ne bahar se install kiye app ke liye ye switch rok rakha hai:\n\n" +
                    "1. “App info kholo” dabao\n" +
                    "2. Upar right ⋮ (teen dots) dabao\n" +
                    "3. “Allow restricted settings” → phone ka lock daalo\n" +
                    "4. Wapas aake dobara boliye — switch ab chalega"
            )
            .setPositiveButton("App info kholo") { _, _ ->
                a.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${a.packageName}")))
            }
            .setNegativeButton("Theek hai", null)
            .show()
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
