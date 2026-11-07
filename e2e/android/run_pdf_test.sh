#!/usr/bin/env bash
# Runs inside the emulator job: install the APK, start it, ask for PDFs, keep logs for the report.
set -u
APK="$1"; OUT="${2:-phone-out}"; mkdir -p "$OUT"
adb wait-for-device
adb logcat -c || true
adb install -r -g "$APK"
adb shell am start -W -n app.zenvqo.chat.debug/app.zenvqo.chat.MainActivity
sleep 5
python3 e2e/android/pdf_on_phone.py "$OUT"; rc=$?
adb logcat -d > "$OUT/logcat.txt" || true
grep -E "ZenvqoPDF|AndroidRuntime|FATAL|chromium.*(print|pdf)|PrintManager" -i "$OUT/logcat.txt" | tail -80
exit $rc
