package com.voicebuddy.app

/** Every WhatsApp job beyond a plain text message and calls. */
enum class WaAction {
    // Chat with one person (or group)
    VOICE_NOTE, VIDEO_NOTE, EDIT_LAST, DELETE_LAST, DELETE_EVERYONE, REPLY, FORWARD, REACT,
    GIF, STICKER, LINK, CONTACT_CARD, SHARE_NUMBER, LOCATION, DOCUMENT, POLL, EVENT,
    VIEW_ONCE_PHOTO, VIEW_ONCE_VIDEO, CALL_HISTORY, SHARE_SCREEN,
    // Status & communities
    STATUS_TEXT, STATUS_PHOTO, STATUS_VIDEO, STATUS_GIF, COMMUNITY_GROUP,
    // Channels
    CHANNEL_FOLLOW, CHANNEL_UNFOLLOW, CHANNEL_SEARCH, CHANNEL_CREATE,
    // Account
    CHANGE_NUMBER, PROFILE_NAME, PROFILE_PHOTO, ABOUT, BLOCK, UNBLOCK, DELETE_ACCOUNT,
    // Settings
    LANGUAGE, NOTIFICATIONS, DARK_MODE, LIGHT_MODE, WALLPAPER
}

/**
 * Understands the WhatsApp commands (Hinglish / English). Input is already normalized by
 * [CommandParser.normalize] (lowercase, padded with spaces). Pure Kotlin, unit tested.
 *
 * Field use in [Command.WhatsApp]:
 *  name  = person / group / channel / community
 *  text  = the words to type (reply, new text, status, search query, poll question, event name…)
 *  extra = second value (forward-to person, emoji, seconds, poll options "a|b|c", on/off, music…)
 *  split = name may still hold the text too ("papa happy birthday"); the executor splits it with contacts.
 */
object WhatsAppParser {

    private val FILLERS = setOf(
        "whatsapp", "app", "on", "pe", "par", "per", "ko", "to", "a", "an", "the", "please", "plz", "ek",
        "karo", "kar", "kardo", "do", "de", "dena", "dedo", "bhejo", "bhej", "bhejna", "bhejiye", "send", "share",
        "ke", "ka", "ki", "last", "aakhri", "akhri", "aakhiri", "pichla", "pichhla", "pichle", "latest", "recent",
        "wala", "wali", "wale", "my", "mera", "meri", "mere", "message", "msg", "messages", "chat", "se", "me",
        "mein", "in", "of", "for", "with", "from", "usko", "use", "is", "this", "jo", "maine", "usne", "bheja",
        "now", "abhi", "jaldi", "and", "aur", "s", "his", "her", "sent", "received", "mujhe", "apna", "apni", "apne",
        "wo", "woh", "vo", "us", "uske", "uska", "kiya", "hua", "aaya", "aya"
    )

    private val SEND = Regex(" (bhejo|bhej|bhej do|bhejna|bhejiye|send|share|forward|dedo|de do) ")
    private val CALL_WORDS = Regex(" (call|calling|dial|ring) ")

    /** " ki " only counts as "the message is…" right after a verb: "bhejo ki …", "reply karo ki …". */
    private val TEXT_CUT = Regex(
        " (?:karo|kar do|kardo|bhejo|bhej do|do|dena|reply|jawab|lagao|laga do|daalo|dalo|likho|post karo|update karo|upload karo|rakho) (ki) | (saying|that|bolo|likho) "
    )

