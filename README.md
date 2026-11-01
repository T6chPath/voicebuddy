# zenvqo.voice — Hinglish voice assistant for Android

**Download:** https://github.com/T6chPath/voicebuddy/releases/download/latest/app-debug.apk

## What you can say

| Say | What happens |
|---|---|
| "Torch on karo" / "Turn on light" / "Torch band karo" | Flashlight on / off |
| "Wi-Fi on karo" / "Wi-Fi band karo" | Opens the Wi-Fi switch and Auto-Tap flips it |
| "Mobile data on karo" / "Internet band karo" | Same for mobile data |
| "Bluetooth on karo" · "Hotspot on karo" · "Location on karo" · "Flight mode on karo" | Same for each |
| "Volume badhao / kam karo / full karo / mute karo" | Media volume |
| "Screenshot lo" · "Phone lock karo" · "Notifications kholo" | Needs Auto-Tap |
| "Suraj ko message bhejo ki kal milte hain" | WhatsApp message, sent automatically |
| "Send message to Atharav saying happy birthday" | Same, in English |
| "YouTube pe Kesariya chalao" / "Play Kesariya" | Opens YouTube and plays the first video |
| "ChatGPT se pucho Bharat ki rajdhani kya hai" | Asks ChatGPT |
| "Ask Claude …" · "Gemini pe search karo …" | Asks Claude / Gemini |
| "Google pe search karo …" · "Search … on Chrome" | Google / Chrome search |
| "Papa ko SIM 2 se call karo" · "Call Suraj from SIM 1" · "Call to Suraj Singh by SIM 1" · "Suraj Singh ko pehli/dusri sim se phone lagao" · "Call Suraj via second SIM" · "Call Suraj from Jio / Airtel" | Phone call from the chosen SIM |
| "Mummy ko call karo" | Phone call (default SIM) |
| "Atharav ko WhatsApp audio call karo" | WhatsApp voice call |
| "Papa ko WhatsApp video call karo" | WhatsApp video call |
| "Pradhuman ko email bhejo ki kal meeting hai" | Gmail to that contact's saved email, sent automatically |
| "Send email to Atharav subject project saying please send the file" | Gmail with a subject |
| "Instagram pe search karo Virat Kohli" · "Amazon pe iPhone 15 dhundo" | Searches inside that app (Maps, Play Store, Spotify, Amazon, Flipkart open straight on results) |
| Inside any app: "Like dabao" · "Follow pe tap karo" · "Type hello" · "Scroll down" | Presses that button / types / scrolls in the app on screen |
| "Instagram kholo" | Opens any installed app |
| Anything else | Searches it on Google |

**Hindi, Hinglish and English all work.** Choose the speech language in ⚙ Settings (Hinglish · हिंदी · English); Hindi letters are understood too ("सूरज सिंह को सिम 1 से कॉल करो"), and contacts saved in Hindi letters are found.

Spelling mistakes are forgiven: "chart gpt" → ChatGPT, "watsapp" → WhatsApp, "blutooth" → Bluetooth, "insta" → Instagram, "pradhaman" → a contact saved as "Pradhuman", "atharav" → "Atharv", and "papa" finds "Dad" / "Father".

## WhatsApp by voice

Needs **Auto-Tap** on (it does the tapping inside WhatsApp, only right after your command). WhatsApp must be in English.

