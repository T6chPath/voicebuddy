package com.voicebuddy.app

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.ContactsContract
import androidx.core.content.ContextCompat
import java.net.URLEncoder

/** Carries out a Command and returns what the assistant should say back. */
class ActionExecutor(private val context: Context) {

    private val contacts = ContactFinder(context)

    fun execute(cmd: Command): String = try {
        when (cmd) {
            is Command.PlayYouTube -> playOnYouTube(cmd.query)
            is Command.WhatsAppMessage -> sendWhatsApp(cmd.name, cmd.text)
            is Command.WhatsAppCall -> whatsAppCall(cmd.name, cmd.video)
            is Command.PhoneCall -> phoneCall(cmd.name)
            is Command.OpenApp -> openApp(cmd.appName)
            is Command.Unknown -> "Sorry, samajh nahi aaya. Phir se boliye."
        }
    } catch (e: ActivityNotFoundException) {
        "Ye app phone mein nahi mila."
    } catch (e: SecurityException) {
        "Permission chahiye. App settings mein permission allow kijiye."
    }

    // ---------- YouTube ----------
    private fun playOnYouTube(query: String): String {
        val yt = "com.google.android.youtube"
        val intent = if (isInstalled(yt)) {
            Intent(Intent.ACTION_SEARCH).setPackage(yt).putExtra("query", query)
        } else {
            Intent(Intent.ACTION_VIEW, Uri.parse("https://www.youtube.com/results?search_query=" + enc(query)))
        }
        PendingAction.set(PendingAction.Kind.YOUTUBE_PLAY_FIRST)
        launch(intent)
        return "YouTube pe $query chala raha hoon"
    }

    // ---------- WhatsApp message ----------
    private fun sendWhatsApp(name: String, text: String): String {
        if (!has(Manifest.permission.READ_CONTACTS)) return "Contacts ki permission dijiye."
        val (contact, message) = if (text.isNotBlank()) {
            (contacts.find(name) ?: return "$name contacts mein nahi mila.") to text
        } else {
            contacts.splitNameAndText(name) ?: return "Kisko message bhejna hai? Naam ke saath boliye."
        }
        if (message.isBlank()) return "Kya message bhejna hai ${contact.name} ko?"
        val phone = contact.phone ?: return "${contact.name} ka number nahi mila."
        val pkg = whatsAppPackage() ?: return "WhatsApp install nahi hai."

        val uri = Uri.parse("https://api.whatsapp.com/send?phone=$phone&text=${enc(message)}")
        PendingAction.set(PendingAction.Kind.WHATSAPP_SEND)
        launch(Intent(Intent.ACTION_VIEW, uri).setPackage(pkg))
        return "${contact.name} ko message bhej raha hoon: $message"
    }

    // ---------- WhatsApp voice / video call ----------
    private fun whatsAppCall(name: String, video: Boolean): String {
        if (!has(Manifest.permission.READ_CONTACTS)) return "Contacts ki permission dijiye."
        val contact = contacts.find(name) ?: return "$name contacts mein nahi mila."
        val pkg = whatsAppPackage() ?: return "WhatsApp install nahi hai."
        val row = contacts.whatsAppCallRow(contact.id, video, pkg)
            ?: return "${contact.name} WhatsApp pe nahi mile. WhatsApp ek baar khol ke contacts sync hone dijiye."

        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(
                Uri.withAppendedPath(ContactsContract.Data.CONTENT_URI, row.toString()),
                contacts.whatsAppCallMime(video, pkg)
            )
            .setPackage(pkg)
        launch(intent)
        return "${contact.name} ko WhatsApp ${if (video) "video" else "voice"} call laga raha hoon"
    }

    // ---------- Normal phone call ----------
    private fun phoneCall(name: String): String {
        if (!has(Manifest.permission.READ_CONTACTS)) return "Contacts ki permission dijiye."
        val digits = name.filter { it.isDigit() }
        val (label, number) = if (digits.length >= 10) {
            digits to digits
        } else {
            val c = contacts.find(name) ?: return "$name contacts mein nahi mila."
            c.name to ("+" + (c.phone ?: return "${c.name} ka number nahi mila."))
        }
        val action = if (has(Manifest.permission.CALL_PHONE)) Intent.ACTION_CALL else Intent.ACTION_DIAL
        launch(Intent(action, Uri.parse("tel:$number")))
        return "$label ko call kar raha hoon"
    }

    // ---------- Open any app ----------
    private fun openApp(spoken: String): String {
        val pm = context.packageManager
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val target = spoken.lowercase().replace(" ", "")
        val apps = pm.queryIntentActivities(launcher, 0)

        val match = apps
            .map { it to it.loadLabel(pm).toString().lowercase().replace(" ", "") }
            .sortedBy { (_, label) ->
                when {
                    label == target -> 0
                    label.startsWith(target) -> 1
                    label.contains(target) -> 2
                    target.contains(label) -> 3
                    else -> 9
                }
            }
            .firstOrNull { (_, label) ->
                label.contains(target) || (label.length > 2 && target.contains(label))
            }?.first ?: return "$spoken app nahi mila."

        val intent = pm.getLaunchIntentForPackage(match.activityInfo.packageName) ?: return "$spoken khul nahi raha."
        launch(intent)
        return "${match.loadLabel(pm)} khol raha hoon"
    }

    // ---------- helpers ----------
    private fun launch(i: Intent) = context.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))

    private fun has(p: String) = ContextCompat.checkSelfPermission(context, p) == PackageManager.PERMISSION_GRANTED

    private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8").replace("+", "%20")

    private fun isInstalled(pkg: String) = try {
        context.packageManager.getPackageInfo(pkg, 0); true
    } catch (e: PackageManager.NameNotFoundException) { false }

    private fun whatsAppPackage(): String? =
        listOf("com.whatsapp", "com.whatsapp.w4b").firstOrNull { isInstalled(it) }
}
