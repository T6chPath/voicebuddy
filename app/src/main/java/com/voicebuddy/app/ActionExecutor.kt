package com.voicebuddy.app

import android.Manifest
import android.accessibilityservice.AccessibilityService
import android.annotation.SuppressLint
import android.app.Activity
import android.app.SearchManager
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.ContactsContract
import android.provider.Settings
import android.telecom.TelecomManager
import androidx.core.content.ContextCompat
import java.net.URLEncoder

/** Carries out a Command and returns what the assistant should say back. */
class ActionExecutor(private val activity: Activity) {

    private val context: Context = activity
    private val contacts = ContactFinder(context)
    private val handler = Handler(Looper.getMainLooper())
    private val whatsApp = WhatsAppActions(activity, contacts) { name, text -> sendWhatsApp(name, text) }

    fun execute(cmd: Command): String = try {
        when (cmd) {
            is Command.PlayYouTube -> playOnYouTube(cmd.query)
            is Command.WhatsAppMessage -> sendWhatsApp(cmd.name, cmd.text)
            is Command.WhatsAppCall -> whatsAppCall(cmd.name, cmd.video)
            is Command.PhoneCall -> phoneCall(cmd.name, cmd.sim, cmd.carrier)
            is Command.OpenApp -> openApp(cmd.appName)
            is Command.Torch -> torch(cmd.on)
            is Command.Toggle -> toggle(cmd.setting, cmd.on)
            is Command.Volume -> volume(cmd.dir)
            is Command.Global -> global(cmd.action)
            is Command.SearchIn -> searchIn(cmd.app, cmd.query)
            is Command.AppSearch -> appSearch(cmd.appName, cmd.query, cmd.fullQuery)
            is Command.Email -> sendEmail(cmd.name, cmd.subject, cmd.body)
            is Command.WhatsApp -> whatsApp.run(cmd)
            is Command.AutoTapSetup -> {
                val wasOn = SettingsActivity.isAutoTapOn(context)
                AutoTapHelper.turnOn(activity)
                if (wasOn) "Auto-Tap pehle se ON hai" else "Auto-Tap on karne ka button khol diya"
            }
            is Command.TapOn -> inApp("\"${cmd.target}\" dabaya", "\"${cmd.target}\" screen pe nahi mila") { it.tapOnText(cmd.target) }
            is Command.TypeText -> inApp("Likh raha hoon: ${cmd.text}", "Likhne ki jagah nahi mili. Pehle text box pe tap karwaiye.") { it.typeText(cmd.text) }
            is Command.Scroll -> inApp(if (cmd.down) "Neeche scroll" else "Upar scroll", "Scroll nahi ho paya") { it.scroll(cmd.down) }
            is Command.Unknown -> searchIn(SearchApp.GOOGLE, cmd.heard).let { "Samajh nahi aaya, Google pe dhundh raha hoon" }
        }
    } catch (e: ActivityNotFoundException) {
        "Ye app phone mein nahi mila."
    } catch (e: SecurityException) {
        "Permission chahiye. App settings mein permission allow kijiye."
    } catch (e: Exception) {
        "Ye kaam nahi ho paya: ${e.message ?: "unknown error"}"
    }

    // ---------- YouTube ----------
    private fun playOnYouTube(query: String): String {
        val yt = "com.google.android.youtube"
        val intent = if (isInstalled(yt)) {
            Intent(Intent.ACTION_SEARCH).setPackage(yt).putExtra("query", query)
        } else {
            view("https://www.youtube.com/results?search_query=" + enc(query))
        }
        PendingAction.set(PendingAction.Task.YouTubePlayFirst)
        launch(intent)
        return if (AutoTapService.isRunning()) "YouTube pe $query chala raha hoon"
        else "YouTube pe $query khol diya. Auto-Tap on karein to video apne aap chalega."
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
        PendingAction.set(PendingAction.Task.WhatsAppSend)
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
        return "${contact.name} ko WhatsApp ${if (video) "video" else "audio"} call laga raha hoon"
    }

