package com.voicebuddy.app

/**
 * Hindi (Devanagari) → Roman letters, so Hindi speech and Hindi-saved contact names are understood:
 * "सूरज सिंह को सिम 1 से कॉल करो" → "suraj sinh ko sim 1 se kol karo".
 * Simple and forgiving rather than perfect; the parser and name matcher correct the rest.
 * Pure Kotlin, covered by unit tests.
 */
object Translit {

    private val consonants = mapOf(
        'क' to "k", 'ख' to "kh", 'ग' to "g", 'घ' to "gh", 'ङ' to "n",
        'च' to "ch", 'छ' to "chh", 'ज' to "j", 'झ' to "jh", 'ञ' to "n",
        'ट' to "t", 'ठ' to "th", 'ड' to "d", 'ढ' to "dh", 'ण' to "n",
        'त' to "t", 'थ' to "th", 'द' to "d", 'ध' to "dh", 'न' to "n",
        'प' to "p", 'फ' to "ph", 'ब' to "b", 'भ' to "bh", 'म' to "m",
        'य' to "y", 'र' to "r", 'ल' to "l", 'व' to "v", 'श' to "sh",
        'ष' to "sh", 'स' to "s", 'ह' to "h", 'ळ' to "l",
        // precomposed nukta letters
        '\u0958' to "q", '\u0959' to "kh", '\u095A' to "g", '\u095B' to "z", '\u095C' to "r",
        '\u095D' to "rh", '\u095E' to "f", '\u095F' to "y"
    )

    /** consonant + nukta (combining ़) */
    private val nukta = mapOf("j" to "z", "ph" to "f", "d" to "r", "dh" to "rh", "k" to "q", "g" to "g", "kh" to "kh")

    private val vowels = mapOf(
        'अ' to "a", 'आ' to "a", 'इ' to "i", 'ई' to "i", 'उ' to "u", 'ऊ' to "u",
        'ऋ' to "ri", 'ए' to "e", 'ऐ' to "ai", 'ओ' to "o", 'औ' to "au", 'ऑ' to "o", 'ऍ' to "e"
    )

    private val matras = mapOf(
        'ा' to "a", 'ि' to "i", 'ी' to "i", 'ु' to "u", 'ू' to "u", 'ृ' to "ri",
        'े' to "e", 'ै' to "ai", 'ो' to "o", 'ौ' to "au", 'ॉ' to "o", 'ॅ' to "e"
    )

    private const val HALANT = '्'
    private const val NUKTA = '़'
    private const val ANUSVARA = 'ं'
    private const val CHANDRABINDU = 'ँ'
    private const val VISARGA = 'ः'

    private fun isDevanagari(c: Char) = c in 'ऀ'..'ॿ'

    fun hasDevanagari(s: String) = s.any { isDevanagari(it) }

    fun toRoman(s: String): String {
        if (!hasDevanagari(s)) return s
        val out = StringBuilder()
        var pendingA = false     // inherent "a" after a consonant, dropped at the end of a word
        var lastConsonant = ""

        for (c in s) {
            when {
                consonants.containsKey(c) -> {
                    if (pendingA) out.append('a')
                    val r = consonants.getValue(c)
                    out.append(r)
                    lastConsonant = r
                    pendingA = true
                }
                c == NUKTA -> {
                    val fixed = nukta[lastConsonant]
                    if (fixed != null && out.endsWith(lastConsonant)) {
                        out.setLength(out.length - lastConsonant.length)
                        out.append(fixed)
                        lastConsonant = fixed
                    }
                }
                matras.containsKey(c) -> {
                    out.append(matras.getValue(c))
                    pendingA = false
                }
                c == HALANT -> pendingA = false
                c == ANUSVARA || c == CHANDRABINDU -> {
                    if (pendingA) out.append('a')
                    out.append('n')
                    pendingA = false
                }
                c == VISARGA -> {
                    if (pendingA) out.append('a')
                    out.append('h')
                    pendingA = false
                }
                vowels.containsKey(c) -> {
                    if (pendingA) out.append('a')
                    out.append(vowels.getValue(c))
                    pendingA = false
                }
                c in '०'..'९' -> {
                    if (pendingA) out.append('a')
                    out.append('0' + (c - '०'))
                    pendingA = false
                }
                isDevanagari(c) -> Unit   // danda and other marks
                else -> {
                    pendingA = false      // end of word: inherent "a" dropped
                    out.append(c)
                }
            }
        }
        return out.toString()
    }
}
