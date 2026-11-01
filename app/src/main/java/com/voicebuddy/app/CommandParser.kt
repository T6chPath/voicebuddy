package com.voicebuddy.app

enum class Setting(val spoken: String) {
    WIFI("Wi-Fi"), MOBILE_DATA("Mobile data"), BLUETOOTH("Bluetooth"),
    HOTSPOT("Hotspot"), LOCATION("Location"), AIRPLANE("Airplane mode")
}

enum class VolumeDir { UP, DOWN, MUTE, MAX }

enum class GlobalAct { SCREENSHOT, LOCK, HOME, BACK, NOTIFICATIONS }

enum class SearchApp(val spoken: String) {
    GOOGLE("Google"), CHROME("Chrome"), CHATGPT("ChatGPT"),
    CLAUDE("Claude"), GEMINI("Gemini"), YOUTUBE("YouTube")
}

/** Everything the assistant knows how to do. */
sealed class Command {
    data class PlayYouTube(val query: String) : Command()
    /** text may be blank: then the executor splits "name + text" using the contact list. */
    data class WhatsAppMessage(val name: String, val text: String) : Command()
    data class WhatsAppCall(val name: String, val video: Boolean) : Command()
    data class PhoneCall(val name: String, val sim: Int? = null, val carrier: String? = null) : Command()
    data class OpenApp(val appName: String) : Command()
    data class Torch(val on: Boolean) : Command()
    data class Toggle(val setting: Setting, val on: Boolean) : Command()
    data class Volume(val dir: VolumeDir) : Command()
    data class Global(val action: GlobalAct) : Command()
    data class SearchIn(val app: SearchApp, val query: String) : Command()
    /** Search inside any other app ("instagram pe virat kohli search karo"); falls back to Google with [fullQuery]. */
    data class AppSearch(val appName: String, val query: String, val fullQuery: String) : Command()
    data class Email(val name: String, val subject: String, val body: String) : Command()
    /** Work inside the app on screen: press a button by its name, type text, scroll. */
    data class TapOn(val target: String) : Command()
    data class TypeText(val text: String) : Command()
    data class Scroll(val down: Boolean) : Command()
    /** Any other WhatsApp job (voice note, reply, status, channels, settings…), see [WhatsAppParser]. */
    data class WhatsApp(
        val action: WaAction, val name: String = "", val text: String = "", val extra: String = "",
        val split: Boolean = false
    ) : Command()
    data class Unknown(val heard: String) : Command()
}

/**
 * Turns what the user said (English or Hinglish, Roman script) into a Command.
 * Pure Kotlin (no Android), so it is covered by unit tests in src/test.
 */
object CommandParser {

    private val CALL_FILLERS = setOf(
        "whatsapp", "app", "on", "pe", "par", "per", "se", "via", "using", "from", "through", "with",
        "video", "voice", "audio", "call", "calling", "karo", "kar", "kardo", "do", "please",
        "plz", "lagao", "laga", "milao", "ko", "to", "a", "an", "make", "start", "give", "place",
        "ek", "me", "mein", "the", "phone", "dial", "now", "abhi", "jaldi", "open", "kholo", "and",
        "sim", "number", "no", "by", "ke", "ka", "ki", "my", "mere", "mera", "meri", "ring", "lagana",
        "lagaiye", "karna", "kijiye", "kariye", "karwao", "card", "slot", "wali", "wala", "taraf"
    )

    private val MSG_FILLERS = setOf(
        "whatsapp", "app", "on", "pe", "par", "per", "send", "a", "an", "the",
        "message", "msg", "text", "messages", "sms", "bhejo", "bhej", "karo", "kar", "kardo", "do", "dena",
        "ko", "to", "please", "plz", "ek", "write", "likho"
    )

    private val PLAY_FILLERS = setOf(
        "play", "youtube", "on", "pe", "par", "per", "chalao", "chala",
        "bajao", "baja", "lagao", "laga", "do", "song", "songs", "gaana", "gana", "gaane",
        "video", "please", "plz", "the", "a", "search", "open", "kholo", "khol", "and", "ke",
        "karo", "kar", "me", "mein"
    )

    private val OPEN_FILLERS = setOf(
        "open", "kholo", "khol", "launch", "start", "chalu", "karo", "kar", "do", "app",
        "application", "please", "plz", "the", "my", "mera", "meri"
    )

