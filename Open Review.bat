@echo off
rem Starts the review gallery's server (minimized) and opens it in the browser.
rem The server is reachable from other devices on port 8095; the password is in password.txt.
rem If the server is already running, the second copy just exits.
cd /d "%~dp0"
start "LinkedIn Review server - close this window to stop" /min node server.js
timeout /t 1 /nobreak >nul
start "" http://localhost:8095
