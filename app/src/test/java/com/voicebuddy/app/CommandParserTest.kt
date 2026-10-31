package com.voicebuddy.app

import org.junit.Assert.assertEquals
import org.junit.Test

class CommandParserTest {

    private fun check(input: String, expected: Command) =
        assertEquals("input: \"$input\"", expected, CommandParser.parse(input))

    @Test fun torch() {
        check("turn on light", Command.Torch(true))
        check("torch band karo", Command.Torch(false))
        check("flashlight on karo", Command.Torch(true))
        check("turn off the flash light", Command.Torch(false))
    }

    @Test fun toggles() {
        check("turn on wifi", Command.Toggle(Setting.WIFI, true))
        check("wifi band karo", Command.Toggle(Setting.WIFI, false))
        check("Wi-Fi off", Command.Toggle(Setting.WIFI, false))
        check("mobile data on karo", Command.Toggle(Setting.MOBILE_DATA, true))
        check("internet band karo", Command.Toggle(Setting.MOBILE_DATA, false))
        check("bluetooth chalu karo", Command.Toggle(Setting.BLUETOOTH, true))
        check("turn off bluetooth", Command.Toggle(Setting.BLUETOOTH, false))
        check("hotspot on karo", Command.Toggle(Setting.HOTSPOT, true))
        check("location on karo", Command.Toggle(Setting.LOCATION, true))
        check("flight mode on karo", Command.Toggle(Setting.AIRPLANE, true))
    }

    @Test fun messages() {
        check("suraj ko message bhejo ki kal milte hain", Command.WhatsAppMessage("suraj", "kal milte hain"))
        check("send message to atharav saying happy birthday", Command.WhatsAppMessage("atharav", "happy birthday"))
        check("atharav ko whatsapp karo ki main aa raha hoon", Command.WhatsAppMessage("atharav", "main aa raha hoon"))
        check("papa ko message karo main ghar aa raha hoon", Command.WhatsAppMessage("papa", "main ghar aa raha hoon"))
        check("WhatsApp papa ko message bhejo ki mujhe call karna", Command.WhatsAppMessage("papa", "mujhe call karna"))
    }

    @Test fun youtube() {
        check("youtube pe kesariya chalao", Command.PlayYouTube("kesariya"))
        check("play Kesariya song on YouTube", Command.PlayYouTube("kesariya"))
        check("play tum hi ho", Command.PlayYouTube("tum hi ho"))
        check("arijit singh ke gaane bajao", Command.PlayYouTube("arijit singh"))
        check("youtube pe search karo funny videos", Command.SearchIn(SearchApp.YOUTUBE, "funny videos"))
    }

    @Test fun searchInApps() {
        check("chatgpt se pucho bharat ki rajdhani kya hai", Command.SearchIn(SearchApp.CHATGPT, "bharat ki rajdhani kya hai"))
        check("ask chat gpt how to make tea", Command.SearchIn(SearchApp.CHATGPT, "how to make tea"))
        check("ask claude what is quantum computing", Command.SearchIn(SearchApp.CLAUDE, "what is quantum computing"))
        check("gemini pe search karo best phones under 20000", Command.SearchIn(SearchApp.GEMINI, "best phones under 20000"))
        check("google pe search karo weather today", Command.SearchIn(SearchApp.GOOGLE, "weather today"))
        check("search cricket score on chrome", Command.SearchIn(SearchApp.CHROME, "cricket score"))
        check("search weather amritsar", Command.SearchIn(SearchApp.GOOGLE, "weather amritsar"))
    }

    @Test fun calls() {
        check("papa ko sim 2 se call karo", Command.PhoneCall("papa", 2))
        check("call suraj from sim 1", Command.PhoneCall("suraj", 1))
        check("mummy ko dusri sim se call karo", Command.PhoneCall("mummy", 2))
        check("mummy ko call karo", Command.PhoneCall("mummy", null))
        check("papa ko whatsapp video call karo", Command.WhatsAppCall("papa", true))
        check("video call papa on WhatsApp", Command.WhatsAppCall("papa", true))
        check("atharav ko whatsapp audio call karo", Command.WhatsAppCall("atharav", false))
        check("open whatsapp call video call to papa", Command.WhatsAppCall("papa", true))
    }

    @Test fun phoneControls() {
        check("volume badhao", Command.Volume(VolumeDir.UP))
        check("awaaz kam karo", Command.Volume(VolumeDir.DOWN))
        check("volume full karo", Command.Volume(VolumeDir.MAX))
        check("volume mute karo", Command.Volume(VolumeDir.MUTE))
        check("take a screenshot", Command.Global(GlobalAct.SCREENSHOT))
        check("phone lock karo", Command.Global(GlobalAct.LOCK))
    }

    @Test fun openApps() {
        check("open instagram", Command.OpenApp("instagram"))
        check("instagram kholo", Command.OpenApp("instagram"))
        check("chrome kholo", Command.OpenApp("chrome"))
        check("youtube kholo", Command.OpenApp("youtube"))
    }
}
