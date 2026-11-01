package com.voicebuddy.app

import android.Manifest
import android.app.Activity
import android.content.ContentUris
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.ContactsContract
import android.provider.MediaStore
import android.provider.Settings
import androidx.core.content.ContextCompat
import com.voicebuddy.app.PendingAction.Step
import com.voicebuddy.app.PendingAction.Step.Companion.finish
import com.voicebuddy.app.PendingAction.Step.Companion.firstResult
import com.voicebuddy.app.PendingAction.Step.Companion.hold
import com.voicebuddy.app.PendingAction.Step.Companion.longPressMessage
import com.voicebuddy.app.PendingAction.Step.Companion.tap
import com.voicebuddy.app.PendingAction.Step.Companion.type
import com.voicebuddy.app.PendingAction.Step.Companion.typeEmpty
import com.voicebuddy.app.PendingAction.Step.Companion.wait

/**
 * Does the WhatsApp jobs from [WhatsAppParser]: opens the right chat / screen, then hands
 * Auto-Tap a list of steps (long-press the last message, tap Reply, type, tap Send…).
 * Replies are what zenvqo.voice says back.
 */
class WhatsAppActions(
    private val activity: Activity,
    private val contacts: ContactFinder,
    private val sendText: (name: String, text: String) -> String
) {
    private val context = activity

    // Common WhatsApp buttons
    private val SEND = tap("send", ids = listOf("send"), exact = true)
    private val SEND_OPT = tap("send", ids = listOf("send"), exact = true, optional = true, timeoutMs = 3_000)
    private val ATTACH = tap("attach", ids = listOf("input_attach_button"), exact = true)
    private val MORE = tap("more options", ids = listOf("menuitem_overflow"), exact = true)
    private val SEARCH = tap("search", ids = listOf("menuitem_search", "search"), exact = true)
    private val SETTINGS = listOf(MORE, tap("settings", exact = true))
    private val UPDATES_TAB = tap("updates", "status", exact = true)

    private val EMOJI = mapOf(
        "like" to listOf("👍", "thumbs up", "like"),
        "heart" to listOf("❤️", "❤", "red heart", "heart"),
        "laugh" to listOf("😂", "face with tears of joy", "laughing"),
        "wow" to listOf("😮", "face with open mouth", "surprised"),
        "sad" to listOf("😢", "crying face", "sad"),
        "pray" to listOf("🙏", "folded hands", "thanks")
    )

    private val LANG_LABELS = mapOf(
        "hindi" to listOf("हिन्दी", "हिंदी", "hindi"), "english" to listOf("english"),
        "punjabi" to listOf("ਪੰਜਾਬੀ", "punjabi"), "bengali" to listOf("বাংলা", "bengali", "bangla"),
        "bangla" to listOf("বাংলা", "bengali", "bangla"), "marathi" to listOf("मराठी", "marathi"),
        "tamil" to listOf("தமிழ்", "tamil"), "telugu" to listOf("తెలుగు", "telugu"),
        "gujarati" to listOf("ગુજરાતી", "gujarati"), "kannada" to listOf("ಕನ್ನಡ", "kannada"),
        "malayalam" to listOf("മലയാളം", "malayalam"), "urdu" to listOf("اردو", "urdu"),
        "odia" to listOf("ଓଡ଼ିଆ", "odia"), "spanish" to listOf("español", "spanish"),
        "french" to listOf("français", "french"), "arabic" to listOf("العربية", "arabic")
    )

    fun run(c: Command.WhatsApp): String {
        val pkg = whatsAppPackage() ?: return "WhatsApp install nahi hai."

        // These two don't need Auto-Tap
        when (c.action) {
            WaAction.NOTIFICATIONS -> return notifications(pkg, c.extra)
            WaAction.LINK -> return link(c)
            WaAction.SHARE_NUMBER -> return shareNumber(c)
            else -> Unit
        }
        if (!AutoTapService.isRunning()) {
            return "Iske liye pehle Auto-Tap on kijiye (Settings → zenvqo.voice → Auto-Tap)."
        }

        return when (c.action) {
            // ---------- 1. Chat with a person ----------
            WaAction.VOICE_NOTE, WaAction.VIDEO_NOTE -> withChat(pkg, c.name) { who ->
                val secs = c.extra.toIntOrNull() ?: 10
                val video = c.action == WaAction.VIDEO_NOTE
                val steps = mutableListOf<Step>()
                // Tapping the mic once switches it to the video-note camera
                if (video) steps += tap("voice message", "video message", ids = listOf("voice_note_btn"))
                steps += hold(secs * 1000L, if (video) "video message" else "voice message", "record",
                    ids = listOf("voice_note_btn"))
                Plan(steps, "$who ko ${if (video) "video" else "voice"} message bhej raha hoon. Beep ke baad $secs second boliye.")
            }
            WaAction.EDIT_LAST -> {
                if (c.text.isBlank()) return "Naya message kya likhna hai? Jaise: \"papa ka last message edit karo ki main 5 baje aaunga\""
                withChat(pkg, c.name) { who ->
                    Plan(listOf(longPressMessage(outgoing = true), MORE, tap("edit", exact = true), type(c.text), SEND),
                        "$who wala last message badal raha hoon: ${c.text}")
                }
            }
            WaAction.DELETE_LAST, WaAction.DELETE_EVERYONE -> withChat(pkg, c.name) { who ->
                val everyone = c.action == WaAction.DELETE_EVERYONE
                Plan(listOf(
                    longPressMessage(outgoing = if (everyone) true else null),
                    tap("delete", ids = listOf("menuitem_delete"), exact = true),
                    tap(if (everyone) "delete for everyone" else "delete for me", "delete")
                ), "$who chat ka last message ${if (everyone) "sabke liye" else ""} delete kar raha hoon")
            }
            WaAction.REPLY -> withChat(pkg, c.name, c.text, c.split) { who, text ->
                if (text.isBlank()) return@withChat null
                Plan(listOf(longPressMessage(outgoing = false), tap("reply", ids = listOf("menuitem_reply"), exact = true),
                    type(text), SEND), "$who ke message ka reply bhej raha hoon: $text")
            } ?: "Reply mein kya likhna hai? Jaise: \"papa ko reply karo ki haan\""
            WaAction.FORWARD -> {
                if (c.extra.isBlank()) return "Kisko forward karna hai? Jaise: \"papa ka last message rahul ko forward karo\""
                val to = contacts.find(c.extra)?.name ?: c.extra
                withChat(pkg, c.name) { who ->
                    Plan(listOf(
                        longPressMessage(outgoing = null),
                        tap("forward", ids = listOf("menuitem_forward"), exact = true),
                        SEARCH, type(to), wait(1200), tap(to.lowercase()), SEND
                    ), "$who ka last message $to ko forward kar raha hoon")
                }
            }
            WaAction.REACT -> withChat(pkg, c.name) { who ->
                Plan(listOf(longPressMessage(outgoing = false), tap(*(EMOJI[c.extra] ?: EMOJI.getValue("like")).toTypedArray())),
                    "$who ke message pe ${(EMOJI[c.extra] ?: EMOJI.getValue("like")).first()} laga raha hoon")
            }
            WaAction.GIF, WaAction.STICKER -> withChat(pkg, c.name, c.text, c.split) { who, q ->
                val gif = c.action == WaAction.GIF
                val steps = mutableListOf(
                    tap("emoji", "emojis", "emoji, gifs and stickers", ids = listOf("emoji_picker_btn")),
                    if (gif) tap("gif", "gifs", exact = true) else tap("stickers", "sticker", exact = true)
                )
                if (q.isNotBlank()) steps += listOf(tap("search", "search gifs", "search stickers", optional = true, timeoutMs = 3_000), type(q), wait(1800))
                else steps += wait(1200)
                steps += firstResult()
                if (gif) steps += SEND_OPT
                val what = if (gif) "GIF" else if (c.extra == "animated") "animated sticker" else "sticker"
                Plan(steps, "$who ko ${q.ifBlank { "" }} $what bhej raha hoon".replace("  ", " "))
            } ?: "Kisko bhejna hai? Naam ke saath boliye."
            WaAction.CONTACT_CARD -> contactCard(pkg, c)
            WaAction.LOCATION -> withChat(pkg, c.name) { who ->
                Plan(listOf(ATTACH, tap("location", exact = true), wait(2500),
                    tap("send your current location", "current location", timeoutMs = 15_000)),
                    "$who ko aapki location bhej raha hoon")
            }
            WaAction.DOCUMENT -> withChat(pkg, c.name, c.text, c.split) { who, q ->
                val dot = if (c.extra.isNotBlank()) ".${c.extra}" else ""
                val steps = mutableListOf(ATTACH, tap("document", exact = true), wait(1500))
                if (q.isNotBlank()) steps += listOf(SEARCH.copy(optional = true, timeoutMs = 3_000), type(q, optional = true), wait(1500), tap(q, orFirst = true))
                else if (dot.isNotBlank()) steps += tap(dot, orFirst = true)
                else steps += firstResult()
                steps += tap("send", exact = true, anyApp = true)
                Plan(steps, "$who ko ${q.ifBlank { "latest" }} ${c.extra.ifBlank { "document" }} bhej raha hoon")
            } ?: "Kisko bhejna hai? Naam ke saath boliye."
            WaAction.POLL -> {
                val opts = c.extra.split("|").filter { it.isNotBlank() }
                if (opts.size < 2) return "Poll ke kam se kam 2 option boliye. Jaise: \"family group ko poll bhejo kahan chalein options goa aur manali\""
                withChat(pkg, c.name) { who ->
                    val steps = mutableListOf(ATTACH, tap("poll", exact = true), type(c.text.ifBlank { "Poll" }, "question", "ask"))
                    opts.forEach { steps += typeEmpty(it); steps += wait(400) }
                    steps += SEND
                    Plan(steps, "$who ko poll bhej raha hoon: ${c.text} (${opts.joinToString(", ")})")
                }
            }
            WaAction.EVENT -> withChat(pkg, c.name, c.text, c.split) { who, name ->
                if (name.isBlank()) return@withChat null
                Plan(listOf(ATTACH, tap("event", exact = true), type(name, "event name", "name"),
                    tap("send", "create", "save", ids = listOf("send"), exact = true)),
                    "$who ko \"$name\" event ka invite bhej raha hoon")
            } ?: "Event ka naam boliye. Jaise: \"rahul ko event invite bhejo birthday party\""
            WaAction.VIEW_ONCE_PHOTO, WaAction.VIEW_ONCE_VIDEO -> viewOnce(pkg, c)
            WaAction.CALL_HISTORY -> home(pkg, listOf(tap("calls", exact = true), finish("")), "WhatsApp call history khol raha hoon")
            WaAction.SHARE_SCREEN -> {
                set(pkg, listOf(tap("share screen", "screen share", "screen sharing", "share your screen", timeoutMs = 5_000),
                    finish("Ab \"Start now\" dabaiye – screen aur audio share ho jayega.")))
                activity.moveTaskToBack(true)
                "Call mein screen aur audio share kar raha hoon"
            }

            // ---------- 2. Status & communities ----------
            WaAction.STATUS_TEXT -> {
                if (c.text.isBlank()) return "Status mein kya likhna hai? Jaise: \"status lagao ki aaj mera birthday hai\""
                home(pkg, listOf(UPDATES_TAB, tap("text", "text status", "write a status", "pencil", exact = true),
                    type(c.text), SEND), "Status laga raha hoon: ${c.text}")
            }
            WaAction.STATUS_PHOTO, WaAction.STATUS_VIDEO, WaAction.STATUS_GIF -> mediaStatus(pkg, c)
            WaAction.COMMUNITY_GROUP -> {
                if (c.name.isBlank() || c.text.isBlank()) return "Community aur naye group ka naam boliye. Jaise: \"family community mein naya group banao cousins\""
                home(pkg, listOf(
                    tap("communities", exact = true), tap(c.name), tap("add group", "add groups", "add existing groups", "new group"),
                    tap("create new group", optional = true, timeoutMs = 3_000), type(c.text, "group name", "name"),
                    tap("create", "next", "done", ids = listOf("ok", "next_btn", "fab"))
                ), "${c.name} community mein \"${c.text}\" group bana raha hoon")
            }

            // ---------- 3. Channels ----------
            WaAction.CHANNEL_SEARCH, WaAction.CHANNEL_FOLLOW, WaAction.CHANNEL_UNFOLLOW -> {
                if (c.name.isBlank()) return "Kaunsa channel? Naam ke saath boliye."
                val steps = mutableListOf(UPDATES_TAB, SEARCH, type(c.name))
                val reply = when (c.action) {
                    WaAction.CHANNEL_FOLLOW -> {
                        steps += listOf(wait(1500), tap(c.name), tap("follow", exact = true))
                        "${c.name} channel follow kar raha hoon"
                    }
                    WaAction.CHANNEL_UNFOLLOW -> {
                        steps += listOf(wait(1500), tap(c.name), MORE, tap("unfollow", exact = true),
                            tap("unfollow", exact = true, optional = true, timeoutMs = 3_000))
                        "${c.name} channel unfollow kar raha hoon"
                    }
                    else -> { steps += finish(""); "WhatsApp mein ${c.name} channel dhundh raha hoon" }
                }
                home(pkg, steps, reply)
            }
            WaAction.CHANNEL_CREATE -> home(pkg, listOf(
                UPDATES_TAB, tap("new channel", "create channel", "add channel", "+"),
                tap("create channel", exact = true, optional = true, timeoutMs = 3_000),
                tap("continue", "get started", optional = true, timeoutMs = 4_000),
                type(c.name.ifBlank { "My channel" }, "channel name", "name"),
                tap("create channel", "create", optional = true)
            ), "Naya channel bana raha hoon${if (c.name.isNotBlank()) ": ${c.name}" else ""}")

            // ---------- 4. Account ----------
            WaAction.CHANGE_NUMBER -> home(pkg, SETTINGS + listOf(
                tap("account", exact = true), tap("change number", exact = true, scroll = true),
                finish("Change number khul gaya. Purana aur naya number aap khud daaliye.")
            ), "WhatsApp mein change number khol raha hoon")
            WaAction.PROFILE_NAME -> {
                if (c.text.isBlank()) return "Naya naam kya rakhna hai? Jaise: \"whatsapp naam rahul rakho\""
                home(pkg, SETTINGS + profile() + listOf(tap("name", exact = true), type(c.text), tap("save", exact = true)),
                    "WhatsApp naam \"${c.text}\" kar raha hoon")
            }
            WaAction.ABOUT -> {
                if (c.text.isBlank()) return "About mein kya likhna hai? Jaise: \"whatsapp about change karo ki busy hoon\""
                home(pkg, SETTINGS + profile() + listOf(
                    tap("about", exact = true), tap("edit", "currently set to", optional = true, timeoutMs = 2_500),
                    type(c.text), tap("save", "ok", exact = true)
                ), "WhatsApp about \"${c.text}\" kar raha hoon")
            }
            WaAction.PROFILE_PHOTO -> home(pkg, SETTINGS + profile() + listOf(
                tap("edit", "change profile photo", "edit profile photo", "camera", "add photo"),
                tap("gallery", optional = true, timeoutMs = 4_000),
                finish("Nayi photo chun lijiye.")
            ), "Profile photo badalne ke liye gallery khol raha hoon")
            WaAction.BLOCK, WaAction.UNBLOCK -> withChat(pkg, c.name) { who ->
                val word = if (c.action == WaAction.BLOCK) "block" else "unblock"
                Plan(listOf(MORE, tap("more", exact = true), tap(word, exact = true),
                    tap(word, exact = true, optional = true, timeoutMs = 3_000, anyApp = true)),
                    "$who ko WhatsApp pe $word kar raha hoon")
            }
            WaAction.DELETE_ACCOUNT -> home(pkg, SETTINGS + listOf(
                tap("account", exact = true), tap("delete account", "delete my account", scroll = true),
                finish("Delete account khul gaya. Ye kaam wapas nahi hota – confirm aap khud kijiye.")
            ), "Delete account ki screen khol raha hoon. Account main khud delete nahi karunga.")

            // ---------- 5. Settings ----------
            WaAction.LANGUAGE -> {
                val labels = LANG_LABELS[c.text] ?: return "Kaunsi language? Jaise: \"whatsapp ki language hindi karo\""
                home(pkg, SETTINGS + listOf(tap("app language", scroll = true, timeoutMs = 12_000),
                    tap(*labels.toTypedArray(), scroll = true, timeoutMs = 12_000)),
                    "WhatsApp ki language ${c.text} kar raha hoon")
            }
            WaAction.DARK_MODE, WaAction.LIGHT_MODE -> {
                val dark = c.action == WaAction.DARK_MODE
                home(pkg, SETTINGS + listOf(tap("chats", exact = true), tap("theme", exact = true),
                    tap(if (dark) "dark" else "light", exact = true), tap("ok", exact = true, anyApp = true)),
                    "WhatsApp ${if (dark) "dark" else "light"} mode kar raha hoon")
            }
            WaAction.WALLPAPER -> {
                val kind = when (c.extra) { "dark" -> listOf("dark"); "solid" -> listOf("solid colours", "solid colors", "solid colour"); else -> listOf("bright") }
                home(pkg, SETTINGS + listOf(
                    tap("chats", exact = true), tap("wallpaper", "chat wallpaper", exact = true),
                    tap("change", exact = true, optional = true, timeoutMs = 3_000), tap(*kind.toTypedArray(), exact = true),
                    wait(1000), firstResult(), tap("set wallpaper", "set"),
                    tap("for all chats", "ok", optional = true, timeoutMs = 3_000, anyApp = true)
                ), "WhatsApp wallpaper badal raha hoon")
            }
            WaAction.NOTIFICATIONS, WaAction.LINK, WaAction.SHARE_NUMBER -> "" // handled above
        }
    }

    // =====================================================================================
    private data class Plan(val steps: List<Step>, val reply: String)

    private fun profile() = listOf(tap("profile", ids = listOf("profile_info", "profile_info_name"), orFirst = true))

    /** Opens the chat with [spoken], then runs the steps from [build]. Groups are found with WhatsApp search. */
    private fun withChat(pkg: String, spoken: String, build: (who: String) -> Plan): String =
        withChat(pkg, spoken, "", false) { who, _ -> build(who) }
            ?: "Kisse baat karni hai? Naam ke saath boliye."

    private fun withChat(pkg: String, spoken: String, text: String, split: Boolean, build: (who: String, text: String) -> Plan?): String? {
        if (spoken.isBlank()) return "Kiski chat? Naam ke saath boliye."
        var name = spoken
        var payload = text
        val canRead = has(Manifest.permission.READ_CONTACTS)
        var contact: Contact? = null
        val isGroup = Regex("\\b(group|grp|community)\\b").containsMatchIn(spoken)
        if (!isGroup && canRead) {
            if (split && payload.isBlank()) {
                contacts.splitNameAndText(spoken)?.let { (c, rest) -> contact = c; payload = rest; name = c.name }
            }
            if (contact == null) contact = contacts.find(name)?.also { name = it.name }
        }
        val plan = build(name, payload) ?: return null

        val phone = contact?.phone
        return if (phone != null) {
            set(pkg, listOf(wait(1500)) + plan.steps)
            launch(Intent(Intent.ACTION_VIEW, Uri.parse("https://api.whatsapp.com/send?phone=$phone")).setPackage(pkg))
            plan.reply
        } else {
            // Group or unsaved: open WhatsApp and search for the chat
            home(pkg, listOf(SEARCH, type(name), wait(1200), tap(name.lowercase())) + plan.steps, plan.reply)
        }
    }

    /** Starts WhatsApp fresh on its main screen and runs the steps. */
    private fun home(pkg: String, steps: List<Step>, reply: String): String {
        val open = context.packageManager.getLaunchIntentForPackage(pkg) ?: return "WhatsApp khul nahi raha."
        set(pkg, listOf(wait(1500)) + steps)
        launch(open.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK))
        return reply
    }

    private fun set(pkg: String, steps: List<Step>) {
        val total = steps.sumOf { maxOf(it.timeoutMs, it.ms) }.coerceIn(30_000, 120_000)
        PendingAction.set(PendingAction.Task.Flow("com.whatsapp", steps), total)
        AutoTapService.instance?.kickFlow()
    }

    // ---------- Text-only jobs (go through the normal message path) ----------
    private fun link(c: Command.WhatsApp): String {
        if (c.split || c.text.isBlank()) {
            val (contact, rest) = contacts.splitNameAndText(c.name) ?: return "Link kisko bhejna hai? Naam ke saath boliye."
            if (rest.isBlank()) return "Kaunsa link? Jaise: \"papa ko link bhejo google dot com\""
            return sendText(contact.name, WhatsAppParser.spokenUrl(rest))
        }
        return sendText(c.name, c.text)
    }

    private fun shareNumber(c: Command.WhatsApp): String {
        if (!has(Manifest.permission.READ_CONTACTS)) return "Contacts ki permission dijiye."
        val who = contacts.find(c.extra) ?: return "${c.extra} contacts mein nahi mila."
        val num = who.phone ?: return "${who.name} ka number nahi mila."
        return sendText(c.name, "${who.name}: +$num")
    }

    // ---------- Contact card ----------
    private fun contactCard(pkg: String, c: Command.WhatsApp): String {
        if (!has(Manifest.permission.READ_CONTACTS)) return "Contacts ki permission dijiye."
        val card = contacts.find(c.extra) ?: return "${c.extra} contacts mein nahi mila."
        val to = contacts.find(c.name) ?: return "${c.name} contacts mein nahi mila."
        val toPhone = to.phone ?: return "${to.name} ka number nahi mila."
        val lookup = lookupKey(card.id) ?: return "${card.name} ka contact card nahi bana."
        val vcard = Uri.withAppendedPath(ContactsContract.Contacts.CONTENT_VCARD_URI, lookup)
        val intent = Intent(Intent.ACTION_SEND).setType("text/x-vcard")
            .putExtra(Intent.EXTRA_STREAM, vcard)
            .putExtra("jid", "$toPhone@s.whatsapp.net")
            .setPackage(pkg)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        set(pkg, listOf(tap(to.name.lowercase(), optional = true, timeoutMs = 3_000), SEND_OPT.copy(timeoutMs = 4_000), SEND_OPT))
        launch(intent)
        return "${to.name} ko ${card.name} ka contact card bhej raha hoon"
    }

    private fun lookupKey(id: Long): String? =
        context.contentResolver.query(
            ContactsContract.Contacts.CONTENT_URI, arrayOf(ContactsContract.Contacts.LOOKUP_KEY),
            "${ContactsContract.Contacts._ID} = ?", arrayOf(id.toString()), null
        )?.use { if (it.moveToFirst()) it.getString(0) else null }

    // ---------- View once / status (latest photo, video or GIF from the gallery) ----------
    private fun viewOnce(pkg: String, c: Command.WhatsApp): String {
        val video = c.action == WaAction.VIEW_ONCE_VIDEO
        val media = latestMedia(video = video, gif = false) ?: return mediaProblem(video)
        if (!has(Manifest.permission.READ_CONTACTS)) return "Contacts ki permission dijiye."
        val to = contacts.find(c.name) ?: return "${c.name} contacts mein nahi mila."
        val phone = to.phone ?: return "${to.name} ka number nahi mila."
        val intent = Intent(Intent.ACTION_SEND).setType(if (video) "video/*" else "image/*")
            .putExtra(Intent.EXTRA_STREAM, media).putExtra("jid", "$phone@s.whatsapp.net")
            .setPackage(pkg).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        set(pkg, listOf(tap("view once", "turn on view once"), SEND))
        launch(intent)
        return "${to.name} ko aapki latest ${if (video) "video" else "photo"} view once bhej raha hoon"
    }

    private fun mediaStatus(pkg: String, c: Command.WhatsApp): String {
        val video = c.action == WaAction.STATUS_VIDEO
        val gif = c.action == WaAction.STATUS_GIF
        val media = latestMedia(video, gif) ?: return mediaProblem(video, gif)
        val steps = mutableListOf(tap("my status", "status", exact = true), SEND)
        if (c.extra.isNotBlank()) steps += listOf(   // music
            tap("music", "add music", optional = true, timeoutMs = 4_000),
            type(c.extra, "search", optional = true), wait(2000), firstResult(optional = true),
            tap("done", "add", exact = true, optional = true, timeoutMs = 3_000)
        )
        if (c.text.isNotBlank()) steps += listOf(   // sticker
            tap("stickers", "sticker", "emoji", optional = true, timeoutMs = 4_000),
            type(c.text, "search", optional = true), wait(1800), firstResult(optional = true)
        )
        steps += SEND_OPT.copy(timeoutMs = 5_000)
        val intent = Intent(Intent.ACTION_SEND)
            .setType(if (video) "video/*" else if (gif) "image/gif" else "image/*")
            .putExtra(Intent.EXTRA_STREAM, media).setPackage(pkg)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        set(pkg, steps)
        launch(intent)
        val what = if (video) "video" else if (gif) "GIF" else "photo"
        val extras = listOfNotNull(c.extra.takeIf { it.isNotBlank() }?.let { "\"$it\" gaane" }, c.text.takeIf { it.isNotBlank() }?.let { "$it sticker" })
        return "Latest $what status pe laga raha hoon" + if (extras.isNotEmpty()) " ${extras.joinToString(" aur ")} ke saath" else ""
    }

    private fun mediaProblem(video: Boolean, gif: Boolean = false): String {
        val perms = mediaPermissions(video)
        if (perms.any { !has(it) }) {
            activity.requestPermissions(perms, 7)
            return "Photos/videos ki permission dijiye, phir dobara boliye."
        }
        return "Gallery mein koi ${if (video) "video" else if (gif) "GIF" else "photo"} nahi mili."
    }

    private fun mediaPermissions(video: Boolean): Array<String> =
        if (Build.VERSION.SDK_INT >= 33) arrayOf(if (video) Manifest.permission.READ_MEDIA_VIDEO else Manifest.permission.READ_MEDIA_IMAGES)
        else arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)

    /** Newest photo / video / GIF on the phone. */
    private fun latestMedia(video: Boolean, gif: Boolean): Uri? {
        if (mediaPermissions(video).any { !has(it) }) return null
        val base = if (video) MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        val sel = if (gif) "${MediaStore.MediaColumns.MIME_TYPE} = ?" else null
        val args = if (gif) arrayOf("image/gif") else null
        return try {
            context.contentResolver.query(base, arrayOf(MediaStore.MediaColumns._ID), sel, args,
                "${MediaStore.MediaColumns.DATE_ADDED} DESC")?.use {
                if (it.moveToFirst()) ContentUris.withAppendedId(base, it.getLong(0)) else null
            }
        } catch (e: Exception) { null }
    }

    // ---------- WhatsApp notifications (Android settings page for WhatsApp) ----------
    private fun notifications(pkg: String, onOff: String): String {
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, pkg)
        else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$pkg"))
        val auto = onOff.isNotBlank() && AutoTapService.isRunning()
        if (auto) PendingAction.set(PendingAction.Task.ToggleSwitch(
            onOff == "on", listOf("all whatsapp notifications", "show notifications", "allow notifications", "notifications"),
            emptyList(), true), 12_000)
        launch(intent)
        return when {
            auto -> "WhatsApp notifications $onOff kar raha hoon"
            else -> "WhatsApp notification settings khol di"
        }
    }

    // ---------- helpers ----------
    private fun launch(i: Intent) = context.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))

    private fun has(p: String) = ContextCompat.checkSelfPermission(context, p) == PackageManager.PERMISSION_GRANTED

    private fun whatsAppPackage(): String? = listOf("com.whatsapp", "com.whatsapp.w4b").firstOrNull {
        try { context.packageManager.getPackageInfo(it, 0); true } catch (e: PackageManager.NameNotFoundException) { false }
    }
}
