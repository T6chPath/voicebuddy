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

    /**
     * Best contact for a spoken name.
     * [requirePhone] = true for calls/WhatsApp; false for email (contacts saved with only an email).
     */
    fun find(spokenName: String, requirePhone: Boolean = true): Contact? {
        val wanted = spellingsFor(spokenName)
        var best: Contact? = null
        var bestScore = 0

        context.contentResolver.query(
            ContactsContract.Contacts.CONTENT_URI,
            arrayOf(ContactsContract.Contacts._ID, ContactsContract.Contacts.DISPLAY_NAME_PRIMARY),
            if (requirePhone) "${ContactsContract.Contacts.HAS_PHONE_NUMBER} = 1" else null, null, null
        )?.use { c ->
            while (c.moveToNext()) {
                val id = c.getLong(0)
                val name = c.getString(1) ?: continue
                val score = wanted.maxOf { NameMatch.score(it, name) }
                if (score > bestScore) {
                    bestScore = score
                    best = Contact(id, name, null)
                }
            }
        }
        return best?.let { it.copy(phone = phoneFor(it.id)) }
    }

    fun emailFor(contactId: Long): String? {
        context.contentResolver.query(
            ContactsContract.CommonDataKinds.Email.CONTENT_URI,
            arrayOf(ContactsContract.CommonDataKinds.Email.ADDRESS),
            "${ContactsContract.CommonDataKinds.Email.CONTACT_ID} = ?",
            arrayOf(contactId.toString()), null
        )?.use { c ->
            while (c.moveToNext()) {
                val a = c.getString(0)?.trim()
                if (!a.isNullOrEmpty() && a.contains("@")) return a
            }
        }
        return null
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