    /** Removed only from the start/end of a search query, so the question itself stays intact. */
    private val EDGE_FILLERS = setOf(
        "search", "karo", "kar", "kardo", "do", "pe", "par", "per", "se", "me", "mein", "on", "in",
        "from", "using", "to", "pucho", "poocho", "puchho", "poochho", "puchiye", "ask", "dhundo",
        "dhoondo", "dhundho", "find", "khojo", "batao", "bataiye", "bata", "please", "plz", "open",
        "kholo", "and", "the", "a", "for", "about", "app", "ke", "baare", "bare", "ko", "aur", "then"
    )

    private val MESSAGE_SEPARATORS = listOf(" ki ", " that ", " saying ", " bolo ", " likho ")

    private val MEDIA_WORDS = Regex(" (youtube|song|songs|gaana|gana|gaane|play|bajao|video|videos) ")
    private val OFF_WORDS = Regex(" (off|band|bandh|bund|disable|bujhao|bujha|hatao|close|deactivate) ")
    private val SEARCH_INTENT = Regex(
        " (search|pucho|poocho|puchho|poochho|puchiye|ask|dhundo|dhoondo|dhundho|find|khojo|batao|bataiye|bata) "
    )
    private val VIA = Regex(" (pe|par|per|se|me|mein|on|in|from|using|to) ")

    private val APP_WORDS: Map<SearchApp, List<String>> = linkedMapOf(
        SearchApp.CHATGPT to listOf("chatgpt", "gpt", "chatgbt", "chatgtp"),
        SearchApp.CLAUDE to listOf("claude", "claud", "cloude", "clawd", "cloud"),
        SearchApp.GEMINI to listOf("gemini", "jemini", "gemni"),
        SearchApp.CHROME to listOf("chrome", "crome", "krome"),
        SearchApp.GOOGLE to listOf("google", "googal", "gugal"),
        SearchApp.YOUTUBE to listOf("youtube")
    )

    private const val SIM_WORD = "sim ?(?:number |no |card |slot )?"
    private val SIM1 = Regex(
        " $SIM_WORD(1|one|ek|won|van|wan|pehla|pahla|pehli|pahli|first) | (pehli|pahli|pahali|pehali|pehla|pahla|first|1st) sim "
    )
    private val SIM2 = Regex(
        " $SIM_WORD(2|two|to|too|tu|do|dusra|doosra|dusri|doosri|second) | (dusri|doosri|dusari|doosari|dusra|doosra|second|2nd) sim "
    )
    private val SIM_ANY = Regex(
        " $SIM_WORD(1|one|ek|won|van|wan|pehla|pahla|pehli|pahli|first|2|two|to|too|tu|do|dusra|doosra|dusri|doosri|second) " +
            "| (pehli|pahli|pahali|pehali|pehla|pahla|first|1st|dusri|doosri|dusari|doosari|dusra|doosra|second|2nd) sim "
    )
    private val CARRIERS = Regex(" (jio|airtel|vodafone|idea|vi|bsnl)( sim)? ")

    private val JOINS = listOf(
        "wi fi" to "wifi", "why fi" to "wifi", "whats app" to "whatsapp", "you tube" to "youtube",
        "chat gpt" to "chatgpt", "chat gbt" to "chatgpt", "chat g p t" to "chatgpt",
        "blue tooth" to "bluetooth", "hot spot" to "hotspot", "flash light" to "flashlight",
        "torch light" to "torch", "screen shot" to "screenshot", "aero plane" to "aeroplane",
        "air plane" to "airplane", "g p s" to "gps", "turn of" to "turn off", "switch of" to "switch off",
        "sim card" to "sim", "g mail" to "gmail", "e mail" to "email", "insta gram" to "instagram",
        "face book" to "facebook", "play store" to "playstore", "google maps" to "maps",
        "vai phai" to "wifi", "vai fai" to "wifi", "mobail deta" to "mobile data"
    )

