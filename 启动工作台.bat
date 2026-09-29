@echo off
cd /d %~dp0
start "" cmd /c "timeout /t 1 >nul & start http://127.0.0.1:4321"
node server.js