    fun parse(s: String): Command? {
        val cut = TEXT_CUT.find(s)
        val cutAt = cut?.let { m -> (m.groups[1] ?: m.groups[2])!!.range.first - 1 }
        val head = if (cutAt != null) s.substring(0, cutAt) + " " else s
        val tail = if (cut != null) s.substring(cut.range.last).trim() else ""
        fun has(p: String) = Regex(p).containsMatchIn(head)

        // --- Settings & account -------------------------------------------------------
        settings(head, tail, ::has)?.let { return it }

        // --- Status ---------------------------------------------------------------------
        if (has(" (status|story) ")) return status(head, tail)

        // --- Channels / communities ------------------------------------------------------
        if (has(" (channel|channels) ") && !has(" (youtube|telegram|tv) ")) return channel(head, ::has)
        if (has(" (community|communities) ")) return community(head)

        // --- Calls tab / screen share ------------------------------------------------
        if (has(" (call history|call log|call logs|call list|calls|calls list) ") && !has(" ko ")) {
            return Command.WhatsApp(WaAction.CALL_HISTORY)
        }
        if (has(" (screen share|share screen|screen sharing|share my screen|share audio|audio share) ")) {
            return Command.WhatsApp(WaAction.SHARE_SCREEN)
        }

        // --- Voice / video notes -----------------------------------------------------
        if (has(" (voice|audio|awaaz|awaz|aawaz|aawaaz) (message|msg|note|notes|record) | voice note | record karke bhejo ")) {
            return Command.WhatsApp(WaAction.VOICE_NOTE, person(head, VOICE_WORDS), extra = seconds(head).toString())
        }
        if (has(" video (message|msg|note|notes) ")) {
            return Command.WhatsApp(WaAction.VIDEO_NOTE, person(head, VOICE_WORDS), extra = seconds(head).toString())
        }

        // --- View once ---------------------------------------------------------------
        if (has(" (view once|ek baar|one time|once|1 time|viewonce) ") && has(" (photo|pic|picture|image|video|foto|tasveer) ")) {
            val video = has(" video ")
            return Command.WhatsApp(
                if (video) WaAction.VIEW_ONCE_VIDEO else WaAction.VIEW_ONCE_PHOTO,
                person(head, MEDIA_WORDS + setOf("view", "once", "baar", "one", "time", "1", "viewonce"))
            )
        }

        // --- Message actions ----------------------------------------------------------
        if (has(" (delete|mitao|mita do|mita|hatao|remove|unsend|delet) ") && has(" (message|msg|messages|last|aakhri|akhri|pichla) ")) {
            val everyone = has(" (everyone|sabke|sab ke|sabse|sab|for all|both|dono) ")
            return Command.WhatsApp(
                if (everyone) WaAction.DELETE_EVERYONE else WaAction.DELETE_LAST,
                person(head, setOf("delete", "delet", "mitao", "mita", "hatao", "remove", "unsend", "everyone", "sabke",
                    "sab", "sabse", "all", "both", "dono", "liye", "lie"))
            )
        }
        if (has(" (edit|badlo|badal|change|sudharo) ") && has(" (message|msg) ")) {
            val rest = tail.ifBlank { afterWord(head, "(?:edit|badlo|badal do|change|sudharo)") }
            return Command.WhatsApp(WaAction.EDIT_LAST,
                person(head.replace(" $rest ", " "), setOf("edit", "badlo", "badal", "change", "sudharo", "theek", "message")),
                rest)
        }
        if (has(" (reply|jawab|jawaab|javab|jvab|jabab) ")) return reply(head, tail)
        if (has(" forward ")) return forward(head)
        if (has(" (react|reaction|reacts) ") || (has(" (like|heart|dil|thumbs up) ") && has(" (message|msg) "))) {
            return Command.WhatsApp(WaAction.REACT, person(head, REACT_STOP), extra = emoji(head))
        }

        // --- Things to send -----------------------------------------------------------
        if (has(" (gif|gifs) ")) return media(WaAction.GIF, head, setOf("gif", "gifs"))
        if (has(" (sticker|stickers) ")) {
            val animated = has(" (animated|moving|chalta|chalne|animation) ")
            val c = media(WaAction.STICKER, head, setOf("sticker", "stickers", "animated", "moving", "chalta", "chalne", "wala", "animation"))
            return c.copy(extra = if (animated) "animated" else "")
        }
        if (has(" poll ")) return poll(s)
        if (has(" (event|invitation|invite) ")) return event(head, tail)
        if (CALL_WORDS.containsMatchIn(head)) return null

        contactOrNumber(head)?.let { return it }
        if (has(" (location|loc|lokeshan|lokation) ") && SEND.containsMatchIn(head)) {
            return Command.WhatsApp(WaAction.LOCATION, person(head, setOf("location", "loc", "lokeshan", "lokation", "current", "live", "abhi", "ki")))
        }
        if (has(" (document|documents|doc|docs|pdf|zip|file|files|excel|word file) ") && SEND.containsMatchIn(head)) return document(head)
        if (has(" (link|url|website) ") && SEND.containsMatchIn(head)) return link(head, tail)
        return null
    }

