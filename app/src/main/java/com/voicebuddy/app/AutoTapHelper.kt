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
 * Makes turning Auto-Tap on as short as possible:
 *  1. If the phone allows it (one-time "adb" grant), Auto-Tap is switched on directly — zero taps,
 *     and it switches itself back on after every app update.
 *  2. Otherwise it opens zenvqo.voice's own Auto-Tap switch (not the long Accessibility list),
 *     and the moment the switch is on, the app comes back to the front by itself.
 *  3. On Android 13+ a side-loaded APK's switch can be greyed out ("Restricted setting");
 *     a second button opens App info and says which menu to use.
 */
object AutoTapHelper {

    private const val PREFS = "autotap"
    private const val KEY_WAITING = "waiting_since"
    private const val KEY_ASKED = "asked_once"

    fun component(c: Context) = ComponentName(c, AutoTapService::class.java)

    fun isOn(c: Context): Boolean = SettingsActivity.isAutoTapOn(c)

    /** Switches Auto-Tap on without any screen, if the app was given WRITE_SECURE_SETTINGS once. */
    fun tryEnableSilently(c: Context): Boolean {
        if (isOn(c)) return true
        if (c.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) != PackageManager.PERMISSION_GRANTED) return false
        return try {
            val me = component(c).flattenToString()
            val cr = c.contentResolver
            val current = Settings.Secure.getString(cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES).orEmpty()
            val list = current.split(':').filter { it.isNotBlank() && it != me } + me
            Settings.Secure.putString(cr, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, list.joinToString(":"))
            Settings.Secure.putInt(cr, Settings.Secure.ACCESSIBILITY_ENABLED, 1)
            true
        } catch (e: Exception) {
            false
        }
    }

    /** The one-tap way in: silent if possible, else a short explainer with a big button. */
    fun turnOn(a: Activity) {
        if (isOn(a)) {
            Toast.makeText(a, "Auto-Tap pehle se ON hai ✓", Toast.LENGTH_SHORT).show()
            return
        }
        if (tryEnableSilently(a)) {
            Toast.makeText(a, "Auto-Tap ON ho gaya ✓", Toast.LENGTH_SHORT).show()
            return
        }
        val restricted = Build.VERSION.SDK_INT >= 33
        val steps = buildString {
            append("WhatsApp, YouTube aur settings ke kaam apne aap karne ke liye Auto-Tap chahiye.\n\n")
            append("1. Neeche button dabao\n")
            append("2. “zenvqo.voice” switch ON karo → Allow\n")
            append("3. App apne aap wapas khul jayega")
            if (restricted) append("\n\nSwitch grey/band hai? “Switch nahi chal raha” dabao.")
        }
        val b = AlertDialog.Builder(a)
            .setTitle("Auto-Tap on karo")
            .setMessage(steps)
            .setPositiveButton("Auto-Tap kholo") { _, _ -> openSwitch(a) }
            .setNegativeButton("Baad mein", null)
        if (restricted) b.setNeutralButton("Switch nahi chal raha") { _, _ -> openRestrictedHelp(a) }
        b.show()
    }

    /** Shows the explainer once, the first time the app is used with Auto-Tap off. */
    fun askOnce(a: Activity) {
        val p = a.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (isOn(a) || p.getBoolean(KEY_ASKED, false)) return
        p.edit().putBoolean(KEY_ASKED, true).apply()
        turnOn(a)
    }

    /** Opens zenvqo.voice's own Auto-Tap page; falls back to the Accessibility list with our row highlighted. */
    fun openSwitch(a: Activity) {
        markWaiting(a)
        val flat = component(a).flattenToString()
        val details = Intent("android.settings.ACCESSIBILITY_DETAILS_SETTINGS")
            .putExtra(Intent.EXTRA_COMPONENT_NAME, flat)
        val list = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
            // Asks Settings to scroll to and highlight our row (works on most phones)
            putExtra(":settings:fragment_args_key", flat)
            putExtra(":settings:show_fragment_args", Bundle().apply { putString(":settings:fragment_args_key", flat) })
        }
        for (i in listOf(details, list)) {
            try {
                if (i.resolveActivity(a.packageManager) != null) {
                    a.startActivity(i)
                    Toast.makeText(a, "“zenvqo.voice” switch ON karo", Toast.LENGTH_LONG).show()
                    return
                }
            } catch (e: Exception) {
            }
        }
        a.startActivity(Intent(Settings.ACTION_SETTINGS))
    }

    /** Android 13+: App info → ⋮ → "Allow restricted settings", then try the switch again. */
    private fun openRestrictedHelp(a: Activity) {
        AlertDialog.Builder(a)
            .setTitle("Switch band hai?")
            .setMessage(
                "Android ne bahar se install kiye app ke liye ye switch rok diya hai. Ise kholne ke liye:\n\n" +
                    "1. Neeche button se App info khulega\n" +
                    "2. Upar right ⋮ (teen dots) dabao\n" +
                    "3. “Allow restricted settings” dabao, phone ka lock daalo\n" +
                    "4. Wapas aake “Auto-Tap on karo” dabao"
            )
            .setPositiveButton("App info kholo") { _, _ ->
                a.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${a.packageName}")))
            }
            .setNegativeButton("Theek hai", null)
            .show()
    }

    private fun markWaiting(c: Context) =
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putLong(KEY_WAITING, System.currentTimeMillis()).apply()

    /** Called when the service starts: if the user just came from our button, bring zenvqo.voice back. */
    fun onServiceStarted(c: Context) {
        val p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val since = p.getLong(KEY_WAITING, 0)
        if (since == 0L || System.currentTimeMillis() - since > 5 * 60_000) return
        p.edit().remove(KEY_WAITING).apply()
        c.startActivity(
            Intent(c, MainActivity::class.java)
                .putExtra(MainActivity.EXTRA_AUTOTAP_DONE, true)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
        )
    }
}
