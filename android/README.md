# zenvqo chat for Android

A small native Android app (Java, **no third-party libraries**) that shows the standalone zenvqo chat page in a
WebView. The page is `app/src/main/assets/index.html`, built from `frontend/` by `npm run build:standalone`.

- Chats are stored **on the phone** (IndexedDB inside the app).
- **Settings → Connection** points the app at your model server, e.g. `http://192.168.1.20:8080` for llama-server on
  your laptop (start it with `--host 0.0.0.0` so the phone can reach it, and keep both on the same Wi-Fi).
- Works offline with the built-in **Demo (echo)** model.
- File attach uses the Android file picker. Links in answers open in your browser, and the Back button walks back through chats.
- Supports Android 7.0+ (minSdk 24) and targets Android 15 (SDK 35). Edge-to-edge insets and the keyboard are handled.

## Get the APK without installing Android Studio (recommended for a CPU laptop)
1. Push this whole repository to GitHub (e.g. `T6chPath/zenvqo-chat`).
2. Every push runs **Actions → Build zenvqo chat APK** (or start it with Run workflow).
3. When it finishes (about 5–8 min), download `zenvqo-chat.apk` from the **zenvqo chat (latest)** release (or the zenvqo-chat-apk artifact).
4. Copy the APK to your phone, open it, and allow "Install unknown apps" for your file manager when asked.

The debug APK is signed with a throwaway debug key: fine for your own phone. For a release APK you can share, see
"Signing" below.

## Build locally instead
- **Android Studio:** File → Open → this `android/` folder → Build → Build APK(s).
- **Command line** (needs JDK 17+ and the Android SDK command-line tools, with `ANDROID_HOME` set):
  ```bash
  cd frontend && npm install && npm run build:standalone && cd ../android
  ./gradlew assembleDebug            # → app/build/outputs/apk/debug/app-debug.apk
  ```

## Signing a release APK (optional)
The workflow builds a **debug** APK (fine for your own phone). For a release APK to share, create a key once:
```bash
keytool -genkeypair -v -keystore zenvqo-release.jks -alias zenvqo -keyalg RSA -keysize 4096 -validity 10000
```
then build with `ZC_KEYSTORE_PATH`, `ZC_KEYSTORE_PASSWORD`, `ZC_KEY_ALIAS` and `ZC_KEY_PASSWORD` set
(`gradle assembleRelease`), which `app/build.gradle` reads. Keep the `.jks` file and passwords safe and **out of git**.
If you lose them, you can't ship updates that install over the existing app.

## Connecting to your laptop
| Server | Start it with | Address in the app |
|---|---|---|
| llama-server (zenvqo GGUF) | `llama-server -m zenvqo.gguf --host 0.0.0.0 --port 8080` | `http://<laptop-ip>:8080` |
| Ollama | `OLLAMA_HOST=0.0.0.0 OLLAMA_ORIGINS=* ollama serve` | `http://<laptop-ip>:11434` |
| zenvqo vision (Qwen3-VL) | llama-server with `--mmproj …` on another port | add it as the address to use images |

Find the laptop's IP with `ipconfig` (Windows) or `ip addr` (Linux). Plain `http` on your home network is allowed by
`res/xml/network_security_config.xml`. Anyone else on that Wi-Fi could reach the server too, so pass `--api-key` to
llama-server and enter the same key in the app.

## What was and wasn't verified
- **Verified:**
  - The page in the APK is the same file that passed the standalone browser tests: offline demo, saved chats, direct streaming from a llama-server-compatible API, files, and a mobile layout with no sideways scrolling.
  - `MainActivity.java` compiled against stand-in Android API stubs.
- **Not verified:** no Android SDK was available where this was written, so the APK itself has **not been built or run on a device** here. The GitHub workflow is the first real build.
- **What to check on your phone:** if something fails on a specific Android version, it's most likely chats not being saved (IndexedDB) or connecting to the LAN server. Check both first.