    // ================================================================================
    private val VOICE_WORDS = setOf(
        "voice", "audio", "awaaz", "awaz", "aawaz", "aawaaz", "note", "notes", "record", "karke", "video",
        "second", "seconds", "sec", "secs", "minute", "minutes", "min", "ka", "ki", "das", "bees", "tees",
        "paanch", "pandrah", "chalis", "pachas"
    ) + (0..99).map { it.toString() }

    private val MEDIA_WORDS = setOf("photo", "pic", "picture", "image", "video", "foto", "tasveer", "gallery")

    private val REACT_STOP = setOf(
        "react", "reaction", "reacts", "like", "heart", "dil", "thumbs", "up", "love", "pyaar", "haha", "hasi",
        "laugh", "lol", "funny", "wow", "shock", "surprise", "sad", "rona", "dukhi", "cry", "pray", "namaste",
        "thanks", "thank", "you", "dhanyavad", "hath", "jod", "emoji", "lagao", "laga", "wala", "smile", "hasna"
    )

    private fun settings(h: String, tail: String, has: (String) -> Boolean): Command? {
        val wa = h.contains(" whatsapp ")
        val changeWord = has(" (change|badlo|badal|badal do|update|set|rakho|rakh do|karo|kar do|lagao|likho|edit) ")

        if (has(" account ") && has(" (delete|hatao|remove|mitao|khatam|band|delet) ")) return Command.WhatsApp(WaAction.DELETE_ACCOUNT)
        if (has(" (number|phone number|mobile number) ") && has(" (change|badlo|badal|update) ") && (wa || has(" (account|apna|mera|my) "))) {
            return Command.WhatsApp(WaAction.CHANGE_NUMBER)
        }
        if (wa && has(" dark (mode|theme) | dark karo | dark kar do ")) return Command.WhatsApp(WaAction.DARK_MODE)
        if (wa && has(" (light|white) (mode|theme) ")) return Command.WhatsApp(WaAction.LIGHT_MODE)
        if (wa && has(" (wallpaper|background) ")) {
            val kind = when {
                has(" (dark|kala|black) ") -> "dark"
                has(" (solid|plain|colour|color|rang) ") -> "solid"
                else -> "bright"
            }
            return Command.WhatsApp(WaAction.WALLPAPER, extra = kind)
        }
        if (wa && has(" (language|bhasha|bhasa|lang|langauge) ")) {
            val lang = LANGS.firstOrNull { has(" $it ") } ?: ""
            return Command.WhatsApp(WaAction.LANGUAGE, text = lang)
        }
        if (wa && has(" (notification|notifications) ")) {
            val onOff = when {
                has(" (off|band|bandh|disable|mute|hatao|chup) ") -> "off"
                has(" (on|chalu|enable|start) ") -> "on"
                else -> ""
            }
            return Command.WhatsApp(WaAction.NOTIFICATIONS, extra = onOff)
        }
        if (wa && has(" about ") && changeWord && !has(" (tell|batao|what|kya) ")) {
            val text = tail.ifBlank {
                edge(h, setOf("whatsapp", "about", "change", "badlo", "badal", "update", "set", "rakho", "rakh", "karo",
                    "kar", "do", "likho", "edit", "my", "mera", "meri", "ka", "ki", "ke", "me", "mein", "pe", "to", "the",
                    "please", "se", "lagao", "status"))
            }
            return Command.WhatsApp(WaAction.ABOUT, text = text)
        }
        val photoWord = has(" (dp|pfp|profile photo|profile pic|profile picture|display picture) ") ||
            (has(" profile ") && has(" (photo|pic|picture|image|tasveer|foto) "))
        if (photoWord && changeWord) return Command.WhatsApp(WaAction.PROFILE_PHOTO)
        if (wa && has(" (name|naam) ") && changeWord && !has(" (group|community|channel) ")) {
            val to = Regex(" (?:name|naam) (?:change |update |set )?(?:karke |karo |kar do )?(?:to|se) (.+?) $").find(h)
            val newName = to?.groupValues?.get(1)?.let { edge(" $it ", NAME_EDGE) } ?: edge(h, NAME_EDGE)
            return Command.WhatsApp(WaAction.PROFILE_NAME, text = tail.ifBlank { newName })
        }
        if (has(" unblock ")) return Command.WhatsApp(WaAction.UNBLOCK, person(h, setOf("unblock")))
        if (has(" (block|blok) ")) return Command.WhatsApp(WaAction.BLOCK, person(h, setOf("block", "blok")))
        return null
    }

