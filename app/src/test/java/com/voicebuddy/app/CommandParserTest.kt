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

    @Test fun systemControls() {
        check("phone silent karo", Command.System(SysAct.SILENT, true))
        check("silent mode on karo", Command.System(SysAct.SILENT, true))
        check("vibrate mode on karo", Command.System(SysAct.VIBRATE, true))
        check("ring mode on karo", Command.System(SysAct.RING, true))
        check("do not disturb on karo", Command.System(SysAct.DND, true))
        check("dnd band karo", Command.System(SysAct.DND, false))
        check("battery saver on karo", Command.System(SysAct.BATTERY_SAVER, true))
        check("power saving off karo", Command.System(SysAct.BATTERY_SAVER, false))
        check("auto brightness on karo", Command.System(SysAct.AUTO_BRIGHTNESS, true))
        check("eye comfort on karo", Command.System(SysAct.READING_MODE, true))
        check("reading mode band karo", Command.System(SysAct.READING_MODE, false))
        check("screen record karo", Command.System(SysAct.SCREEN_RECORD, true))
        check("screen recording stop karo", Command.System(SysAct.SCREEN_RECORD, false))
    }

    @Test fun openSettings() {
        check("display settings kholo", Command.OpenSetting("DISPLAY", "Display"))
        check("storage kholo", Command.OpenSetting("STORAGE", "Storage"))
        check("about phone", Command.OpenSetting("ABOUT", "About phone"))
        check("developer options kholo", Command.OpenSetting("DEVELOPER", "Developer options"))
        check("data usage dikhao", Command.OpenSetting("DATA_USAGE", "Data usage"))
        check("fingerprint setting kholo", Command.OpenSetting("FINGERPRINT", "Fingerprint"))
        check("screen timeout kholo", Command.OpenSetting("SCREEN_TIMEOUT", "Screen timeout"))
        check("font size kholo", Command.OpenSetting("FONT", "Font size"))
        check("vpn setting kholo", Command.OpenSetting("VPN", "VPN"))
        check("security settings kholo", Command.OpenSetting("SECURITY", "Security"))
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
        check("youtube me dilbar-dilbar song chlao", Command.PlayYouTube("dilbar dilbar"))
        check("youtube pe dilbar dilbar gaana sunao", Command.PlayYouTube("dilbar dilbar"))
        check("youtube pe dilbar dilbar chalaiye", Command.PlayYouTube("dilbar dilbar"))
        check("dilbar dilbar suna do", Command.PlayYouTube("dilbar dilbar"))
        check("dilbar dilbar song play karo", Command.PlayYouTube("dilbar dilbar"))
        check("youtube me dilbar dilbar laga do", Command.PlayYouTube("dilbar dilbar"))
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

    @Test fun spellingMistakes() {
        check("chart gpt se pucho india ka capital kya hai", Command.SearchIn(SearchApp.CHATGPT, "india ka capital kya hai"))
        check("chat gbd se pucho aaj kya date hai", Command.SearchIn(SearchApp.CHATGPT, "aaj kya date hai"))
        check("blutooth on karo", Command.Toggle(Setting.BLUETOOTH, true))
        check("open insta gram", Command.OpenApp("instagram"))
        check("watsapp kholo", Command.OpenApp("whatsapp"))
        check("pradhaman ko message bhejo ki aa jao", Command.WhatsAppMessage("pradhaman", "aa jao"))
    }

    @Test fun email() {
        check("suraj ko email bhejo ki kal meeting hai", Command.Email("suraj", "", "kal meeting hai"))
        check("send email to atharav subject project saying please send the file",
            Command.Email("atharav", "project", "please send the file"))
        check("papa ko mail karo subject leave ki main kal nahi aaunga",
            Command.Email("papa", "leave", "main kal nahi aaunga"))
        check("gmail kholo", Command.OpenApp("gmail"))
    }

    @Test fun insideApps() {
        check("send pe tap karo", Command.TapOn("send"))
        check("tap on search", Command.TapOn("search"))
        check("click on the follow button", Command.TapOn("follow"))
        check("like dabao", Command.TapOn("like"))
        check("scroll down", Command.Scroll(true))
        check("upar scroll karo", Command.Scroll(false))
        check("type hello how are you", Command.TypeText("hello how are you"))
        check("Type Hello Rahul", Command.TypeText("Hello Rahul"))
        check("instagram pe search karo virat kohli", Command.AppSearch("instagram", "virat kohli", "virat kohli"))
        check("amazon pe iphone 15 dhundo", Command.AppSearch("amazon", "iphone 15", "iphone 15"))
        check("search weather in amritsar", Command.AppSearch("amritsar", "weather", "weather in amritsar"))
    }

    @Test fun callsWithSimEveryWay() {
        check("call to suraj singh by sim 1", Command.PhoneCall("suraj singh", 1))
        check("call pradhuman singh by sim 2", Command.PhoneCall("pradhuman singh", 2))
        check("call karo suraj singh ko sim 1 se", Command.PhoneCall("suraj singh", 1))
        check("call karo suraj singh ko sim 2 se", Command.PhoneCall("suraj singh", 2))
        check("suraj singh ko sim 2 se call karo", Command.PhoneCall("suraj singh", 2))
        check("make a call to suraj singh using sim one", Command.PhoneCall("suraj singh", 1))
        check("call suraj singh via second sim", Command.PhoneCall("suraj singh", 2))
        check("suraj singh ko pehli sim se phone lagao", Command.PhoneCall("suraj singh", 1))
        check("suraj singh ko sim number 2 se call karo", Command.PhoneCall("suraj singh", 2))
        check("Call Suraj Singh by SIM-1", Command.PhoneCall("suraj singh", 1))
        check("call suraj singh from sim1", Command.PhoneCall("suraj singh", 1))
        check("call pradhuman singh by seem 2", Command.PhoneCall("pradhuman singh", 2))
        check("call suraj singh from jio", Command.PhoneCall("suraj singh", null, "jio"))
        check("airtel se papa ko call karo", Command.PhoneCall("papa", null, "airtel"))
        check("call suraj singh", Command.PhoneCall("suraj singh", null))
        check("video call to suraj singh", Command.WhatsAppCall("suraj singh", true))
        check("suraj singh ko whatsapp pe audio call karo", Command.WhatsAppCall("suraj singh", false))
    }

    @Test fun hindiLetters() {
        check("सूरज सिंह को सिम 1 से कॉल करो", Command.PhoneCall("suraj sinh", 1))
        check("प्रद्युम्न को सिम दो से कॉल करो", Command.PhoneCall("pradyumn", 2))
        check("पापा को व्हाट्सएप वीडियो कॉल करो", Command.WhatsAppCall("papa", true))
        check("प्रद्युम्न को मैसेज भेजो कि कल मिलते हैं", Command.WhatsAppMessage("pradyumn", "kal milate hain"))
        check("यूट्यूब पे केसरिया चलाओ", Command.PlayYouTube("kesariya"))
        check("टॉर्च ऑन करो", Command.Torch(true))
        check("वाईफाई बंद करो", Command.Toggle(Setting.WIFI, false))
    }
}
