#!/usr/bin/env bash
# On an emulator: install an app made by "Make app" (ApkMaker, built on the CI machine), open it like the launcher does
# and check it really runs: the process is up, its screen is in front, the page's JavaScript ran, no crash.
# Usage: made_app_check.sh APP.apk PACKAGE "text the page shows"
set -u
APK="$1"; PKG="$2"; WANT="$3"; rc=0
adb wait-for-device
adb shell getprop ro.build.version.sdk
adb install -r "$APK" || { echo "::error::install failed"; exit 1; }
adb logcat -c || true
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1    # what tapping the icon does
sleep 8
pid=$(adb shell pidof "$PKG" | tr -d '\r')
echo "pid: '$pid'"
[ -n "$pid" ] || { echo "::error::the made app isn't running"; rc=1; }
adb shell dumpsys activity activities | grep -E "ResumedActivity" | head -4
adb shell dumpsys activity activities | grep -E "ResumedActivity" | grep -q "$PKG" || { echo "::error::the made app's screen isn't in front"; rc=1; }
found=""
for i in 1 2 3 4 5; do
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
  xml=$(adb shell cat /sdcard/ui.xml)
  if echo "$xml" | grep -q "$WANT"; then found=1; break; fi
  sleep 2
done
echo "$xml" | grep -o 'text="[^"]\+"' | head -15
[ -n "$found" ] || { echo "::error::the page text '$WANT' isn't on screen"; rc=1; }
adb exec-out screencap -p > made-app.png || true
# Back leaves the app (no history in the page)
adb shell input keyevent KEYCODE_BACK; sleep 2
adb logcat -d > made-app-logcat.txt || true
grep -E "AndroidRuntime|FATAL|$PKG|ActivityTaskManager: (START|Displayed)" made-app-logcat.txt | grep -v "^--" | tail -40
if grep -q "FATAL EXCEPTION" made-app-logcat.txt; then echo "::error::the made app crashed"; grep -A25 "FATAL EXCEPTION" made-app-logcat.txt | head -60; rc=1; fi
[ $rc = 0 ] && echo "OK: the made app opens and runs its page"
exit $rc