    private val NAME_EDGE = setOf(
        "whatsapp", "name", "naam", "change", "badlo", "badal", "ke", "kar", "karke", "karo", "do", "update", "set",
        "rakho", "rakh", "my", "mera", "meri", "ka", "ki", "pe", "par", "me", "mein", "to", "the", "please", "se",
        "profile", "apna"
    )

    val LANGS = listOf(
        "english", "hindi", "punjabi", "bengali", "bangla", "marathi", "tamil", "telugu", "gujarati", "kannada",
        "malayalam", "urdu", "odia", "spanish", "french", "arabic"
    )

    // ---------- Status ----------
    private val STATUS_EDGE = setOf(
        "whatsapp", "status", "story", "text", "lagao", "laga", "do", "daalo", "dalo", "upload", "update", "post",
        "set", "karo", "kar", "rakho", "pe", "par", "me", "mein", "my", "mera", "meri", "a", "the", "to", "likho",
        "likh", "new", "naya", "nayi", "ek", "put", "add", "write", "please", "on", "pr", "photo", "pic", "picture",
        "image", "video", "gif", "foto", "tasveer", "latest", "last", "wali", "wala", "ka", "ki", "ke", "as", "with",
        "and", "aur", "bhi"
    )

    private fun status(h: String, tail: String): Command {
        var rest = h
        val music = musicQuery(rest)
        if (music != null) rest = music.second
        val sticker = stickerQuery(rest)
        if (sticker != null) rest = sticker.second
        val action = when {
            Regex(" (photo|pic|picture|image|foto|tasveer|selfie) ").containsMatchIn(rest) -> WaAction.STATUS_PHOTO
            Regex(" video ").containsMatchIn(rest) -> WaAction.STATUS_VIDEO
            Regex(" (gif|gifs) ").containsMatchIn(rest) -> WaAction.STATUS_GIF
            music != null || sticker != null -> WaAction.STATUS_PHOTO
            else -> WaAction.STATUS_TEXT
        }
        return if (action == WaAction.STATUS_TEXT) {
            Command.WhatsApp(action, text = tail.ifBlank { edge(rest, STATUS_EDGE) })
        } else {
            Command.WhatsApp(action, text = sticker?.first ?: "", extra = music?.first ?: "")
        }
    }

    private val MUSIC = "(?:song|music|gaana|gana|gaane|gane|songs)"
    private val TOGETHER = "(?:ke saath|ke sath|saath|sath|with|lagao|laga do|add karo|add|daalo|dalo)"

