# Work Bell Plus (Android)

Reminder app by Suraj Singh. Every **Work**, **Reminder** and **Special Occasion** can either

- **🔊 Speak** – says it out loud at its time, like Work Bell for PC
  ("Suraj, it is time for Study maths." / "Suraj, today is Mom's birthday."), or
- **💬 Send SMS** – sends a text from your default SIM at its time.

Both work with the app closed or the phone locked.

## How the APK is made

This branch (`workbell-plus` in the voicebuddy repo) is separate from VoiceBuddy's code.
Every push builds the app on GitHub and saves an **unsigned** APK in `dist/`.
It is then signed with the Work Bell Plus key, which is kept private and is never uploaded,
so the final APK installs over earlier Work Bell Plus versions and keeps your saved items.

## How it is built

- `app/src/main/assets/index.html` – the screen (HTML/CSS/JS)
- `app/src/main/java/app/workbell/plus/` – Android code
  - `AlarmReceiver` – runs at the scheduled time: speaks or sends the SMS
  - `SpeakService` – Android text-to-speech (3 times, 3-second pauses, alarm volume)
  - `Store` – saved schedules and exact alarms
  - `SmsGuard` – background mode that keeps alarms on time
  - `Bridge` – functions the page calls (`OccasionNative.*` / `ContactNative.*`)
- `.github/workflows/build.yml` – builds the APK on GitHub
