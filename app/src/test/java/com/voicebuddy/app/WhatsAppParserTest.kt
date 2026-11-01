package com.voicebuddy.app

import org.junit.Assert.assertEquals
import org.junit.Test
import com.voicebuddy.app.WaAction.*

class WhatsAppParserTest {

    private fun check(input: String, expected: Command) =
        assertEquals("input: \"$input\"", expected, CommandParser.parse(input))

    private fun wa(a: WaAction, name: String = "", text: String = "", extra: String = "", split: Boolean = false) =
        Command.WhatsApp(a, name, text, extra, split)

    // ---------- 1. Sending to a specific person ----------
    @Test fun voiceAndVideoNotes() {
        check("papa ko voice message bhejo", wa(VOICE_NOTE, "papa", extra = "10"))
        check("send voice note to rahul", wa(VOICE_NOTE, "rahul", extra = "10"))
        check("papa ko 20 second ka voice message bhejo", wa(VOICE_NOTE, "papa", extra = "20"))
        check("mummy ko video message bhejo", wa(VIDEO_NOTE, "mummy", extra = "10"))
    }

    @Test fun editAndDelete() {
        check("papa ko bheja last message edit karo ki main 5 baje aaunga", wa(EDIT_LAST, "papa", "main 5 baje aaunga"))
        check("papa wala last message delete karo", wa(DELETE_LAST, "papa"))
        check("delete last message to rahul", wa(DELETE_LAST, "rahul"))
        check("papa ka last message sabke liye delete karo", wa(DELETE_EVERYONE, "papa"))
        check("delete message for everyone in rahul chat", wa(DELETE_EVERYONE, "rahul"))
    }

    @Test fun replyForwardReact() {
        check("papa ke message ka reply karo ki haan aa raha hoon", wa(REPLY, "papa", "haan aa raha hoon"))
        check("rahul ko reply karo okay bhai", wa(REPLY, "rahul", "okay bhai"))
        check("reply to papa saying ok", wa(REPLY, "papa", "ok"))
        check("papa ka last message rahul ko forward karo", wa(FORWARD, "papa", extra = "rahul"))
        check("forward last message from papa to rahul", wa(FORWARD, "papa", extra = "rahul"))
        check("papa ke message pe heart react karo", wa(REACT, "papa", extra = "heart"))
        check("rahul ke last message pe like karo", wa(REACT, "rahul", extra = "like"))
        check("react haha on rahul message", wa(REACT, "rahul", extra = "laugh"))
    }

    @Test fun gifsAndStickers() {
        check("papa ko happy birthday ka gif bhejo", wa(GIF, "papa", "happy birthday"))
        check("send funny gif to rahul", wa(GIF, "rahul", "funny"))
        check("rahul ko sticker bhejo", wa(STICKER, "rahul", ""))
        check("rahul ko good morning sticker bhejo", wa(STICKER, "rahul", "good morning"))
        check("papa ko animated sticker bhejo", wa(STICKER, "papa", "", "animated"))
    }

    @Test fun linksContactsNumbersLocation() {
        check("papa ko link bhejo google dot com", wa(LINK, "papa", "google.com"))
        check("send link youtube dot com to rahul", wa(LINK, "rahul", "youtube.com"))
        check("papa ko rahul ka contact bhejo", wa(CONTACT_CARD, "papa", extra = "rahul"))
        check("share rahul's contact with papa", wa(CONTACT_CARD, "papa", extra = "rahul"))
        check("papa ko rahul ka number bhejo", wa(SHARE_NUMBER, "papa", extra = "rahul"))
        check("papa ko location bhejo", wa(LOCATION, "papa"))
        check("send my location to rahul", wa(LOCATION, "rahul"))
        check("share location with mummy", wa(LOCATION, "mummy"))
    }

    @Test fun documents() {
        check("papa ko resume pdf bhejo", wa(DOCUMENT, "papa", "resume", "pdf"))
        check("send project zip file to rahul", wa(DOCUMENT, "rahul", "project", "zip"))
        check("rahul ko document bhejo", wa(DOCUMENT, "rahul", "", ""))
    }

    @Test fun pollsAndEvents() {
        check("family group ko poll bhejo kahan chalein options goa aur manali aur shimla",
            wa(POLL, "family group", "kahan chalein", "goa|manali|shimla"))
        check("send poll to rahul asking movie tonight options yes no",
            wa(POLL, "rahul", "movie tonight", "yes|no"))
        check("rahul ko event invite bhejo birthday party", wa(EVENT, "rahul", "birthday party"))
    }