    /** Returns (song, text without the song part). */
    private fun musicQuery(h: String): Pair<String, String>? {
        val patterns = listOf(
            Regex(" (?:with|add) (?:the )?$MUSIC (.+?) $"),
            Regex(" $MUSIC (.+?) $TOGETHER "),
            Regex(" ((?:[a-z0-9]+ ){1,4})$MUSIC $TOGETHER "),
            Regex(" ((?:[a-z0-9]+ ){1,4})$MUSIC $")
        )
        for (p in patterns) {
            val m = p.find(h) ?: continue
            val q = edge(" ${m.groupValues[1]} ", STATUS_EDGE)
            if (q.isNotBlank()) return q to (h.substring(0, m.range.first) + " " + h.substring(m.range.last + 1)).replace(Regex("\\s+"), " ").let { " ${it.trim()} " }
        }
        return null
    }

    private fun stickerQuery(h: String): Pair<String, String>? {
        val m = Regex(" ((?:[a-z0-9]+ ){0,3})(?:ka |wala |wali )?(?:sticker|stickers) ").find(h) ?: return null
        val q = edge(" ${m.groupValues[1]} ", STATUS_EDGE)
        return q to (h.substring(0, m.range.first) + " " + h.substring(m.range.last + 1)).let { " ${it.trim()} " }
    }

    // ---------- Channels ----------
    private val CHANNEL_STOP = setOf(
        "channel", "channels", "follow", "unfollow", "search", "dhundo", "dhoondo", "dhundho", "find", "khojo",
        "karo", "kar", "do", "create", "banao", "bana", "bnao", "new", "naya", "ka", "ki", "ke", "the", "a",
        "whatsapp", "pe", "par", "me", "mein", "on", "named", "naam", "called", "please", "band", "hatao", "chhodo",
        "stop", "my", "mera", "apna", "open", "kholo", "ko", "for", "se", "in", "ek", "an", "start"
    )

    private fun channel(h: String, has: (String) -> Boolean): Command {
        val name = strip(h, CHANNEL_STOP)
        val action = when {
            has(" (create|banao|bana|bnao|new|naya|start) ") -> WaAction.CHANNEL_CREATE
            has(" unfollow ") || (has(" follow ") && has(" (band|hatao|chhodo|stop) ")) -> WaAction.CHANNEL_UNFOLLOW
            has(" follow ") -> WaAction.CHANNEL_FOLLOW
            else -> WaAction.CHANNEL_SEARCH
        }
        return Command.WhatsApp(action, name)
    }

    // ---------- Community: new group inside it ----------
    private val COMMUNITY_STOP = setOf(
        "whatsapp", "community", "communities", "group", "groups", "me", "mein", "mai", "naya", "nayi", "new", "ek",
        "banao", "bana", "bnao", "create", "karo", "kar", "do", "named", "naam", "ka", "ki", "ke", "called", "in",
        "add", "a", "an", "the", "pe", "par", "please", "make", "inside", "andar", "my", "mera", "meri"
    )

    private fun community(h: String): Command {
        val en = Regex(" in (?:the )?(.+?) (?:community|communities) ").find(h)
        val (comm, group) = if (en != null) {
            strip(en.groupValues[1], COMMUNITY_STOP) to strip(h.substring(0, en.range.first), COMMUNITY_STOP)
        } else {
            val i = Regex(" (?:community|communities) ").find(h)!!.range.first
            strip(h.substring(0, i), COMMUNITY_STOP) to strip(h.substring(i), COMMUNITY_STOP)
        }
        return Command.WhatsApp(WaAction.COMMUNITY_GROUP, comm, group)
    }

    // ---------- Reply / forward ----------
    private val REPLY_STOP = setOf("reply", "jawab", "jawaab", "javab", "jvab", "jabab", "karo", "kar", "do", "message")

