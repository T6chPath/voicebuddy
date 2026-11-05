@echo off
title zenvqo.voice - Auto-Tap hamesha ON
color 0E
echo.
echo  ==========================================================
echo     zenvqo.voice : Auto-Tap ko HAMESHA ON karo (sirf ek baar)
echo  ==========================================================
echo.
echo  Phone pe pehle ye kar lo:
echo    1. Settings ^> About phone ^> "Build number" pe 7 baar tap karo
echo    2. Settings ^> Developer options ^> "USB debugging" ON karo
echo    3. Phone ko USB cable se is PC se jodo
echo    4. Phone pe "Allow USB debugging?" aaye to "Always allow" + OK
echo.
pause

set "TOOLS=%LOCALAPPDATA%\zenvqo-adb"
set "ADB=%TOOLS%\platform-tools\adb.exe"

if exist "%ADB%" goto haveadb
echo.
echo  Android tools download ho rahe hain (sirf pehli baar, ~7 MB)...
if not exist "%TOOLS%" mkdir "%TOOLS%"
curl -L -s -o "%TOOLS%\pt.zip" "https://dl.google.com/android/repository/platform-tools-latest-windows.zip"
if errorlevel 1 goto nonet
tar -xf "%TOOLS%\pt.zip" -C "%TOOLS%"
del "%TOOLS%\pt.zip" >nul 2>&1
if not exist "%ADB%" goto nonet

:haveadb
echo.
echo  Phone dhundh raha hoon... (phone pe "Allow" dabana na bhoolein)
"%ADB%" start-server >nul 2>&1
"%ADB%" wait-for-device

"%ADB%" shell pm list packages com.voicebuddy.app | findstr /c:"com.voicebuddy.app" >nul
if errorlevel 1 goto noapp

echo  Permission de raha hoon...
"%ADB%" shell pm grant com.voicebuddy.app android.permission.WRITE_SECURE_SETTINGS
if errorlevel 1 goto failed
rem Android 13+: side-loaded app ka switch unlock
"%ADB%" shell appops set com.voicebuddy.app ACCESS_RESTRICTED_SETTINGS allow >nul 2>&1
rem Battery saver se bachao
"%ADB%" shell dumpsys deviceidle whitelist +com.voicebuddy.app >nul 2>&1
rem App kholo: wo khud Auto-Tap on kar dega
"%ADB%" shell am start -n com.voicebuddy.app/.MainActivity >nul 2>&1

echo.
color 0A
echo  ==========================================================
echo     HO GAYA!  Auto-Tap ab hamesha ON rahega.
echo     Restart ya update ke baad bhi apne aap ON ho jayega.
echo     Ab cable nikaal sakte ho. USB debugging band bhi kar sakte ho.
echo  ==========================================================
echo.
pause
exit /b 0

:noapp
color 0C
echo.
echo  Phone mein zenvqo.voice nahi mila. Pehle APK install karo, phir ye file dobara chalao.
pause
exit /b 1

:nonet
color 0C
echo.
echo  Download nahi ho paya. Internet check karke dobara chalao.
pause
exit /b 1

:failed
color 0C
echo.
echo  Permission nahi di ja saki.
echo  Xiaomi / Redmi / POCO: Developer options mein "USB debugging (Security settings)" bhi ON karo, phir dobara chalao.
pause
exit /b 1
