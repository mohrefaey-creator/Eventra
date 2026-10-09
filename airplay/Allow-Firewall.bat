@echo off
rem Run this once (right-click, Run as administrator) if the iPhone does not list "MirrorLink-Laptop".
rem It lets the receiver through Windows Firewall on private networks.
net session >nul 2>&1
if errorlevel 1 (
  echo Please right-click this file and choose "Run as administrator".
  pause
  exit /b 1
)
netsh advfirewall firewall delete rule name="MirrorLink AirPlay" >nul 2>&1
netsh advfirewall firewall add rule name="MirrorLink AirPlay" dir=in action=allow program="%~dp0bin\uxplay.exe" profile=private,domain enable=yes
echo Done. Make sure the Wi-Fi network is set to "Private" in Windows settings.
pause