    /** Single words that Hindi speech / Hindi letters turn into something else. */
    private val WORD_FIXES = mapOf(
        "kol" to "call", "kaul" to "call", "kall" to "call", "kaal" to "call",
        "seem" to "sim", "sym" to "sim", "simm" to "sim", "nambar" to "number", "nambr" to "number",
        "vidiyo" to "video", "vidio" to "video", "veedio" to "video",
        "maisej" to "message", "mesej" to "message", "maisaj" to "message",
        "vhatsaep" to "whatsapp", "vhatsep" to "whatsapp", "vhatsap" to "whatsapp", "vhatsaip" to "whatsapp",
        "vatsap" to "whatsapp", "vatsaep" to "whatsapp", "whatsep" to "whatsapp",
        "yutyub" to "youtube", "yutub" to "youtube", "yootyoob" to "youtube",
        "lait" to "light", "vaiphai" to "wifi", "vaifai" to "wifi", "blututh" to "bluetooth",
        "deta" to "data", "intaranet" to "internet", "intarnet" to "internet", "sarch" to "search",
        "imel" to "email", "mel" to "mail", "jimel" to "gmail", "skrinshot" to "screenshot",
        "skrinashot" to "screenshot", "barhao" to "badhao", "avaz" to "awaaz", "avaj" to "awaaz",
        "volyum" to "volume", "phon" to "phone", "fon" to "phone", "chaitajipiti" to "chatgpt",
        "chaitjipiti" to "chatgpt", "krom" to "chrome", "jiyo" to "jio", "eyaratel" to "airtel",
        "hotaspot" to "hotspot", "lokeshan" to "location", "lok" to "lock", "oph" to "off",
        "ple" to "play", "taip" to "type", "klik" to "click", "skrol" to "scroll", "instagrama" to "instagram"
    )

    /**
     * App and command words that speech often mis-spells. Close variants are corrected:
     * "chart gpt" / "chat gbd" -> chatgpt, "blutooth" -> bluetooth, "watsapp" -> whatsapp.
     */
    private val VOCAB = listOf(
        "chatgpt", "claude", "gemini", "google", "chrome", "youtube", "whatsapp", "gmail",
        "instagram", "facebook", "telegram", "snapchat", "spotify", "netflix", "flipkart", "amazon",
        "playstore", "bluetooth", "hotspot", "flashlight", "screenshot", "location", "airplane",
        "notification", "notifications", "volume"
    )
    private val VOCAB_SET = VOCAB.toSet()

    private fun closeWord(w: String, maxLenForOne: Int = 6): String? {
        if (w.length < 5 || w in VOCAB_SET) return null
        var best: String? = null
        var bestD = Int.MAX_VALUE
        for (v in VOCAB) {
            if (v[0] != w[0]) continue
            val limit = if (v.length > maxLenForOne) 2 else 1
            val d = NameMatch.distance(w, v)
            if (d <= limit && d < bestD) { bestD = d; best = v }
        }
        return best
    }

    /** Corrects mis-heard app words, joining split words first ("chart gpt" -> "chatgpt"). */
    private fun fixSpelling(words: List<String>): List<String> {
        val out = mutableListOf<String>()
        var i = 0
        while (i < words.size) {
            val w = words[i]
            if (i + 1 < words.size) {
                val joined = w + words[i + 1]
                if (joined.length >= 6 && words[i + 1].length >= 2) {
                    val fixed = if (joined in VOCAB_SET) joined else closeWord(joined)
                    if (fixed != null && w !in VOCAB_SET && words[i + 1] !in VOCAB_SET && closeWord(w) == null) {
                        out.add(fixed); i += 2; continue
                    }
                }
            }
            out.add(closeWord(w) ?: w)
            i++
        }
        return out
    }

    fun normalize(raw: String): String {
        var s = " " + Translit.toRoman(raw).lowercase()
            .replace(Regex("[^a-z0-9\\s]"), " ")
            .replace(Regex("\\s+"), " ")
            .trim() + " "
        for ((a, b) in JOINS) s = s.replace(" $a ", " $b ")
        val words = s.trim().split(" ").filter { it.isNotBlank() }.map { WORD_FIXES[it] ?: it }
        val fixed = fixSpelling(words)
        return " " + fixed.joinToString(" ") + " "
    }