    @Test fun viewOnceAndCalls() {
        check("papa ko view once photo bhejo", wa(VIEW_ONCE_PHOTO, "papa"))
        check("send view once video to rahul", wa(VIEW_ONCE_VIDEO, "rahul"))
        check("whatsapp call history dikhao", wa(CALL_HISTORY))
        check("screen share karo", wa(SHARE_SCREEN))
    }

    // ---------- 2. Status & communities ----------
    @Test fun status() {
        check("whatsapp status lagao ki aaj mera birthday hai", wa(STATUS_TEXT, text = "aaj mera birthday hai"))
        check("good morning status lagao", wa(STATUS_TEXT, text = "good morning"))
        check("status pe likho busy hoon", wa(STATUS_TEXT, text = "busy hoon"))
        check("photo status lagao", wa(STATUS_PHOTO))
        check("upload video status", wa(STATUS_VIDEO))
        check("gif status lagao", wa(STATUS_GIF))
        check("status pe photo lagao kesariya gaane ke saath", wa(STATUS_PHOTO, extra = "kesariya"))
        check("photo status with song tum hi ho", wa(STATUS_PHOTO, extra = "tum hi ho"))
        check("status pe photo lagao heart sticker ke saath", wa(STATUS_PHOTO, text = "heart"))
        check("family community mein naya group banao cousins", wa(COMMUNITY_GROUP, "family", "cousins"))
        check("create group cousins in family community", wa(COMMUNITY_GROUP, "family", "cousins"))
    }

    // ---------- 3. Channels ----------
    @Test fun channels() {
        check("virat kohli channel follow karo", wa(CHANNEL_FOLLOW, "virat kohli"))
        check("unfollow channel aaj tak", wa(CHANNEL_UNFOLLOW, "aaj tak"))
        check("cricket channel search karo", wa(CHANNEL_SEARCH, "cricket"))
        check("create channel zenvqo", wa(CHANNEL_CREATE, "zenvqo"))
        check("youtube channel kholo", Command.PlayYouTube("channel"))
    }

    // ---------- 4. Account ----------
    @Test fun account() {
        check("whatsapp number change karo", wa(CHANGE_NUMBER))
        check("change my whatsapp name to suraj singh", wa(PROFILE_NAME, text = "suraj singh"))
        check("whatsapp naam badal ke rahul karo", wa(PROFILE_NAME, text = "rahul"))
        check("whatsapp dp change karo", wa(PROFILE_PHOTO))
        check("change profile photo", wa(PROFILE_PHOTO))
        check("whatsapp about change karo ki busy hoon", wa(ABOUT, text = "busy hoon"))
        check("rahul ko block karo", wa(BLOCK, "rahul"))
        check("unblock rahul on whatsapp", wa(UNBLOCK, "rahul"))
        check("whatsapp account delete karo", wa(DELETE_ACCOUNT))
    }

    // ---------- 5. Settings ----------
    @Test fun settings() {
        check("whatsapp ki language hindi karo", wa(LANGUAGE, text = "hindi"))
        check("whatsapp notification band karo", wa(NOTIFICATIONS, extra = "off"))
        check("whatsapp dark mode on karo", wa(DARK_MODE))
        check("whatsapp light mode karo", wa(LIGHT_MODE))
        check("whatsapp wallpaper change karo", wa(WALLPAPER, extra = "bright"))
        check("dark wallpaper lagao", wa(WALLPAPER, extra = "dark"))
    }

    @Test fun autoTapSetup() {
        check("auto tap on karo", Command.AutoTapSetup)
        check("Auto-Tap chalu karo", Command.AutoTapSetup)
        check("turn on auto tap", Command.AutoTapSetup)
    }

    // ---------- Old commands still work ----------
    @Test fun noRegressions() {
        check("papa ko message bhejo ki location bhej do", Command.WhatsAppMessage("papa", "location bhej do"))
        check("papa ko whatsapp video call karo", Command.WhatsAppCall("papa", video = true))
        check("location on karo", Command.Toggle(Setting.LOCATION, true))
        check("turn on light", Command.Torch(true))
        check("notifications kholo", Command.Global(GlobalAct.NOTIFICATIONS))
        check("papa ko sim 2 se call karo", Command.PhoneCall("papa", 2))
    }
}