    private fun reply(h: String, tail: String): Command {
        if (tail.isNotBlank()) return Command.WhatsApp(WaAction.REPLY, person(h, REPLY_STOP), tail)
        val after = Regex(" (?:reply|jawab|jawaab|javab|jvab|jabab) (?:karo |kar do |kardo |do |de do |dedo |bhejo )?(.+)$").find(h)
            ?.groupValues?.get(1)?.trim().orEmpty()
        val before = Regex("^(.*?) (?:reply|jawab|jawaab|javab|jvab|jabab) ").find(h)?.groupValues?.get(1).orEmpty()
        val beforeName = person(" $before ", REPLY_STOP)
        return when {
            // "reply to papa ok" -> executor splits "papa ok"
            after.startsWith("to ") -> Command.WhatsApp(WaAction.REPLY, strip(after.removePrefix("to "), emptySet()), split = true)
            beforeName.isNotBlank() -> Command.WhatsApp(WaAction.REPLY, beforeName, after)
            else -> Command.WhatsApp(WaAction.REPLY, strip(after, FILLERS), split = true)
        }
    }

    private fun forward(h: String): Command {
        val hi = Regex("^ ?(.+?) (?:ka|ke|ki|wala|wali|se aaya|se aya|ne bheja) (?:.*?)?(?:message |msg |)?(.+?) ko forward ").find(h)
        if (hi != null) return Command.WhatsApp(WaAction.FORWARD, person(" ${hi.groupValues[1]} ", emptySet()),
            extra = person(" ${hi.groupValues[2]} ", emptySet()))
        val en = Regex(" forward (?:the )?(?:last )?(?:message |msg )?(?:from |of )?(.+?) (?:s )?(?:last )?(?:message |msg )?to (.+?) $").find(h)
        if (en != null) return Command.WhatsApp(WaAction.FORWARD, person(" ${en.groupValues[1]} ", emptySet()),
            extra = person(" ${en.groupValues[2]} ", emptySet()))
        return Command.WhatsApp(WaAction.FORWARD, person(h, setOf("forward")))
    }

    fun emoji(h: String): String = when {
        Regex(" (heart|dil|love|pyaar|pyar) ").containsMatchIn(h) -> "heart"
        Regex(" (haha|hasi|hasna|laugh|lol|funny|smile) ").containsMatchIn(h) -> "laugh"
        Regex(" (wow|shock|surprise|hairan) ").containsMatchIn(h) -> "wow"
        Regex(" (sad|rona|dukhi|cry) ").containsMatchIn(h) -> "sad"
        Regex(" (pray|namaste|thanks|thank|dhanyavad|hath jod) ").containsMatchIn(h) -> "pray"
        else -> "like"
    }

    // ---------- GIF / sticker ----------
    private fun media(action: WaAction, h: String, words: Set<String>): Command.WhatsApp {
        val stop = words + setOf("bhejo", "bhej", "send", "share", "karo", "kar", "do", "ka", "ki", "ke", "wala", "wali",
            "a", "an", "the", "ek", "of", "koi", "pe", "par", "on", "whatsapp", "please", "dedo", "de")
        val r = recipient(h)
        return if (r != null) Command.WhatsApp(action, r.first, strip(r.second, stop))
        else Command.WhatsApp(action, strip(h, stop), split = true)
    }

