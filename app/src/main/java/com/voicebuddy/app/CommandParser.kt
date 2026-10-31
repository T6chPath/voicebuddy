package com.voicebuddy.app

/** Everything the assistant knows how to do. */
sealed class Command {
    data class PlayYouTube(val query: String) : Command()
    /** text may be blank: then the executor splits "name + text" using the contact list. */
    data class WhatsAppMessage(val name: String, val text: String) : Command()
    data class WhatsAppCall(val name: String, val video: Boolean) : Command()
    data class PhoneCall(val name: String) : Command()
    data class OpenApp(val appName: String) : Command()
    data class Unknown(val heard: String) : Command()
}

/**
 * Turns what the user said (English or Hinglish, Roman script) into a Command.
 *
 *  "papa ko whatsapp video call karo"        -> WhatsAppCall("papa", video = true)
 *  "video call papa on whatsapp"              -> WhatsAppCall("papa", video = true)
 *  "papa ko message bhejo ki main aa raha hoon" -> WhatsAppMessage("papa", "main aa raha hoon")
 *  "send message to rahul saying hello"       -> WhatsAppMessage("rahul", "hello")
 *  "youtube pe kesariya chalao" / "play kesariya" -> PlayYouTube("kesariya")
 *  "mummy ko call karo"                       -> PhoneCall("mummy")
 *  "open instagram" / "instagram kholo"       -> OpenApp("instagram")
 */
object CommandParser {

    private val CALL_FILLERS = setOf(
        "whatsapp", "whats", "app", "on", "pe", "par", "per", "se", "via", "using",
        "video", "voice", "audio", "call", "calling", "karo", "kar", "kardo", "do", "please",
        "plz", "lagao", "laga", "ko", "to", "a", "an", "make", "start", "give", "place",
        "ek", "me", "mein", "the", "phone", "dial", "now", "abhi", "jaldi", "open", "kholo", "and"
    )

    private val MSG_FILLERS = setOf(
        "whatsapp", "whats", "app", "on", "pe", "par", "per", "send", "a", "an", "the",
        "message", "msg", "text", "messages", "bhejo", "bhej", "karo", "kar", "do", "dena",
        "ko", "to", "please", "plz", "ek", "write", "likho"
    )

    private val PLAY_FILLERS = setOf(
        "play", "youtube", "you", "tube", "on", "pe", "par", "per", "chalao", "chala",
        "bajao", "baja", "lagao", "laga", "do", "song", "songs", "gaana", "gana", "gaane",
        "video", "please", "plz", "the", "a", "search", "open", "kholo", "khol", "and", "ke", "karo", "kar", "me", "mein"
    )

    private val OPEN_FILLERS = setOf(
        "open", "kholo", "khol", "launch", "start", "chalu", "karo", "kar", "do", "app",
        "application", "please", "plz", "the", "my", "mera", "meri"
    )

    private val MESSAGE_SEPARATORS = listOf(" ki ", " that ", " saying ", " bolo ", " likho ")

    fun parse(raw: String): Command {
        val s = " " + raw.lowercase()
            .replace(Regex("[^a-z0-9\\s']"), " ")
            .replace(Regex("\\s+"), " ")
            .trim() + " "

        val hasWhatsApp = s.contains("whatsapp") || s.contains("whats app")

        // 1) Messages (checked first so "...ki mujhe call karna" stays a message)
        if (Regex(" (message|msg|text|messages|bhejo) ").containsMatchIn(s)) {
            val sep = MESSAGE_SEPARATORS.firstOrNull { s.contains(it) }
            if (sep != null) {
                val idx = s.indexOf(sep)
                val name = strip(s.substring(0, idx), MSG_FILLERS)
                val text = s.substring(idx + sep.length).trim()
                if (name.isNotBlank() && text.isNotBlank()) return Command.WhatsAppMessage(name, text)
            }
            // "papa ko message karo main aa raha hoon"
            val hinglish = Regex("^ ?(.+?) ko (?:whatsapp )?(?:pe |par )?(?:message|msg|text) (?:bhejo|karo|kar do|send karo|do)? ?(.*)$")
                .find(s.trim())
            if (hinglish != null) {
                val name = strip(hinglish.groupValues[1], MSG_FILLERS)
                val text = hinglish.groupValues[2].trim()
                if (name.isNotBlank()) return Command.WhatsAppMessage(name, text)
            }
            // "message papa I am coming" -> executor splits name/text via contacts
            val rest = strip(s, MSG_FILLERS)
            if (rest.isNotBlank()) return Command.WhatsAppMessage(rest, "")
        }

        // 2) Calls
        if (Regex(" (video|voice|audio) (call|calling) ").containsMatchIn(s) ||
            Regex(" call| calling| dial ").containsMatchIn(s)
        ) {
            val isVideo = s.contains(" video ")
            val name = strip(s, CALL_FILLERS)
            if (name.isNotBlank()) {
                return when {
                    isVideo || hasWhatsApp || s.contains(" voice call") || s.contains(" audio call") ->
                        Command.WhatsAppCall(name, video = isVideo)
                    else -> Command.PhoneCall(name)
                }
            }
        }

        // 3) YouTube / play
        if (Regex(" (play|chalao|chala do|bajao|baja do|lagao|laga do|youtube) ").containsMatchIn(s)) {
            val query = strip(s, PLAY_FILLERS)
            return if (query.isBlank()) Command.OpenApp("youtube") else Command.PlayYouTube(query)
        }

        // 4) Open any app
        if (Regex(" (open|kholo|khol do|launch|start|chalu karo) ").containsMatchIn(s)) {
            val app = strip(s, OPEN_FILLERS)
            if (app.isNotBlank()) return Command.OpenApp(app)
        }

        return Command.Unknown(raw)
    }

    private fun strip(text: String, fillers: Set<String>): String =
        text.trim().split(" ").filter { it.isNotBlank() && it !in fillers }.joinToString(" ")
}
