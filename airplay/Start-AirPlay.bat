@echo off
rem Starts the AirPlay receiver. Leave this window open, then on the iPhone/iPad open Control Center
rem and tap Screen Mirroring, and choose "MirrorLink-Laptop".
set "ROOT=%~dp0"
set "PATH=%ROOT%bin;%PATH%"
set "GST_PLUGIN_SYSTEM_PATH_1_0=%ROOT%lib\gstreamer-1.0"
set "GST_PLUGIN_PATH_1_0=%ROOT%lib\gstreamer-1.0"
set "GST_PLUGIN_SCANNER=%ROOT%libexec\gstreamer-1.0\gst-plugin-scanner.exe"
set "GST_REGISTRY_1_0=%TEMP%\mirrorlink-airplay-registry.bin"
echo.
echo   MirrorLink AirPlay receiver
echo   On the iPhone: Control Center, Screen Mirroring, choose "MirrorLink-Laptop".
echo   Close this window to stop.
echo.
"%ROOT%bin\uxplay.exe" -n MirrorLink-Laptop -nh
echo.
echo The receiver stopped. Press any key to close.
pause >nul