    fun parse(raw: String): Command {
        val s = normalize(raw)
        if (s.isBlank()) return Command.Unknown(raw)

        parseTap(s)?.let { return it }
        parseScroll(s)?.let { return it }
        parseType(s, raw)?.let { return it }
        WhatsAppParser.parse(s)?.let { return it }
        parseEmail(s)?.let { return it }
        parseMessage(s)?.let { return it }
        parseSearch(s)?.let { return it }
        parseCall(s)?.let { return it }
        if (!MEDIA_WORDS.containsMatchIn(s)) {
            parseTorch(s)?.let { return it }
            parseToggle(s)?.let { return it }
            parseVolume(s)?.let { return it }
            parseGlobal(s)?.let { return it }
        }
        parsePlay(s)?.let { return it }
        parseOpen(s)?.let { return it }
        return Command.Unknown(raw)
    }

    // ---------- WhatsApp message ----------
    private fun parseMessage(s: String): Command? {
        val isMessage = Regex(" (message|msg|text|messages|sms|bhejo) ").containsMatchIn(s) ||
            Regex(" whatsapp (karo|kar|kardo) ").containsMatchIn(s)
        if (!isMessage) return null

        val sep = MESSAGE_SEPARATORS.firstOrNull { s.contains(it) }
        if (sep != null) {
            val idx = s.indexOf(sep)
            val name = strip(s.substring(0, idx), MSG_FILLERS)
            val text = s.substring(idx + sep.length).trim()
            if (name.isNotBlank() && text.isNotBlank()) return Command.WhatsAppMessage(name, text)
        }
        // "papa ko message karo main aa raha hoon"
        val hinglish = Regex(
            "^(.+?) ko (?:whatsapp )?(?:pe |par )?(?:message|msg|text|whatsapp) (?:bhejo|karo|kar do|kardo|send karo|do)? ?(.*)$"
        ).find(s.trim())
        if (hinglish != null) {
            val name = strip(hinglish.groupValues[1], MSG_FILLERS)
            val text = hinglish.groupValues[2].trim()
            if (name.isNotBlank()) return Command.WhatsAppMessage(name, text)
        }
        // "message papa I am coming" -> executor splits name/text via contacts
        val rest = strip(s, MSG_FILLERS)
        return if (rest.isNotBlank()) Command.WhatsAppMessage(rest, "") else null
    }

    // ---------- Search in ChatGPT / Claude / Gemini / Google / Chrome / YouTube ----------
    private fun parseSearch(s: String): Command? {
        val app = APP_WORDS.entries.firstOrNull { (_, words) -> words.any { s.contains(" $it ") } }?.key
        val hasIntent = SEARCH_INTENT.containsMatchIn(s)
        if (app != null) {
            if (app == SearchApp.YOUTUBE && !hasIntent) return null   // "youtube pe X chalao" = play
            if (!hasIntent && !VIA.containsMatchIn(s)) return null      // "chrome kholo" = open app
            val appWords = APP_WORDS.getValue(app).toSet()
            val q = edgeStrip(s.trim().split(" ").filter { it.isNotBlank() && it !in appWords })
            return if (q.isBlank()) Command.OpenApp(app.spoken.lowercase()) else Command.SearchIn(app, q)
        }
        if (hasIntent) {
            val words = s.trim().split(" ").filter { it.isNotBlank() }
            // Hinglish: "<app> pe/par/me <query> search karo"
            val viaIdx = words.indexOfFirst { it in setOf("pe", "par", "per", "me", "mein") }
            if (viaIdx in 1..3) {
                val appName = strip(words.take(viaIdx).joinToString(" "), OPEN_FILLERS)
                val q = edgeStrip(words.drop(viaIdx + 1))
                if (appName.isNotBlank() && q.isNotBlank()) return Command.AppSearch(appName, q, q)
            }
            // English: "search <query> on/in <app>"
            val onIdx = words.indexOfLast { it == "on" || it == "in" }
            if (onIdx >= 1 && onIdx < words.size - 1 && onIdx >= words.size - 3) {
                val appName = words.drop(onIdx + 1).joinToString(" ")
                val q = edgeStrip(words.take(onIdx))
                if (q.isNotBlank()) return Command.AppSearch(appName, q, edgeStrip(words))
            }
        }
        if (s.contains(" search ")) {
            val q = edgeStrip(s.trim().split(" ").filter { it.isNotBlank() })
            if (q.isNotBlank()) return Command.SearchIn(SearchApp.GOOGLE, q)
        }
        return null
    }