    // ---------- Poll ----------
    private fun poll(s: String): Command {
        var body = s
        var options = ""
        Regex(" (?:options|option|choices|choice|vikalp|opshan|opsan) (.+)$").find(s)?.let { m ->
            val raw = m.groupValues[1].trim()
            val parts = if (Regex(" (aur|or|and|comma) ").containsMatchIn(" $raw "))
                " $raw ".split(Regex(" (?:aur|or|and|comma) ")) else raw.split(" ")
            options = parts.map { it.trim() }.filter { it.isNotBlank() }.joinToString("|")
            body = s.substring(0, m.range.first) + " "
        }
        val qStop = setOf("question", "sawal", "sawaal", "savaal", "asking", "about", "ki", "that", "poll")
        val en = Regex(" poll (?:to|in|for) (.+?) (?:asking|question|sawal|sawaal|ki|about|that) (.+?) $").find(body)
        if (en != null) return Command.WhatsApp(WaAction.POLL, person(" ${en.groupValues[1]} ", emptySet()),
            edge(" ${en.groupValues[2]} ", qStop), options)
        val hi = Regex("^ ?(.+?) (?:ko|me|mein|mai|group me) (?:ek |a )?poll (?:bhejo|bhej do|send karo|send|banao|create karo|create|karo|daalo|dalo)? ?(.*)$").find(body)
        if (hi != null) return Command.WhatsApp(WaAction.POLL, person(" ${hi.groupValues[1]} ", emptySet()),
            edge(" ${hi.groupValues[2]} ", qStop + setOf("bhejo", "send", "banao", "karo")), options)
        val r = recipient(body)
        val stop = setOf("poll", "bhejo", "send", "banao", "create", "karo", "a", "an", "ek", "question", "sawal")
        return if (r != null) Command.WhatsApp(WaAction.POLL, r.first, edge(r.second, stop), options)
        else Command.WhatsApp(WaAction.POLL, strip(body, stop + FILLERS), "", options)
    }

    // ---------- Event ----------
    private fun event(h: String, tail: String): Command {
        val stop = setOf("event", "events", "invite", "invitation", "bhejo", "bhej", "send", "banao", "create", "karo",
            "kar", "do", "ka", "ke", "ek", "a", "an", "the", "for", "naam", "named", "called", "pe", "par", "whatsapp",
            "share", "an", "please")
        val r = recipient(h)
        return when {
            r != null -> Command.WhatsApp(WaAction.EVENT, r.first, tail.ifBlank { strip(r.second, stop) })
            tail.isNotBlank() -> Command.WhatsApp(WaAction.EVENT, person(h, stop), tail)
            else -> Command.WhatsApp(WaAction.EVENT, strip(h, stop), split = true)
        }
    }

    // ---------- Contact card / phone number ----------
    private fun contactOrNumber(h: String): Command? {
        if (!SEND.containsMatchIn(h)) return null
        val kinds = "(contact card|contact|phone number|mobile number|number|no)"
        val hi = Regex("^ ?(.+?) ko (.+?) (?:ka|ki|ke) $kinds ").find(h)
        val en1 = Regex(" (?:send|share) (?:the )?(.+?) s $kinds (?:to|with) (.+?) $").find(h)
        val en2 = Regex(" (?:send|share) (?:the )?$kinds (?:of|for) (.+?) (?:to|with) (.+?) $").find(h)
        val (to, who, kind) = when {
            hi != null -> Triple(hi.groupValues[1], hi.groupValues[2], hi.groupValues[3])
            en1 != null -> Triple(en1.groupValues[3], en1.groupValues[1], en1.groupValues[2])
            en2 != null -> Triple(en2.groupValues[3], en2.groupValues[2], en2.groupValues[1])
            else -> return null
        }
        val action = if (kind.startsWith("contact")) WaAction.CONTACT_CARD else WaAction.SHARE_NUMBER
        return Command.WhatsApp(action, person(" $to ", emptySet()), extra = person(" $who ", emptySet()))
    }

    // ---------- Document / PDF / ZIP ----------
    private fun document(h: String): Command {
        val ext = when {
            Regex(" pdf ").containsMatchIn(h) -> "pdf"
            Regex(" zip ").containsMatchIn(h) -> "zip"
            Regex(" (excel|xls|xlsx|sheet) ").containsMatchIn(h) -> "xls"
            Regex(" (word file|docx) ").containsMatchIn(h) -> "doc"
            else -> ""
        }
        val stop = setOf("document", "documents", "doc", "docs", "docx", "pdf", "zip", "file", "files", "excel", "xls",
            "xlsx", "sheet", "word", "bhejo", "bhej", "send", "share", "karo", "kar", "do", "ka", "ki", "ke", "wala",
            "wali", "a", "an", "the", "my", "mera", "meri", "ek", "latest", "last", "recent", "naya", "new", "named",
            "naam", "called", "pe", "par", "whatsapp", "on", "please", "dedo", "de", "vo", "wo")
        val r = recipient(h)
        return if (r != null) Command.WhatsApp(WaAction.DOCUMENT, r.first, strip(r.second, stop), ext)
        else Command.WhatsApp(WaAction.DOCUMENT, strip(h, stop), "", ext, split = true)
    }