    // ---------- Normal phone call, optionally from SIM 1 / SIM 2 ----------
    @SuppressLint("MissingPermission")
    private fun phoneCall(name: String, sim: Int?, carrier: String? = null): String {
        val digits = name.filter { it.isDigit() }
        val (label, number) = if (digits.length >= 10) {
            digits to digits
        } else {
            if (!has(Manifest.permission.READ_CONTACTS)) return "Contacts ki permission dijiye."
            val c = contacts.find(name) ?: return "$name contacts mein nahi mila."
            c.name to ("+" + (c.phone ?: return "${c.name} ka number nahi mila."))
        }

        if (!has(Manifest.permission.CALL_PHONE)) {
            launch(Intent(Intent.ACTION_DIAL, Uri.parse("tel:$number")))
            return "$label ka number dial kar diya. Seedha call ke liye Phone permission dijiye."
        }

        val intent = Intent(Intent.ACTION_CALL, Uri.parse("tel:$number"))
        var simNote = ""
        if (sim != null || carrier != null) {
            val wanted = carrier?.let { "$it SIM" } ?: "SIM $sim"
            if (has(Manifest.permission.READ_PHONE_STATE)) {
                val tm = context.getSystemService(Context.TELECOM_SERVICE) as TelecomManager
                val accounts = tm.callCapablePhoneAccounts
                val handle = if (carrier != null) {
                    val names = when (carrier) {
                        "vodafone", "idea", "vi" -> listOf("vi", "vodafone", "idea")
                        else -> listOf(carrier)
                    }
                    accounts.firstOrNull { h ->
                        val label = try { tm.getPhoneAccount(h)?.label?.toString()?.lowercase() } catch (e: Exception) { null } ?: ""
                        names.any { n -> Regex("\\b$n\\b").containsMatchIn(label) }
                    }
                } else {
                    accounts.getOrNull(sim!! - 1)
                }
                if (handle != null) {
                    intent.putExtra(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle)
                    simNote = " $wanted se"
                    val slot = accounts.indexOf(handle)
                    // Extra hints some phone brands read for the SIM slot (0 = SIM 1, 1 = SIM 2)
                    listOf("com.android.phone.extra.slot", "slot", "simSlot", "sim_slot", "slotId", "slotIdx")
                        .forEach { intent.putExtra(it, slot) }
                } else {
                    simNote = " ($wanted nahi mili, default SIM se)"
                }
            } else {
                simNote = " (SIM chunne ke liye Phone permission dijiye)"
                sim?.let { s -> listOf("com.android.phone.extra.slot", "slot", "simSlot", "sim_slot", "slotId", "slotIdx")
                    .forEach { intent.putExtra(it, s - 1) } }
            }
        }
        launch(intent)
        return "$label ko$simNote call kar raha hoon"
    }

    // ---------- Torch ----------
    private fun torch(on: Boolean): String {
        val cm = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val id = cm.cameraIdList.firstOrNull {
            cm.getCameraCharacteristics(it).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
        } ?: return "Is phone mein flashlight nahi mili."
        cm.setTorchMode(id, on)
        return if (on) "Torch on kar di" else "Torch band kar di"
    }

    // ---------- Wi-Fi / mobile data / Bluetooth / hotspot / location / airplane ----------
    private class ToggleSpec(
        val intents: List<Intent>,
        val keywords: List<String>,
        val excludes: List<String>,
        val firstSwitchOk: Boolean
    )

