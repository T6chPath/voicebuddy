package com.voicebuddy.app

enum class Setting(val spoken: String) {
    WIFI("Wi-Fi"), MOBILE_DATA("Mobile data"), BLUETOOTH("Bluetooth"),
    HOTSPOT("Hotspot"), LOCATION("Location"), AIRPLANE("Airplane mode")
}

enum class VolumeDir { UP, DOWN, MUTE, MAX }

enum class GlobalAct { SCREENSHOT, LOCK, HOME, BACK, NOTIFICATIONS }

/** Other phone controls: silent/vibrate/ring, DND, battery saver, auto brightness, reading mode, screen record. */
enum class SysAct(val spoken: String) {
    SILENT("Silent mode"), VIBRATE("Vibrate mode"), RING("Ring mode"),
    DND("Do Not Disturb"), BATTERY_SAVER("Battery saver"), AUTO_BRIGHTNESS("Auto brightness"),
    READING_MODE("Reading mode"), SCREEN_RECORD("Screen recording")
}

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
    /** Phone controls that aren't the Toggle set (DND, battery saver, silent, auto brightness…). */
    data class System(val action: SysAct, val on: Boolean) : Command()
    /** Jump straight to a settings screen ("display settings kholo", "storage dikhao"). */
    data class OpenSetting(val key: String, val label: String) : Command()
    /** Press a button by name in whatever app is open ("like karo", "download", "share karo"). */
    data class DoInApp(val target: String, val heard: String) : Command()
    /** Any other WhatsApp job (voice note, reply, status, channels, settings…), see [WhatsAppParser]. */
    data class WhatsApp(
        val action: WaAction, val name: String = "", val text: String = "", val extra: String = "",
        val split: Boolean = false
    ) : Command()
    /** Ask the offline AI model ("brain se pucho …", "ask brain …"); see [Brain]. */
    data class AskBrain(val question: String) : Command()
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
        "sim card" to "sim", "g mail" to "gmail", "e mail" to "email", "insta gram" to "instagram", "suna do" to "bajao", "play karo" to "play", "play kar do" to "play", "auto tap" to "autotap", "otto tap" to "autotap", "auto tab" to "autotap",
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
        "ple" to "play", "plae" to "play", "pley" to "play",
        "chlao" to "chalao", "chalaao" to "chalao", "chalaiye" to "chalao", "chalaaiye" to "chalao", "chalado" to "chalao",
        "chalaye" to "chalao", "chalaa" to "chalao", "chalav" to "chalao", "chalau" to "chalao",
        "bajaiye" to "bajao", "bajaao" to "bajao", "bajado" to "bajao", "bjao" to "bajao",
        "sunao" to "bajao", "sunaiye" to "bajao", "sunaao" to "bajao", "sunado" to "bajao",
        "lagaiye" to "lagao", "lgao" to "lagao", "gaanaa" to "gaana", "gana" to "gaana", "geet" to "gaana", "taip" to "type", "klik" to "click", "skrol" to "scroll", "instagrama" to "instagram"
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
        parseBrain(raw)?.let { return it }
        val s = normalize(raw)
        if (s.isBlank()) return Command.Unknown(raw)

        parseTap(s)?.let { return it }
        parseScroll(s)?.let { return it }
        parseType(s, raw)?.let { return it }
        WhatsAppParser.parse(s)?.let { return it }
        parseEmail(s)?.let { return it }
        parseMessage(s)?.let { return it }
        parseSearch(s)?.let { return it }
        parseSystem(s)?.let { return it }
        parseOpenSetting(s)?.let { return it }
        parseCall(s)?.let { return it }
        if (!MEDIA_WORDS.containsMatchIn(s)) {
            parseTorch(s)?.let { return it }
            parseToggle(s)?.let { return it }
            parseVolume(s)?.let { return it }
            parseGlobal(s)?.let { return it }
        }
        parsePlay(s)?.let { return it }
        parseOpen(s)?.let { return it }
        parseDoInApp(s)?.let { return it }
        return Command.Unknown(raw)
    }

    // ---------- Offline AI ("brain se pucho …") ----------
    private const val BRAIN = "(?:mini ?brain|brain|bren|brane|brein|dimag|dimaag)"
    private const val BRAIN_OR_APP = "(?:mini ?brain|brain|bren|brane|brein|dimag|dimaag|zenvqo|zenvo|zenvko|offline ai|offline)"
    private const val TO = "(?:se|ko|pe|par|mein|me|from)"
    private const val ASK = "(?:pucho|poocho|puchho|poochho|puchiye|poochiye|ask|batao|bataiye|bata|bolo)"
    private val BRAIN_PATTERNS = listOf(
        // "brain se pucho X", "zenvqo se pucho X", "offline ai batao X", "brain, what is gravity"
        Regex("^(?:hey |ok |hi )?$BRAIN_OR_APP(?: $TO)? $ASK[ ,:]+(.+)$"),
        Regex("^(?:hey |ok |hi )?$BRAIN[ ,:]+(.+)$"),
        // "ask brain X", "ask the offline ai X", "tell brain X"
        Regex("^(?:ask|tell) (?:the )?$BRAIN_OR_APP[ ,:]+(.+)$"),
        // "X brain se pucho", "X zenvqo se puchiye"
        Regex("^(.+?) $BRAIN_OR_APP $TO $ASK$")
    )

    private fun parseBrain(raw: String): Command? {
        val s = Translit.toRoman(raw).lowercase().replace(Regex("[?!.]+"), " ").replace(Regex("\\s+"), " ").trim()
        for (r in BRAIN_PATTERNS) {
            val m = r.find(s) ?: continue
            val q = m.groupValues[1].trim().removePrefix("ki ").removePrefix("that ").trim()
            if (q.isNotBlank()) return Command.AskBrain(q)
        }
        return null
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

    // ---------- Other phone controls ----------
    private fun parseSystem(s: String): Command? {
        val off = OFF_WORDS.containsMatchIn(s)
        return when {
            Regex(" (screen record|screen recording|record screen|screen recorder|screenrecord|recording start|start recording) ").containsMatchIn(s) ->
                Command.System(SysAct.SCREEN_RECORD, on = !Regex(" (stop|band|bandh|rukao|roko|end) ").containsMatchIn(s))
            Regex(" (dnd|do not disturb|not disturb|disturb mode|silent hours) ").containsMatchIn(s) ->
                Command.System(SysAct.DND, on = !off)
            Regex(" (battery saver|battery saving|power saving|power saver|save power|saver mode|super power saving) ").containsMatchIn(s) ->
                Command.System(SysAct.BATTERY_SAVER, on = !off)
            Regex(" (auto brightness|automatic brightness|adaptive brightness|brightness auto|auto bright) ").containsMatchIn(s) ->
                Command.System(SysAct.AUTO_BRIGHTNESS, on = !off)
            Regex(" (reading mode|eye comfort|eye care|eye protection|night light|blue light|eye protect) ").containsMatchIn(s) ->
                Command.System(SysAct.READING_MODE, on = !off)
            Regex(" (vibrate|vibration|vibrate mode|vibrate only|vibrate on) ").containsMatchIn(s) ->
                Command.System(SysAct.VIBRATE, on = true)
            Regex(" (silent mode|silent|phone silent|phone mute|mute phone|chup mode|chupchap|do silent) ").containsMatchIn(s) ->
                Command.System(SysAct.SILENT, on = true)
            Regex(" (ring mode|ringer mode|general mode|normal mode|sound mode|ringer on|sound on karo) ").containsMatchIn(s) ->
                Command.System(SysAct.RING, on = true)
            else -> null
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

    // ---------- Jump to a settings screen ----------
    /** key -> words that mean it. First match wins, so put the more specific ones first. */
    private val SETTING_WORDS: List<Triple<String, String, Regex>> = listOf(
        Triple("DATA_USAGE", "Data usage", Regex(" (data usage|data use|net usage|internet usage|data kharch) ")),
        Triple("SIM", "SIM cards", Regex(" (sim card|sim cards|sim settings?|manage sim|dual sim) ")),
        Triple("VPN", "VPN", Regex(" vpn ")),
        Triple("PRIVATE_DNS", "Private DNS", Regex(" (private dns|dns) ")),
        Triple("NFC", "NFC", Regex(" nfc ")),
        Triple("CAST", "Cast", Regex(" (cast|screen cast|screencast|miracast) ")),
        Triple("DEFAULT_APPS", "Default apps", Regex(" (default app|default apps|default application) ")),
        Triple("APP_PERMISSIONS", "App permissions", Regex(" (app permission|app permissions|permission manager|permissions manager) ")),
        Triple("APPS", "Apps", Regex(" (all apps|installed apps|manage apps|app list|app manager|apps settings?|application settings?|application manager) ")),
        Triple("NOTIFICATION", "Notifications", Regex(" (notification settings?|notification settings|app notification|manage notification|notifications settings?) ")),
        Triple("SOUND", "Sound & Vibration", Regex(" (sound settings?|sound and vibration|ringtone|ring tone|alarm sound|call volume|media volume|vibration settings?|haptics|touch sound) ")),
        Triple("ZEN", "Modes", Regex(" (sleep mode|driving mode|focus mode|bedtime mode|zen mode|modes settings?) ")),
        Triple("DARK_MODE", "Dark mode", Regex(" (dark mode|dark theme|night theme|light mode) ")),
        Triple("FONT", "Font size", Regex(" (font size|text size|font settings?|display size) ")),
        Triple("REFRESH", "Refresh rate", Regex(" (refresh rate|screen refresh|120 hz|90 hz|60 hz|hertz) ")),
        Triple("SCREEN_TIMEOUT", "Screen timeout", Regex(" (screen timeout|sleep time|display timeout|screen off time) ")),
        Triple("RESOLUTION", "Screen resolution", Regex(" (screen resolution|display resolution|resolution settings?) ")),
        Triple("BRIGHTNESS", "Brightness", Regex(" (brightness|brightness settings?) ")),
        Triple("DISPLAY", "Display", Regex(" (display settings?|display settings|screen settings?|screen settings) ")),
        Triple("WALLPAPER", "Wallpaper", Regex(" (wallpaper|background photo|home screen photo) ")),
        Triple("AOD", "Always-on display", Regex(" (always on display|always-on display|aod|lock screen settings?|home screen settings?) ")),
        Triple("THEME", "Themes", Regex(" (theme|themes|icon pack|icons settings?) ")),
        Triple("BATTERY", "Battery", Regex(" (battery usage|battery settings?|battery health|adaptive battery|charging settings?|battery dikhao|power usage) ")),
        Triple("STORAGE", "Storage", Regex(" (storage|internal storage|free up space|clear space|memory settings?) ")),
        Triple("SECURITY", "Security", Regex(" (security settings?|screen lock|lock screen password|pin settings?|password settings?|find my device|app security) ")),
        Triple("FINGERPRINT", "Fingerprint", Regex(" (fingerprint|finger print|face unlock|face lock|biometric) ")),
        Triple("PRIVACY", "Privacy", Regex(" (privacy settings?|privacy dashboard|camera access|microphone access|mic access|clipboard access|ads privacy) ")),
        Triple("ACCOUNTS", "Accounts", Regex(" (account settings?|accounts settings?|google account|add account|sync settings?|passwords|passkey|autofill) ")),
        Triple("BACKUP", "Backup & Restore", Regex(" (backup|back up|restore data|transfer data|contacts backup|photos backup) ")),
        Triple("ACCESSIBILITY", "Accessibility", Regex(" (accessibility settings?|accessibility settings|talkback|magnification|captions|hearing aid|color correction|colour correction) ")),
        Triple("LANGUAGE", "Language", Regex(" (language settings?|change language|system language|languages) ")),
        Triple("KEYBOARD", "Keyboard", Regex(" (keyboard settings?|keyboard|input method|typing settings?) ")),
        Triple("GESTURES", "Gestures", Regex(" (gesture settings?|gestures|navigation settings?|navigation bar|button settings?) ")),
        Triple("DATETIME", "Date & time", Regex(" (date and time|date time|time settings?|clock settings?|time zone) ")),
        Triple("RESET", "Reset options", Regex(" (reset option|reset settings?|factory reset|reset phone|erase phone) ")),
        Triple("UPDATE", "System update", Regex(" (system update|software update|phone update|update phone|ota) ")),
        Triple("PARENTAL", "Family & Parental Controls", Regex(" (parental control|family control|screen time|app limit|digital wellbeing|family management) ")),
        Triple("EMERGENCY", "Safety & Emergency", Regex(" (emergency sos|sos|medical information|emergency contact|earthquake alert|safety settings?) ")),
        Triple("DEVELOPER", "Developer options", Regex(" (developer option|developer options|developer settings?|usb debugging|animation scale|animation settings?) ")),
        Triple("ABOUT", "About phone", Regex(" (about phone|phone info|device info|android version|imei|serial number|build number|software information) ")),
        Triple("CONNECTED", "Connected Devices", Regex(" (connected device|pair new device|android auto|quick share|usb settings?) "))
    )

    private fun parseOpenSetting(s: String): Command? {
        // needs to look like a settings request, not an app open of the same word
        val settingish = Regex(" (setting|settings|kholo|khol|open|dikhao|dikha|jao|chalu|dekhna|dekho) ").containsMatchIn(s) ||
            Regex(" (about phone|developer option|data usage|screen timeout|refresh rate|font size|screen resolution|fingerprint|private dns|system update|factory reset) ").containsMatchIn(s)
        if (!settingish) return null
        val hit = SETTING_WORDS.firstOrNull { it.third.containsMatchIn(s) } ?: return null
        return Command.OpenSetting(hit.first, hit.second)
    }

    // ---------- Do anything in the current app (press a button by name) ----------
    private val DO_FILLERS = setOf(
        "karo", "kar", "kardo", "do", "dena", "please", "plz", "isko", "ise", "is", "this", "yeh", "ye",
        "pe", "par", "per", "ko", "app", "me", "mein", "now", "abhi", "zara", "jara", "button", "wala", "wali",
        "option", "icon", "us", "usko", "wala", "dabao", "daba", "dabaiye", "press", "tap", "click", "kijiye",
        "a", "an", "the", "mera", "meri", "apna", "jaldi"
    )
    private val ACTION_CUE = Regex(" (karo|kar do|kardo|kar|do|dabao|daba do|daba|dabaiye|press|tap|click|lagao|laga do|kijiye|kardena|kr do|krdo) ")
    private val QUESTION = Regex(" (kya|kaun|kon|kaha|kahan|kab|kyun|kyu|kitna|kitne|how|what|why|when|where|who|which|matlab|meaning|batao|bataiye|samjhao|define) ")

    private fun parseDoInApp(s: String): Command? {
        if (QUESTION.containsMatchIn(s)) return null
        val core = strip(s, DO_FILLERS).trim()
        if (core.isBlank()) return null
        val words = core.split(" ").filter { it.isNotBlank() }
        if (words.size > 4) return null                         // long phrase -> probably a question -> Google
        val hasCue = ACTION_CUE.containsMatchIn(s)
        val knownVerb = ActionWords.isAction(core) || words.any { ActionWords.isAction(it) }
        if (!hasCue && !knownVerb) return null                   // no "karo"/verb -> not an app action
        return Command.DoInApp(core, s.trim())
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
