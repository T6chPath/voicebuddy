package com.voicebuddy.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class NameMatchTest {

    private val contacts = listOf("Pradhuman Singh", "Pradeep Kumar", "Prakash", "Atharv Sharma",
        "Suraj Bhai", "Rahul", "Dad")

    private fun pick(spoken: String) = NameMatch.best(spoken, contacts) { it }

    @Test fun forgivesSpelling() {
        assertEquals("Pradhuman Singh", pick("pradhaman"))
        assertEquals("Atharv Sharma", pick("atharav"))
        assertEquals("Suraj Bhai", pick("sooraj"))
        assertEquals("Rahul", pick("raahul"))
        assertEquals("Pradeep Kumar", pick("pradeep"))
    }

    @Test fun appNames() {
        val apps = listOf("WhatsApp", "Instagram", "ChatGPT", "Google Chrome", "Gmail", "YouTube")
        assertEquals("Instagram", NameMatch.best("insta", apps) { it })
        assertEquals("ChatGPT", NameMatch.best("chatgpt", apps) { it })
        assertEquals("WhatsApp", NameMatch.best("watsapp", apps) { it })
        assertEquals("Google Chrome", NameMatch.best("chrome", apps) { it })
    }

    @Test fun skeleton() {
        assertEquals(NameMatch.skeleton("pradhaman"), NameMatch.skeleton("pradhuman"))
        assertTrue(NameMatch.distance("chartgpt", "chatgpt") == 1)
    }

    @Test fun extraWordsAndHindi() {
        assertEquals("Suraj Bhai", NameMatch.best("suraj by", contacts) { it })
        assertEquals("Pradhuman Singh", NameMatch.best("pradyumn", contacts) { it })
        assertEquals("Pradhuman Singh", NameMatch.best("pradhuman singh", contacts) { it })
        val hindiSaved = listOf("सूरज सिंह", "पापा", "राहुल")
        assertEquals("सूरज सिंह", NameMatch.best("suraj singh", hindiSaved) { it })
        assertEquals("पापा", NameMatch.best("papa", hindiSaved) { it })
    }

    @Test fun translit() {
        assertEquals("suraj sinh ko sim 1 se kol karo", Translit.toRoman("सूरज सिंह को सिम 1 से कॉल करो"))
        assertEquals("papa", Translit.toRoman("पापा"))
        assertEquals("band", Translit.toRoman("बंद"))
        assertEquals("torch", Translit.toRoman("टॉर्च"))
        assertEquals("kesariya", Translit.toRoman("केसरिया"))
    }
}
