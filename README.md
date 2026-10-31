# VoiceBuddy — Hinglish voice assistant for Android

Bolo, aur phone kaam kar dega:

| You say | What happens |
|---|---|
| "YouTube pe Kesariya chalao" / "Play Kesariya on YouTube" | Opens YouTube, searches, and starts the first video |
| "Papa ko message bhejo ki main aa raha hoon" | Opens Papa's WhatsApp chat and presses Send |
| "Send message to Rahul saying hello" | Same, in English |
| "Papa ko WhatsApp video call karo" / "Video call papa" | Starts a WhatsApp video call |
| "Papa ko WhatsApp call karo" | WhatsApp voice call |
| "Mummy ko call karo" | Normal phone call |
| "Open Instagram" / "Instagram kholo" | Opens any installed app |

"Papa", "mummy", "bhai", "didi" etc. also match contacts saved as Dad, Father, Mom, Mother, Brother…

## Build & install
1. Install **Android Studio** (free).
2. Unzip this folder → Android Studio → **File › Open** → pick the `voicebuddy` folder. Let Gradle sync finish.
3. Phone: Settings › About phone › tap *Build number* 7 times → Developer options › turn on **USB debugging**. Connect with USB.
4. Press the green ▶ **Run** button. The app installs on your phone.
   (Or **Build › Build APK(s)** to get an .apk file to share.)

## No computer setup? Get the APK from GitHub (free)
1. Make a free account at github.com → **New repository** → name it `voicebuddy` → Create.
2. Click **uploading an existing file** → drag in everything *inside* the unzipped `voicebuddy` folder
   (including the `.github` folder; on a phone use a PC browser or "Desktop site") → **Commit changes**.
3. Open the **Actions** tab → wait ~5 minutes for the green tick on "Build APK".
4. Click the run → under **Artifacts** download **VoiceBuddy-apk** → unzip → `app-debug.apk`.
5. Copy the APK to your phone, open it, allow "Install unknown apps", install.

## First-time setup on the phone
1. Open VoiceBuddy → allow **Microphone, Contacts, Phone**.
2. Tap the orange line "Turn on Auto-Tap" → Accessibility → **VoiceBuddy Auto-Tap** → On.
   This is what presses WhatsApp's **Send** button and plays the first **YouTube** video for you.
   Without it, the chat / search still opens, you just tap once yourself.
3. Optional: make it your assistant so long-pressing Home opens it listening:
   Settings › Apps › Default apps › **Digital assistant app** › VoiceBuddy.

## Notes
- Contacts saved without +91 get 91 added automatically (change `defaultCountryCode` in `ContactFinder.kt` for other countries).
- WhatsApp calls work for contacts who are on WhatsApp; if one isn't found, open WhatsApp once so it syncs contacts.
- Speech uses Google's recognizer in Indian English, so Hinglish comes out in Roman letters, which the app understands. Needs internet (or offline speech pack).
- Add new commands in `CommandParser.kt` and their actions in `ActionExecutor.kt`.
