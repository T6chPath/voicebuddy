package com.voicebuddy.app

import android.content.Context
import android.provider.ContactsContract

data class Contact(val id: Long, val name: String, val phone: String?)

/** Finds a contact by a spoken name, understanding family words like papa / mummy. */
class ContactFinder(private val context: Context) {

    /** Country code added to 10-digit numbers saved without one (India = 91). */
    private val defaultCountryCode = "91"

    private val aliases: Map<String, List<String>> = mapOf(
        "papa" to listOf("papa", "pappa", "papaji", "papa ji", "dad", "daddy", "father", "pitaji", "abbu", "baba"),
        "mummy" to listOf("mummy", "mumma", "mumy", "mom", "mommy", "mother", "maa", "mammi", "ammi", "mataji"),
        "bhai" to listOf("bhai", "bhaiya", "brother", "bro", "veer", "veerji"),
        "didi" to listOf("didi", "sister", "di", "behen", "sis"),
        "dada" to listOf("dada", "dadaji", "grandfather", "grandpa"),
        "dadi" to listOf("dadi", "dadiji", "grandmother", "grandma"),
        "chacha" to listOf("chacha", "chachu", "chachaji", "uncle"),
        "wife" to listOf("wife", "biwi", "patni", "jaan"),
        "husband" to listOf("husband", "pati", "hubby")
    )

    private fun spellingsFor(spoken: String): List<String> {
        val s = spoken.lowercase().trim()
        val group = aliases.values.firstOrNull { list -> list.contains(s) }
        return group ?: listOf(s)
    }

    fun find(spokenName: String): Contact? {
        val wanted = spellingsFor(spokenName)
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
                val n = name.lowercase().replace(Regex("[^a-z0-9 ]"), " ").replace(Regex("\\s+"), " ").trim()
                val words = n.split(" ")
                val score = wanted.maxOf { w ->
                    when {
                        n == w -> 4
                        words.contains(w) || n.startsWith("$w ") -> 3
                        n.startsWith(w) -> 2
                        n.contains(w) -> 1
                        else -> 0
                    }
                }
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
        val prefix = if (packageName == "com.whatsapp.w4b") "vnd.android.cursor.item/vnd.com.whatsapp.w4b"
        else "vnd.android.cursor.item/vnd.com.whatsapp"
        val mime = if (video) "$prefix.video.call" else "$prefix.voip.call"
        context.contentResolver.query(
            ContactsContract.Data.CONTENT_URI,
            arrayOf(ContactsContract.Data._ID),
            "${ContactsContract.Data.CONTACT_ID} = ? AND ${ContactsContract.Data.MIMETYPE} = ?",
            arrayOf(contactId.toString(), mime), null
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