    // ---------- Gmail ----------
    private val EMAIL_FILLERS = setOf(
        "send", "email", "emails", "mail", "gmail", "ko", "to", "bhejo", "bhej", "karo", "kar", "kardo",
        "do", "a", "an", "on", "pe", "par", "per", "ek", "write", "likho", "please", "plz", "kholo",
        "open", "the", "new", "compose"
    )
    private val BODY_SEPS = listOf(" ki ", " that ", " saying ", " message ", " body ", " likho ")

    private fun parseEmail(s: String): Command? {
        if (!Regex(" (email|emails|mail|gmail) ").containsMatchIn(s)) return null
        val subjIdx = s.indexOf(" subject ")
        val name: String
        var subject = ""
        var body = ""
        if (subjIdx >= 0) {
            name = strip(s.substring(0, subjIdx), EMAIL_FILLERS)
            val rest = s.substring(subjIdx + " subject".length)
            val sep = BODY_SEPS.firstOrNull { rest.contains(it) }
            if (sep != null) {
                val i = rest.indexOf(sep)
                subject = rest.substring(0, i).trim()
                body = rest.substring(i + sep.length).trim()
            } else {
                subject = rest.trim()
            }
        } else {
            val sep = BODY_SEPS.firstOrNull { s.contains(it) }
            if (sep != null) {
                val i = s.indexOf(sep)
                name = strip(s.substring(0, i), EMAIL_FILLERS)
                body = s.substring(i + sep.length).trim()
            } else {
                name = strip(s, EMAIL_FILLERS)
            }
        }
        if (name.isBlank()) return null
        return Command.Email(name, subject, body)
    }

    // ---------- Inside the app on screen ----------
    private val TAP_FILLERS = setOf(
        "the", "button", "icon", "option", "wala", "wali", "wale", "on", "pe", "par", "per", "ko",
        "a", "an", "karo", "kar", "do", "please", "plz"
    )

    private fun parseTap(s: String): Command? {
        val patterns = listOf(
            Regex("^ (?:tap|click|press|touch)(?: karo| kar do)? (?:on |the |pe |par )*(.+?) $"),
            Regex("^ (.+?) (?:pe |par |per |ko |on )?(?:tap|click|press|touch)(?: karo| kar do| kardo| kar)? $"),
            Regex("^ (.+?) (?:dabao|daba do|dabaiye) $")
        )
        for (p in patterns) {
            val m = p.find(s) ?: continue
            val target = strip(m.groupValues[1], TAP_FILLERS)
            if (target.isNotBlank()) return Command.TapOn(target)
        }
        return null
    }

    private fun parseScroll(s: String): Command? {
        if (!Regex(" scroll | page (down|up) ").containsMatchIn(s)) return null
        val up = Regex(" (up|upar|uper|oopar|top) ").containsMatchIn(s)
        return Command.Scroll(down = !up)
    }

    private fun parseType(s: String, raw: String): Command? {
        Regex("^ (?:type karo|likh do|type|likho) (.+) $").find(s)?.let { m ->
            val r = raw.trim()
            // keep the user's own capital letters for "type Hello Rahul"
            val text = if (r.lowercase().startsWith("type ") && !r.lowercase().startsWith("type karo "))
                r.substring(5).trim() else m.groupValues[1].trim()
            return if (text.isNotBlank()) Command.TypeText(text) else null
        }
        Regex("^ (.+?) (?:type|likho) (?:karo |kar do |kardo )?$").find(s)?.let { m ->
            val text = m.groupValues[1].trim()
            return if (text.isNotBlank()) Command.TypeText(text) else null
        }
        return null
    }

    // ---------- Calls (SIM 1 / SIM 2 / WhatsApp voice / WhatsApp video) ----------
    private fun parseCall(s0: String): Command? {
        val isCall = Regex(" (call|calling|dial|ring) ").containsMatchIn(s0) ||
            Regex(" phone (karo|lagao|kar|kardo|milao) ").containsMatchIn(s0)
        if (!isCall) return null

        val sim = when {
            SIM1.containsMatchIn(s0) -> 1
            SIM2.containsMatchIn(s0) -> 2
            else -> null
        }
        val carrier = if (sim == null) CARRIERS.find(s0)?.groupValues?.get(1) else null
        var s = SIM_ANY.replace(s0, " ")
        if (carrier != null) s = CARRIERS.replace(s, " ")
        s = " " + s.trim().replace(Regex("\\s+"), " ") + " "
        val hasWhatsApp = s.contains(" whatsapp ")
        val isVideo = s.contains(" video ")
        val name = strip(s, CALL_FILLERS)
        if (name.isBlank()) return null
        return when {
            isVideo || hasWhatsApp || s.contains(" voice call") || s.contains(" audio call") ->
                Command.WhatsAppCall(name, video = isVideo)
            else -> Command.PhoneCall(name, sim, carrier)
        }
    }

