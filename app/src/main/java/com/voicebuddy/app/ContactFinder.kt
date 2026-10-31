package com.voicebuddy.app

import android.content.Context
import android.provider.ContactsContract

data class Contact(val id: Long, val name: String, val phone: String?)

/**
 * Finds a contact by a spoken name. Understands family words (papa, mummy…) and
 * forgives small spelling differences between speech and the saved name
 * (Atharav / Atharv, Suraj / Sooraj, Rahul / Raahul).
 */
class ContactFinder(private val context: Context) {

    /** Country code added to 10-digit numbers saved without one (India = 91). */
    private val defaultCountryCode = "91"

    private val aliases: List<List<String>> = listOf(
        listOf("papa", "pappa", "papaji", "dad", "daddy", "father", "pitaji", "abbu", "baba"),
        listOf("mummy", "mumma", "mumy", "mom", "mommy", "mother", "maa", "mammi", "ammi", "mataji"),
        listOf("bhai", "bhaiya", "brother", "bro", "veer", "veerji"),
        listOf("didi", "sister", "di", "behen", "sis"),
        listOf("dada", "dadaji", "grandfather", "grandpa"),
        listOf("dadi", "dadiji", "grandmother", "grandma"),
        listOf("chacha", "chachu", "chachaji", "uncle"),
        listOf("wife", "biwi", "patni", "jaan"),
        listOf("husband", "pati", "hubby")
    )

    private fun spellingsFor(spoken: String): List<String> {
        val s = spoken.lowercase().trim()
        return aliases.firstOrNull { it.contains(s) } ?: listOf(s)
    }

    private fun clean(s: String) =
        s.lowercase().replace(Regex("[^a-z0-9 ]"), " ").replace(Regex("\\s+"), " ").trim()

    /** "atharav" -> "athrv": keeps the sound skeleton so vowel spellings don't matter. */
    private fun skeleton(w: String): String {
        if (w.isEmpty()) return w
        val rest = w.drop(1).filter { it !in "aeiouyh" }
        return Regex("(.)\\1+").replace(w.first() + rest, "$1")
    }

    private fun distance(a: String, b: String): Int {
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

    /** How well one spoken word matches one word of a saved name (0 = no match). */
    private fun wordScore(w: String, cw: String): Int = when {
        w == cw -> 4
        w.length >= 3 && cw.startsWith(w) -> 3
        w.length >= 3 && skeleton(w) == skeleton(cw) -> 3
        w.length >= 4 && distance(w, cw) <= 1 -> 2
        w.length >= 6 && distance(w, cw) <= 2 -> 1
        else -> 0
    }

    private fun nameScore(wanted: String, saved: String): Int {
        if (wanted == saved) return 10
        val savedWords = saved.split(" ")
        val wantedWords = wanted.split(" ").filter { it.isNotBlank() }
        if (wantedWords.isEmpty()) return 0
        // every spoken word must match some word of the saved name; weakest link decides
        val perWord = wantedWords.map { w -> savedWords.maxOf { cw -> wordScore(w, cw) } }
        val worst = perWord.minOrNull() ?: 0
        if (worst == 0) return if (saved.contains(wanted)) 1 else 0
        return worst + if (wantedWords.size == savedWords.size) 1 else 0
    }

    fun find(spokenName: String): Contact? {
        val wanted = spellingsFor(spokenName).map { clean(it) }
        var best: Contact? = null
        var bestScore = 0

        context.contentResolver.query(
            ContactsContract.Contacts.CONTENT_URI,
            arrayOf(ContactsContract.Contacts._ID, ContactsContract.Contacts.DISPLAY_NAME_PRIMARY),
            "${ContactsContract.Contacts.HAS_PHONE_NUMBER} = 1", null, null
        )?.use { c ->
            while (c.moveToNext()) {
                val id = c.getLong(0)
                val name = c.getString(1) ?: continue
                val n = clean(name)
                if (n.isEmpty()) continue
                val score = wanted.maxOf { nameScore(it, n) }
                if (score > bestScore) {
                    bestScore = score
                    best = Contact(id, name, null)
                }
            }
        }
        return best?.let { it.copy(phone = phoneFor(it.id)) }
    }

    /** Splits "papa i am coming" into (contact for "papa", "i am coming") using the longest matching prefix. */
    fun splitNameAndText(words: String): Pair<Contact, String>? {
        val parts = words.trim().split(" ")
        for (n in minOf(3, parts.size - 1) downTo 1) {
            val name = parts.take(n).joinToString(" ")
            val contact = find(name) ?: continue
            return contact to parts.drop(n).joinToString(" ")
        }
        return null
    }

    private fun phoneFor(contactId: Long): String? {
        context.contentResolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            arrayOf(ContactsContract.CommonDataKinds.Phone.NUMBER),
            "${ContactsContract.CommonDataKinds.Phone.CONTACT_ID} = ?",
            arrayOf(contactId.toString()), null
        )?.use { c ->
            if (c.moveToFirst()) return normalize(c.getString(0))
        }
        return null
    }

    /** Digits only, with country code: "098765 43210" -> "919876543210". */
    private fun normalize(raw: String?): String? {
        if (raw == null) return null
        var d = raw.filter { it.isDigit() }
        if (raw.trim().startsWith("00")) d = d.drop(2)
        if (d.length == 11 && d.startsWith("0")) d = d.drop(1)
        if (d.length == 10) d = defaultCountryCode + d
        return d.ifBlank { null }
    }

    /**
     * WhatsApp adds its own rows to each contact for "voice call" and "video call".
     * Returns the row id for the chosen kind, or null if this contact isn't on WhatsApp.
     */
    fun whatsAppCallRow(contactId: Long, video: Boolean, packageName: String): Long? {
        context.contentResolver.query(
            ContactsContract.Data.CONTENT_URI,
            arrayOf(ContactsContract.Data._ID),
            "${ContactsContract.Data.CONTACT_ID} = ? AND ${ContactsContract.Data.MIMETYPE} = ?",
            arrayOf(contactId.toString(), whatsAppCallMime(video, packageName)), null
        )?.use { c ->
            if (c.moveToFirst()) return c.getLong(0)
        }
        return null
    }

    fun whatsAppCallMime(video: Boolean, packageName: String): String {
        val prefix = if (packageName == "com.whatsapp.w4b") "vnd.android.cursor.item/vnd.com.whatsapp.w4b"
        else "vnd.android.cursor.item/vnd.com.whatsapp"
        return if (video) "$prefix.video.call" else "$prefix.voip.call"
    }
}