| Say | What happens |
|---|---|
| "Papa ko voice message bhejo" / "20 second ka voice message" | Holds the mic and records a voice note (video message too) |
| "Papa ke message ka reply karo ki haan aa raha hoon" | Replies (quote-reply) to their last message |
| "Papa ka last message edit karo ki main 5 baje aaunga" | Edits your last message |
| "Papa wala last message delete karo" / "…sabke liye delete karo" | Delete for me / for everyone |
| "Papa ka last message rahul ko forward karo" | Forwards it |
| "Papa ke message pe heart react karo" | Emoji reaction (like, heart, haha, wow, sad, pray) |
| "Rahul ko happy birthday ka gif bhejo" / "…sticker bhejo" | First matching GIF / sticker |
| "Papa ko link bhejo google dot com" | Sends the link |
| "Papa ko rahul ka contact bhejo" / "…ka number bhejo" | Contact card / phone number |
| "Papa ko location bhejo" | Current location |
| "Papa ko resume pdf bhejo" / "project zip bhejo" | Document / PDF / ZIP from WhatsApp's file list |
| "Family group ko poll bhejo kahan chalein options goa aur manali" | Poll |
| "Rahul ko event invite bhejo birthday party" | Event invitation |
| "Papa ko view once photo bhejo" | Your latest photo / video as view once |
| "WhatsApp call history dikhao" / "screen share karo" | Calls tab / share screen + audio in a call |
| "Status lagao ki aaj mera birthday hai" | Text status |
| "Photo status lagao kesariya gaane ke saath" | Latest photo / video / GIF as status, with music or a sticker |
| "Family community mein naya group banao cousins" | New group inside a community |
| "Virat kohli channel follow karo" / "unfollow" / "search" / "create channel zenvqo" | Channels |
| "WhatsApp naam rahul rakho" / "about change karo ki busy hoon" / "dp change karo" | Profile |
| "Rahul ko block karo" / "unblock rahul" | Block / unblock |
| "WhatsApp number change karo" / "account delete karo" | Opens the screen; you finish it yourself (never auto-confirmed) |
| "WhatsApp ki language hindi karo" / "dark mode on karo" / "wallpaper change karo" / "notification band karo" | Settings |

Groups work too: say "group" in the name ("family group ko …") and WhatsApp's own search finds the chat.

## Talk from inside any app
After turning on Auto-Tap, Android offers a **floating zenvqo.voice button** (or a button in the navigation bar). If it doesn't appear: Settings → Accessibility → zenvqo.voice Auto-Tap → turn on **zenvqo.voice Auto-Tap shortcut**. Tap it inside Instagram, YouTube, anything, and say "Like dabao", "Type nice photo", "Send pe tap karo", "Scroll down". zenvqo.voice steps aside and does it in that app.

## Start talking fast
- **Tap the app icon** → home page opens. **Tap once more right away** (within 1.5 s) → it starts listening.
- **Double-tap anywhere** on the home page → it starts listening.
- **"Bolo" icon** (orange, added next to zenvqo.voice in your app list) → opens straight into listening. Drag it to your home screen.
- **Long-press the zenvqo.voice icon → Bolo.**
- **Quick Settings:** swipe down twice → pencil/edit → drag **zenvqo.voice** tile in → tap it to talk.
- **Phone assistant:** Settings → Apps → Default apps → Digital assistant app → zenvqo.voice. Then long-press Home/Power to talk.

## First-time setup
1. Open zenvqo.voice → allow **Microphone, Contacts, Phone** (Phone is needed to pick SIM 1 / SIM 2).
2. Tap **On karo** on the home screen (or just say **"auto tap on karo"**). It opens zenvqo.voice's own switch — turn it on, tap Allow, and the app comes back by itself.
   Auto-Tap presses Send, plays the YouTube video, flips the Wi-Fi/Bluetooth/data switches, does the WhatsApp steps and takes screenshots. It only acts right after your own voice command.
   - **Switch greyed out?** (Android 13+, because the APK isn't from the Play Store) Tap "Switch nahi chal raha": App info → ⋮ → **Allow restricted settings**, then turn it on.
   - **Never do it again (optional):** connect the phone to a computer once and run
     `adb shell pm grant com.voicebuddy.app android.permission.WRITE_SECURE_SETTINGS`.
     After that Auto-Tap turns itself on automatically, even after every update.

## Good to know
- Android doesn't let any app switch Wi-Fi, mobile data or Bluetooth directly, so zenvqo.voice opens the switch and Auto-Tap flips it. On some phone brands the switch screen looks different and you may need to tap it yourself.
- ChatGPT / Claude / Gemini: the question is sent into the app (and copied, so you can paste it if the app needs one tap).
- Speech uses Google's recognizer in Indian English, so Hinglish comes out in Roman letters, which the app understands. Needs internet (or an offline speech pack).

## For developers
- Commands: `app/src/main/java/com/voicebuddy/app/CommandParser.kt` (unit tests in `app/src/test`).
- Actions: `ActionExecutor.kt`. Auto-Tap logic: `AutoTapService.kt`.
- Every push builds and tests the APK on GitHub Actions and publishes it to the `latest` release.

## Contact
zenvqo.voice@gmail.com