    // ---------- Phone controls ----------
    private fun parseTorch(s: String): Command? {
        if (!Regex(" (torch|flashlight|flash|light|lights|lite|torchlight) ").containsMatchIn(s)) return null
        return Command.Torch(!OFF_WORDS.containsMatchIn(s))
    }

    private fun parseToggle(s: String): Command? {
        val setting = when {
            Regex(" (hotspot|tethering) ").containsMatchIn(s) -> Setting.HOTSPOT
            Regex(" (airplane|aeroplane|flight) ").containsMatchIn(s) -> Setting.AIRPLANE
            Regex(" bluetooth ").containsMatchIn(s) -> Setting.BLUETOOTH
            Regex(" (location|gps) ").containsMatchIn(s) -> Setting.LOCATION
            Regex(" (data|cellular) ").containsMatchIn(s) -> Setting.MOBILE_DATA
            Regex(" (wifi|wlan|wireless) ").containsMatchIn(s) -> Setting.WIFI
            Regex(" (internet|net) ").containsMatchIn(s) -> Setting.MOBILE_DATA
            else -> return null
        }
        return Command.Toggle(setting, !OFF_WORDS.containsMatchIn(s))
    }

    private fun parseVolume(s: String): Command? {
        if (!Regex(" (volume|awaaz|aawaz|awaz|aawaaz|sound) ").containsMatchIn(s)) return null
        val dir = when {
            Regex(" (mute|silent|chup|band|bandh|off) ").containsMatchIn(s) -> VolumeDir.MUTE
            Regex(" (full|max|maximum|poora|pura|puri|poori) ").containsMatchIn(s) -> VolumeDir.MAX
            Regex(" (down|kam|kum|ghatao|ghata|decrease|low|lower|dheere|dheema|reduce) ").containsMatchIn(s) -> VolumeDir.DOWN
            else -> VolumeDir.UP
        }
        return Command.Volume(dir)
    }

    private fun parseGlobal(s: String): Command? {
        val act = when {
            Regex(" (screenshot|ss) ").containsMatchIn(s) -> GlobalAct.SCREENSHOT
            Regex(" lock ").containsMatchIn(s) -> GlobalAct.LOCK
            Regex(" (notification|notifications) ").containsMatchIn(s) -> GlobalAct.NOTIFICATIONS
            Regex(" (go|jao|chalo) home | home (screen|pe|par|jao|button) ").containsMatchIn(s) -> GlobalAct.HOME
            Regex(" go back | (back|peeche|piche|wapas|vapas) (jao|chalo|ja) ").containsMatchIn(s) -> GlobalAct.BACK
            else -> return null
        }
        return Command.Global(act)
    }

    // ---------- YouTube play ----------
    private fun parsePlay(s: String): Command? {
        if (!Regex(" (play|chalao|chala do|bajao|baja do|lagao|laga do|youtube) ").containsMatchIn(s)) return null
        val query = strip(s, PLAY_FILLERS)
        return if (query.isBlank()) Command.OpenApp("youtube") else Command.PlayYouTube(query)
    }

    // ---------- Open any app ----------
    private fun parseOpen(s: String): Command? {
        if (!Regex(" (open|kholo|khol do|launch|start|chalu karo) ").containsMatchIn(s)) return null
        val app = strip(s, OPEN_FILLERS)
        return if (app.isNotBlank()) Command.OpenApp(app) else null
    }

    private fun strip(text: String, fillers: Set<String>): String =
        text.trim().split(" ").filter { it.isNotBlank() && it !in fillers }.joinToString(" ")

    private fun edgeStrip(words: List<String>): String {
        var a = 0
        var b = words.size
        while (a < b && words[a] in EDGE_FILLERS) a++
        while (b > a && words[b - 1] in EDGE_FILLERS) b--
        return words.subList(a, b).joinToString(" ")
    }
}