    // ---------- Link ----------
    private val TLDS = setOf("com", "in", "org", "net", "io", "co", "dev", "app", "ai", "me", "info")

    fun spokenUrl(t: String): String {
        var u = " $t "
            .replace(" dot ", ".").replace(" slash ", "/").replace(" colon ", ":")
            .replace(" dash ", "-").replace(" hyphen ", "-").replace(" underscore ", "_")
            .trim()
        val words = u.split(" ")
        if (words.size >= 2 && words.last() in TLDS) u = words.dropLast(1).joinToString("") + "." + words.last()
        if (u.contains('.')) u = u.replace(" ", "")
        return u
    }

    private fun link(h: String, tail: String): Command {
        val stop = setOf("link", "url", "website", "bhejo", "bhej", "send", "share", "karo", "kar", "do", "ka", "ki",
            "ke", "the", "a", "this", "ye", "yeh", "wala", "wali", "ek", "pe", "par", "whatsapp", "on", "of", "please")
        val r = recipient(h)
        return if (r != null) Command.WhatsApp(WaAction.LINK, r.first, spokenUrl(tail.ifBlank { strip(r.second, stop) }))
        else Command.WhatsApp(WaAction.LINK, strip(h, stop), tail, split = tail.isBlank())
    }

    // ================================================================================
    /** "papa ko …" or "… to papa" -> (papa, the rest). */
    fun recipient(h: String): Pair<String, String>? {
        val t = h.trim()
        Regex("^(.+?) ko (.*)$").find(t)?.let { m ->
            val n = strip(m.groupValues[1], FILLERS)
            if (n.isNotBlank() && m.groupValues[1].split(" ").size <= 4) return n to " ${m.groupValues[2]} "
        }
        Regex("^(.*) (?:to|with) (.+?)$").find(t)?.let { m ->
            val n = strip(m.groupValues[2], FILLERS)
            if (n.isNotBlank() && m.groupValues[2].split(" ").size <= 4) return n to " ${m.groupValues[1]} "
        }
        return null
    }

    private fun person(h: String, extra: Set<String>): String = strip(h, FILLERS + extra)

    private fun afterWord(h: String, word: String): String =
        Regex(" $word (?:karke |karo |kar do |kardo |to )?(.+?) $").find(h)?.groupValues?.get(1)?.let {
            if (Regex("^(karo|kar do|kardo|do)$").matches(it)) "" else it
        } ?: ""

    private fun seconds(h: String): Int {
        val words = mapOf("paanch" to 5, "das" to 10, "pandrah" to 15, "bees" to 20, "tees" to 30, "chalis" to 40, "pachas" to 50)
        Regex(" (\\d+) (second|seconds|sec|secs|minute|minutes|min) ").find(h)?.let { m ->
            val n = m.groupValues[1].toInt() * (if (m.groupValues[2].startsWith("min")) 60 else 1)
            return n.coerceIn(2, 55)
        }
        words.entries.firstOrNull { h.contains(" ${it.key} second") }?.let { return it.value }
        return 10
    }

    private fun strip(text: String, fillers: Set<String>): String =
        text.trim().split(" ").filter { it.isNotBlank() && it !in fillers }.joinToString(" ")

    /** Removes filler words from the start and end only, so the middle of a sentence stays intact. */
    private fun edge(text: String, fillers: Set<String>): String {
        val w = text.trim().split(" ").filter { it.isNotBlank() }
        var a = 0
        var b = w.size
        while (a < b && w[a] in fillers) a++
        while (b > a && w[b - 1] in fillers) b--
        return w.subList(a, b).joinToString(" ")
    }
}
