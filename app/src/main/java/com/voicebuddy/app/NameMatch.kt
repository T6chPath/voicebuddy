package com.voicebuddy.app

/**
 * Forgiving name matching, shared by contacts and app names.
 * Speech and spelling often differ: "pradhaman" vs "Pradhuman", "atharav" vs "Atharv",
 * "sooraj" vs "Suraj", "insta" vs "Instagram". Pure Kotlin, covered by unit tests.
 */
object NameMatch {

    /** Lowercase Roman letters only; Hindi-saved names ("सूरज") are turned into Roman ("suraj") first. */
    fun clean(s: String): String =
        Translit.toRoman(s).lowercase().replace(Regex("[^a-z0-9 ]"), " ").replace(Regex("\\s+"), " ").trim()

    /** Little words that can sneak into a spoken name ("suraj singh by", "papa ji ko"). */
    private val STOP = setOf("by", "to", "ko", "se", "ke", "ka", "ki", "the", "a", "on", "from", "via", "sim", "number")

    /** Sound skeleton: first letter + consonants, vowels/h/y dropped, repeats merged. "pradhaman" -> "prdmn". */
    fun skeleton(w: String): String {
        if (w.isEmpty()) return w
        val rest = w.drop(1).filter { it !in "aeiouyh" }
        return Regex("(.)\\1+").replace(w.first() + rest, "$1")
    }

    /** Edit distance (insert / delete / replace one letter = 1). */
    fun distance(a: String, b: String): Int {
        val dp = IntArray(b.length + 1) { it }
        for (i in 1..a.length) {
            var prev = dp[0]
            dp[0] = i
            for (j in 1..b.length) {
                val tmp = dp[j]
                dp[j] = minOf(dp[j] + 1, dp[j - 1] + 1, prev + if (a[i - 1] == b[j - 1]) 0 else 1)
                prev = tmp
            }
        }
        return dp[b.length]
    }

    /** How well one spoken word matches one saved word (0 = no match, 4 = exact). */
    fun wordScore(w: String, cw: String): Int = when {
        w == cw -> 4
        w.length >= 3 && cw.startsWith(w) -> 3
        w.length >= 3 && cw.length >= 3 && skeleton(w) == skeleton(cw) -> 3
        w.length >= 4 && distance(w, cw) <= 1 -> 2
        w.length >= 6 && distance(w, cw) <= 2 -> 1
        else -> 0
    }

    /** Score of a spoken name against a saved name. Every spoken word must match some saved word. */
    fun score(wantedRaw: String, savedRaw: String): Int {
        val wanted = clean(wantedRaw)
        val saved = clean(savedRaw)
        if (wanted.isEmpty() || saved.isEmpty()) return 0
        if (wanted == saved) return 10
        val joinedWanted = wanted.replace(" ", "")
        val joinedSaved = saved.replace(" ", "")
        if (joinedWanted == joinedSaved) return 9
        val savedWords = saved.split(" ")
        val wantedWords = wanted.split(" ").filter { it !in STOP || savedWords.contains(it) }
            .ifEmpty { wanted.split(" ") }
        val perWord = wantedWords.map { w -> savedWords.maxOf { cw -> wordScore(w, cw) } }
        val worst = perWord.minOrNull() ?: 0
        if (worst == 0) {
            // whole-string fallback, e.g. "whatsapp business" vs "WhatsApp Business" spacing, "insta gram"
            return when {
                joinedSaved.startsWith(joinedWanted) && joinedWanted.length >= 4 -> 2
                joinedWanted.length >= 5 && distance(joinedWanted, joinedSaved) <= 1 -> 2
                else -> 0
            }
        }
        return worst + if (wantedWords.size == savedWords.size) 1 else 0
    }

    /** The best-matching item, or null when nothing matches at least [minScore]. */
    fun <T> best(wanted: String, items: List<T>, minScore: Int = 1, label: (T) -> String): T? {
        var best: T? = null
        var bestScore = minScore - 1
        for (item in items) {
            val s = score(wanted, label(item))
            if (s > bestScore) {
                bestScore = s
                best = item
            }
        }
        return best
    }
}
