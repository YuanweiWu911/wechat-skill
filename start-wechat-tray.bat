@echo off
rem start-wechat-tray.bat — Double-click to launch WeChat Skill Launcher with system tray icon.
rem Runs wechat-tray.exe (C# compiled, not flagged by antivirus) which spawns wechat-launcher.exe hidden.
rem The tray icon stays in the notification area for management.

cd /d "%~dp0"
start /min "" ".claude\hooks\wechat-tray.exe" "-ProjectRoot" "%cd%"