    private fun specFor(setting: Setting): ToggleSpec {
        val q = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
        return when (setting) {
            Setting.WIFI -> ToggleSpec(
                listOfNotNull(
                    if (q) Intent(Settings.Panel.ACTION_WIFI) else null,
                    Intent(Settings.ACTION_WIFI_SETTINGS)
                ),
                listOf("wi-fi", "wifi", "wlan"), emptyList(), true
            )
            Setting.MOBILE_DATA -> ToggleSpec(
                listOfNotNull(
                    if (q) Intent(Settings.Panel.ACTION_INTERNET_CONNECTIVITY) else null,
                    Intent(Settings.ACTION_DATA_ROAMING_SETTINGS)
                ),
                listOf("mobile data", "mobile network", "cellular", "data", "sim", "jio", "airtel",
                    "vodafone", "idea", "vi ", "bsnl", "carrier"),
                listOf("wi-fi", "wifi", "airplane", "aeroplane", "flight", "roaming", "hotspot"),
                false
            )
            Setting.BLUETOOTH -> ToggleSpec(
                listOf(Intent(Settings.ACTION_BLUETOOTH_SETTINGS)),
                listOf("bluetooth"), emptyList(), true
            )
            Setting.HOTSPOT -> ToggleSpec(
                listOf(
                    Intent().setClassName("com.android.settings", "com.android.settings.TetherSettings"),
                    Intent("android.settings.TETHER_SETTINGS"),
                    Intent(Settings.ACTION_WIRELESS_SETTINGS)
                ),
                listOf("hotspot", "portable", "tethering"), listOf("usb", "bluetooth", "ethernet"), false
            )
            Setting.LOCATION -> ToggleSpec(
                listOf(Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)),
                listOf("location"), emptyList(), true
            )
            Setting.AIRPLANE -> ToggleSpec(
                listOf(Intent(Settings.ACTION_AIRPLANE_MODE_SETTINGS)),
                listOf("airplane", "aeroplane", "flight"), emptyList(), false
            )
        }
    }

    private fun toggle(setting: Setting, on: Boolean): String {
        val word = if (on) "on" else "off"

        // Old phones (Android 9 and below) still let apps switch Wi-Fi directly
        if (setting == Setting.WIFI && Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            val wm = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            wm.isWifiEnabled = on
            return "Wi-Fi $word kar diya"
        }

        val spec = specFor(setting)
        val auto = AutoTapService.isRunning()
        if (auto) {
            PendingAction.set(
                PendingAction.Task.ToggleSwitch(on, spec.keywords, spec.excludes, spec.firstSwitchOk), 12_000
            )
        }
        if (!launchFirst(spec.intents)) launch(Intent(Settings.ACTION_SETTINGS))
        return if (auto) "${setting.spoken} $word kar raha hoon"
        else "${setting.spoken} ki setting khol di, switch aap dabaiye. Auto-Tap on karne se ye apne aap hoga."
    }

    // ---------- Volume ----------
    private fun volume(dir: VolumeDir): String {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val stream = AudioManager.STREAM_MUSIC
        val flags = AudioManager.FLAG_SHOW_UI
        return when (dir) {
            VolumeDir.UP -> {
                repeat(2) { am.adjustStreamVolume(stream, AudioManager.ADJUST_RAISE, flags) }
                "Volume badha diya"
            }
            VolumeDir.DOWN -> {
                repeat(2) { am.adjustStreamVolume(stream, AudioManager.ADJUST_LOWER, flags) }
                "Volume kam kar diya"
            }
            VolumeDir.MAX -> {
                am.setStreamVolume(stream, am.getStreamMaxVolume(stream), flags)
                "Volume full kar diya"
            }
            VolumeDir.MUTE -> {
                am.adjustStreamVolume(stream, AudioManager.ADJUST_MUTE, flags)
                "Volume mute kar diya"
            }
        }
    }

    // ---------- Screenshot / lock / home / back / notifications ----------
    private fun global(action: GlobalAct): String {
        val svc = AutoTapService.instance ?: return "Iske liye pehle Auto-Tap on kijiye."
        val p = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
        return when (action) {
            GlobalAct.SCREENSHOT -> {
                if (!p) return "Screenshot ke liye Android 9 ya naya chahiye."
                activity.moveTaskToBack(true)
                handler.postDelayed({ svc.performGlobalAction(AccessibilityService.GLOBAL_ACTION_TAKE_SCREENSHOT) }, 1200)
                "Screenshot le raha hoon"
            }
            GlobalAct.LOCK -> {
                if (!p) return "Lock ke liye Android 9 ya naya chahiye."
                handler.postDelayed({ svc.performGlobalAction(AccessibilityService.GLOBAL_ACTION_LOCK_SCREEN) }, 1500)
                "Phone lock kar raha hoon"
            }
            GlobalAct.HOME -> {
                svc.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
                "Home screen"
            }
            GlobalAct.BACK -> {
                activity.moveTaskToBack(true)
                "Peeche ja raha hoon"
            }
            GlobalAct.NOTIFICATIONS -> {
                svc.performGlobalAction(AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS)
                "Notifications khol di"
            }
        }
    }

    // ---------- Search in Google / Chrome / ChatGPT / Claude / Gemini / YouTube ----------
    private fun searchIn(app: SearchApp, q: String): String {
        val googleUrl = "https://www.google.com/search?q=" + enc(q)
        when (app) {
            SearchApp.GOOGLE -> {
                val pkg = "com.google.android.googlequicksearchbox"
                if (isInstalled(pkg)) {
                    launch(Intent(Intent.ACTION_WEB_SEARCH).setPackage(pkg).putExtra(SearchManager.QUERY, q))
                } else {
                    launch(view(googleUrl))
                }
            }
            SearchApp.CHROME -> {
                val i = view(googleUrl)
                if (isInstalled("com.android.chrome")) i.setPackage("com.android.chrome")
                launch(i)
            }
            SearchApp.CHATGPT -> shareOrWeb("com.openai.chatgpt", q, "https://chatgpt.com/?q=" + enc(q))
            SearchApp.CLAUDE -> shareOrWeb("com.anthropic.claude", q, "https://claude.ai/new?q=" + enc(q))
            SearchApp.GEMINI -> shareOrWeb("com.google.android.apps.bard", q, "https://gemini.google.com/app")
            SearchApp.YOUTUBE -> {
                val yt = "com.google.android.youtube"
                launch(
                    if (isInstalled(yt)) Intent(Intent.ACTION_SEARCH).setPackage(yt).putExtra("query", q)
                    else view("https://www.youtube.com/results?search_query=" + enc(q))
                )
            }
        }
        return "${app.spoken} pe pooch raha hoon: $q"
    }

    /** Sends the question into the AI app (Auto-Tap presses Send); falls back to its website. */
    private fun shareOrWeb(pkg: String, q: String, url: String) {
        copyToClipboard(q)
        if (isInstalled(pkg)) {
            val share = Intent(Intent.ACTION_SEND).setType("text/plain")
                .putExtra(Intent.EXTRA_TEXT, q).setPackage(pkg)
            if (share.resolveActivity(context.packageManager) != null) {
                PendingAction.set(PendingAction.Task.AppSend(pkg))
                launch(share)
                return
            }
            context.packageManager.getLaunchIntentForPackage(pkg)?.let { launch(it); return }
        }
        launch(view(url))
    }

    // ---------- Open any app ----------
    /** Finds an installed app by a spoken name; forgives spelling ("insta", "watsapp", "chart gpt"). */
    private fun findApp(spoken: String): android.content.pm.ResolveInfo? {
        val pm = context.packageManager
        val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val apps = pm.queryIntentActivities(launcher, 0)
            .filter { it.activityInfo.packageName != context.packageName }
            .map { it to it.loadLabel(pm).toString() }
        val target = spoken.lowercase().replace(" ", "")

        val direct = apps
            .map { (ri, label) -> Triple(ri, label, label.lowercase().replace(" ", "")) }
            .filter { (_, _, l) -> l.contains(target) || (l.length > 2 && target.contains(l)) }
            .sortedBy { (_, _, l) ->
                when {
                    l == target -> 0
                    l.startsWith(target) -> 1
                    l.contains(target) -> 2
                    else -> 3
                }
            }
            .firstOrNull()?.first
        return direct ?: NameMatch.best(spoken, apps, minScore = 2) { it.second }?.first
    }

    private fun openApp(spoken: String): String {
        val match = findApp(spoken) ?: return "$spoken app nahi mila."
        val pm = context.packageManager
        val intent = pm.getLaunchIntentForPackage(match.activityInfo.packageName) ?: return "$spoken khul nahi raha."
        launch(intent)
        return "${match.loadLabel(pm)} khol raha hoon"
    }

    // ---------- Search inside any app ----------
    private fun appSearch(appName: String, q: String, fullQuery: String): String {
        val app = findApp(appName) ?: return searchIn(SearchApp.GOOGLE, fullQuery)
        val pm = context.packageManager
        val pkg = app.activityInfo.packageName
        val label = app.loadLabel(pm).toString()

        // Apps with a proper search link open straight on the results
        val e = enc(q)
        val deepLink: Intent? = when (pkg) {
            "com.google.android.apps.maps" -> Intent(Intent.ACTION_VIEW, Uri.parse("geo:0,0?q=$e"))
            "com.android.vending" -> view("market://search?q=$e")
            "com.spotify.music" -> view("spotify:search:$e")
            "in.amazon.mShop.android.shopping", "com.amazon.mShop.android.shopping" -> view("https://www.amazon.in/s?k=$e")
            "com.flipkart.android" -> view("https://www.flipkart.com/search?q=$e")
            "com.google.android.youtube" -> Intent(Intent.ACTION_SEARCH).putExtra("query", q)
            "com.google.android.apps.youtube.music" -> view("https://music.youtube.com/search?q=$e")
            "com.google.android.googlequicksearchbox" -> Intent(Intent.ACTION_WEB_SEARCH).putExtra(SearchManager.QUERY, q)
            else -> null
        }?.setPackage(pkg)
        if (deepLink != null && launchFirst(listOf(deepLink))) return "$label pe $q dhundh raha hoon"

        // Everything else: open the app and let Auto-Tap use its search box
        val open = pm.getLaunchIntentForPackage(pkg) ?: return "$label khul nahi raha."
        copyToClipboard(q)
        val auto = AutoTapService.isRunning()
        if (auto) PendingAction.set(PendingAction.Task.InAppSearch(pkg, q), 20_000)
        launch(open)
        return if (auto) "$label mein $q dhundh raha hoon"
        else "$label khol diya. \"$q\" copy kar diya hai, search mein paste kijiye. Auto-Tap on karne se ye apne aap hoga."
    }

    // ---------- Gmail ----------
    /** "suraj 123 at gmail dot com" -> "suraj123@gmail.com" */
    private fun spokenEmail(name: String): String? {
        val t = " ${name.lowercase()} "
            .replace(" at the rate ", "@").replace(" at rate ", "@").replace(" at ", "@")
            .replace(" dot ", ".").replace(" underscore ", "_").replace(" ", "")
        return if (Regex("^[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}$").matches(t)) t else null
    }

    private fun sendEmail(name: String, subject: String, body: String): String {
        val (who, address) = spokenEmail(name)?.let { it to it } ?: run {
            if (!has(Manifest.permission.READ_CONTACTS)) return "Contacts ki permission dijiye."
            val c = contacts.find(name, requirePhone = false) ?: return "$name contacts mein nahi mila."
            val a = contacts.emailFor(c.id) ?: return "${c.name} ka email contacts mein save nahi hai."
            c.name to a
        }
        val subj = subject.ifBlank { body.split(" ").take(6).joinToString(" ") }
            .replaceFirstChar { it.uppercase() }
        val uri = Uri.parse("mailto:$address?subject=${enc(subj)}&body=${enc(body)}")
        val intent = Intent(Intent.ACTION_SENDTO, uri)
            .putExtra(Intent.EXTRA_EMAIL, arrayOf(address))
            .putExtra(Intent.EXTRA_SUBJECT, subj)
            .putExtra(Intent.EXTRA_TEXT, body)
        val gmail = "com.google.android.gm"
        val hasGmail = isInstalled(gmail)
        if (hasGmail) intent.setPackage(gmail)
        val autoSend = hasGmail && body.isNotBlank() && AutoTapService.isRunning()
        if (autoSend) PendingAction.set(PendingAction.Task.AppSend(gmail))
        launch(intent)
        return when {
            body.isBlank() -> "$who ke liye email khol diya. Kya likhna hai, wahan likhiye."
            autoSend -> "$who ko email bhej raha hoon: $body"
            else -> "$who ke liye email taiyaar hai, Send dabaiye."
        }
    }

    // ---------- Inside the app on screen ----------
    /** Steps out of zenvqo.voice so the app underneath is on screen, then Auto-Tap does the work. */
    private fun inApp(okReply: String, failReply: String, work: (AutoTapService) -> Boolean): String {
        val svc = AutoTapService.instance ?: return "Iske liye pehle Auto-Tap on kijiye."
        activity.moveTaskToBack(true)
        handler.postDelayed({
            if (!work(svc)) android.widget.Toast.makeText(context, failReply, android.widget.Toast.LENGTH_LONG).show()
        }, 900)
        return okReply
    }

    // ---------- helpers ----------
    private fun launch(i: Intent) = context.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))

    private fun launchFirst(intents: List<Intent>): Boolean {
        for (i in intents) {
            try {
                launch(i); return true
            } catch (e: ActivityNotFoundException) {
            } catch (e: SecurityException) {
            }
        }
        return false
    }

    private fun view(url: String) = Intent(Intent.ACTION_VIEW, Uri.parse(url))

    private fun copyToClipboard(text: String) {
        try {
            val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            cm.setPrimaryClip(ClipData.newPlainText("zenvqo.voice", text))
        } catch (e: Exception) {
        }
    }

    private fun has(p: String) = ContextCompat.checkSelfPermission(context, p) == PackageManager.PERMISSION_GRANTED

    private fun enc(s: String): String = URLEncoder.encode(s, "UTF-8").replace("+", "%20")

    private fun isInstalled(pkg: String) = try {
        context.packageManager.getPackageInfo(pkg, 0); true
    } catch (e: PackageManager.NameNotFoundException) {
        false
    }

    private fun whatsAppPackage(): String? =
        listOf("com.whatsapp", "com.whatsapp.w4b").firstOrNull { isInstalled(it) }
}
