#!/usr/bin/env bash
# Runs inside the emulator job: install the APK, start it, ask for PDFs, keep logs for the report.
set -u
APK="$1"; OUT="${2:-phone-out}"; mkdir -p "$OUT"
adb wait-for-device
adb logcat -c || true
adb install -r -g "$APK"
adb shell am start -W -n app.zenvqo.chat.debug/app.zenvqo.chat.MainActivity
sleep 5
# each check finds the app running (one that stops the app doesn't take the later ones down with it)
app() { adb shell pidof app.zenvqo.chat.debug > /dev/null || { adb shell am start -W -n app.zenvqo.chat.debug/app.zenvqo.chat.MainActivity; sleep 5; }; }
python3 e2e/android/pdf_on_phone.py "$OUT"; rc=$?
app; python3 e2e/android/read_on_phone.py "$OUT" || rc=1
app; python3 e2e/android/pictures_on_phone.py "$OUT" || rc=1
app; python3 e2e/android/page_restart_on_phone.py "$OUT" || rc=1
app; python3 e2e/android/apps_on_phone.py "$OUT" || rc=1
app; python3 e2e/android/share_on_phone.py "$OUT" || rc=1
app; python3 e2e/android/play_on_phone.py "$OUT" || rc=1
adb logcat -d > "$OUT/logcat.txt" || true
grep -E "ZenvqoPDF|ZenvqoApk|ZenvqoShare|ZenvqoPlay|PackageInstaller|AndroidRuntime|FATAL|lowmemorykiller|libsdcli|chromium.*(print|pdf|CONSOLE|camera)|PrintManager|Camera" -i "$OUT/logcat.txt" | grep -v SystemServerTiming | tail -80
exit $rc
