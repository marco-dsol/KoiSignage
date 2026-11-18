@echo off
rem KoiSignage - Bildschirm im Vollbild starten.
rem 1. Adresse in der naechsten Zeile anpassen (am besten den Direktlink des Bildschirms).
rem 2. Diese Datei in den Autostart-Ordner kopieren: Win+R, dann shell:startup
rem Die Datei startet nur Microsoft Edge mit Startparametern. Es wird nichts installiert.

set "KOI_URL=http://SERVER:8080/player/"

set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"

start "" "%EDGE%" --kiosk "%KOI_URL%" --edge-kiosk-type=fullscreen --no-first-run --autoplay-policy=no-user-gesture-required
