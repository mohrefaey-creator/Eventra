@echo off
rem Same as Start-AirPlay.bat but the picture opens full screen (good when the laptop is on a TV through HDMI).
set "ROOT=%~dp0"
set "PATH=%ROOT%bin;%PATH%"
set "GST_PLUGIN_SYSTEM_PATH_1_0=%ROOT%lib\gstreamer-1.0"
set "GST_PLUGIN_PATH_1_0=%ROOT%lib\gstreamer-1.0"
set "GST_PLUGIN_SCANNER=%ROOT%libexec\gstreamer-1.0\gst-plugin-scanner.exe"
set "GST_REGISTRY_1_0=%TEMP%\mirrorlink-airplay-registry.bin"
echo.
echo   MirrorLink AirPlay receiver (full screen)
echo   On the iPhone: Control Center, Screen Mirroring, choose "MirrorLink-Laptop".
echo.
"%ROOT%bin\uxplay.exe" -n MirrorLink-Laptop -nh -fs
echo.
echo The receiver stopped. Press any key to close.
pause >nul
