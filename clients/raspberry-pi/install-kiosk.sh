#!/usr/bin/env bash
# KoiSignage – Raspberry Pi als Bildschirm einrichten.
# Aufruf:  bash install-kiosk.sh "https://SERVER/player/?key=SCHLÜSSEL"
#   (Direktlink aus der Verwaltung, Bildschirm > Einstellungen. Ohne ?key= geht auch, dann aber ohne HDMI-Schaltung.)
# Legt den Kiosk-Start und die HDMI-Schaltung (Fernseher passend zu den Betriebszeiten ein/aus) im Benutzerordner an
# und stellt die automatische Anmeldung am Desktop ein.
# Rückgängig: ~/koisignage-kiosk.sh, ~/koisignage-power.sh, ~/.config/koisignage/
#             und ~/.config/autostart/koisignage-*.desktop löschen.
set -euo pipefail

URL="${1:-}"
if [ -z "$URL" ]; then
  echo "Bitte die Player-Adresse angeben, z. B.:  bash install-kiosk.sh \"https://SERVER/player/\""
  exit 1
fi

cat > "$HOME/koisignage-kiosk.sh" <<EOF
#!/usr/bin/env bash
# Startet Chromium im Vollbild und startet ihn neu, falls er abstürzt.
URL="$URL"
BROWSER="\$(command -v chromium-browser || command -v chromium || true)"
if [ -z "\$BROWSER" ]; then echo "Chromium wurde nicht gefunden."; exit 1; fi
# Bildschirmschoner und Abschalten verhindern (wirkt unter X11; unter Wayland ohne Wirkung und ohne Schaden)
xset s off -dpms s noblank 2>/dev/null || true
sleep 5
while true; do
  "\$BROWSER" --kiosk "\$URL" --noerrdialogs --disable-infobars --no-first-run \\
    --autoplay-policy=no-user-gesture-required --disable-session-crashed-bubble \\
    --check-for-update-interval=31536000 --password-store=basic
  sleep 5
done
EOF
chmod +x "$HOME/koisignage-kiosk.sh"

mkdir -p "$HOME/.config/autostart"
cat > "$HOME/.config/autostart/koisignage-kiosk.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=KoiSignage Kiosk
Exec=$HOME/koisignage-kiosk.sh
X-GNOME-Autostart-enabled=true
EOF

# ───────── HDMI-Schaltung: Fernseher passend zu den Betriebszeiten ein- und ausschalten ─────────
KEY="$(printf '%s' "$URL" | sed -n 's/.*[?&]key=\([^&#]*\).*/\1/p')"
SERVER="${URL%%/player*}"
mkdir -p "$HOME/.config/koisignage"
if [ ! -f "$HOME/.config/koisignage/power.conf" ] || [ -n "$KEY" ]; then
  cat > "$HOME/.config/koisignage/power.conf" <<EOF
# KoiSignage HDMI-Schaltung. Nach Änderungen neu starten (sudo reboot).
SERVER="$SERVER"
# Schlüssel des Bildschirms (steht im Direktlink hinter ?key=)
KEY="$KEY"
# auto: HDMI-CEC wenn vorhanden, sonst HDMI-Signal abschalten | cec | signal | off (keine Schaltung)
MODE="auto"
# CEC-Gerät: /dev/cec0 ist am Pi 4 der HDMI-Anschluss neben dem Stromanschluss
CEC_DEV="/dev/cec0"
# Sekunden zwischen zwei Abfragen beim Server
INTERVAL=60
EOF
fi

cat > "$HOME/koisignage-power.sh" <<'EOF'
#!/usr/bin/env bash
# KoiSignage – schaltet den Fernseher passend zu den Betriebszeiten per HDMI ein und aus.
# Fragt den Server regelmässig, ob der Bildschirm gerade an sein soll, und schaltet nur bei einem Wechsel.
# Von Hand:  ~/koisignage-power.sh on | off | status | test
CONF="$HOME/.config/koisignage/power.conf"
[ -f "$CONF" ] && . "$CONF"
MODE="${MODE:-auto}"; CEC_DEV="${CEC_DEV:-/dev/cec0}"; INTERVAL="${INTERVAL:-60}"
LOG="$HOME/.cache/koisignage-power.log"

log() { echo "$(date '+%F %T') $*"; }

detect() {
  case "$MODE" in cec|signal|off) echo "$MODE"; return ;; esac
  if command -v cec-ctl >/dev/null 2>&1 && [ -e "$CEC_DEV" ]; then echo cec; return; fi
  if { [ -n "${WAYLAND_DISPLAY:-}" ] && command -v wlr-randr >/dev/null 2>&1; } || { [ -n "${DISPLAY:-}" ] && command -v xrandr >/dev/null 2>&1; }; then echo signal; return; fi
  echo off
}

# ── HDMI-CEC: echte Befehle an den Fernseher ──
cec() { cec-ctl -d "$CEC_DEV" "$@" >/dev/null 2>&1; }
cec_init() { cec --playback --osd-name KoiSignage; }
cec_on() {
  cec --to 0 --image-view-on || return 1
  # Fernseher auf den Eingang des Pi umschalten
  local pa
  pa="$(cec-ctl -d "$CEC_DEV" 2>/dev/null | sed -n 's/.*Physical Address *: *\([0-9a-f.]*\).*/\1/p' | head -1)"
  [ -n "$pa" ] && [ "$pa" != "f.f.f.f" ] && cec --to 15 --active-source phys-addr="$pa"
  return 0
}
cec_off() { cec --to 0 --standby; }
cec_status() { cec-ctl -d "$CEC_DEV" --to 0 --give-device-power-status 2>/dev/null | sed -n 's/.*pwr-state: *\([a-z-]*\).*/\1/p' | head -1; }

# ── HDMI-Signal abschalten: Monitore gehen in den Energiesparmodus ──
output() {
  if [ -n "${WAYLAND_DISPLAY:-}" ] && command -v wlr-randr >/dev/null 2>&1; then wlr-randr | awk '/^[^ ]/{print $1; exit}'
  else xrandr --query 2>/dev/null | awk '/ connected/{print $1; exit}'; fi
}
signal_set() {
  local o; o="$(output)"; [ -n "$o" ] || return 1
  if [ -n "${WAYLAND_DISPLAY:-}" ] && command -v wlr-randr >/dev/null 2>&1; then wlr-randr --output "$o" "--$1"
  elif [ "$1" = on ]; then xrandr --output "$o" --auto
  else xrandr --output "$o" --off; fi
}

switch() { # on|off
  case "$VIA" in
    cec) if [ "$1" = on ]; then cec_on; else cec_off; fi ;;
    signal) signal_set "$1" ;;
    *) return 0 ;;
  esac
}
tvstate() { [ "$VIA" = cec ] && cec_status; }

VIA="$(detect)"
[ "$VIA" = cec ] && cec_init

case "${1:-}" in
  on|off) switch "$1" && echo "Bildschirm $1 ($VIA)" || { echo "Schalten fehlgeschlagen ($VIA)"; exit 1; }; exit 0 ;;
  status) echo "Schaltung: $VIA"; [ "$VIA" = cec ] && echo "Fernseher meldet: $(cec_status || true)"; exit 0 ;;
  test) echo "Schaltung: $VIA. Aus für 15 Sekunden ..."; switch off; sleep 15; switch on; echo "Wieder an."; exit 0 ;;
esac

mkdir -p "$(dirname "$LOG")"
# Log klein halten
if [ -f "$LOG" ] && [ "$(wc -l <"$LOG")" -gt 2000 ]; then tail -n 500 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"; fi
exec >>"$LOG" 2>&1
[ -n "${KEY:-}" ] && [ -n "${SERVER:-}" ] || { log "Kein Schlüssel in $CONF, HDMI-Schaltung ruht."; exit 0; }
[ "$VIA" = off ] && log "Keine HDMI-Schaltung möglich (MODE=$MODE)."
log "Start, Schaltung: $VIA"

state=""; error=""; lasterr=""
while true; do
  body="{\"state\":\"$state\",\"via\":\"$VIA\",\"tv\":\"$(tvstate)\",\"error\":\"$error\"}"
  resp="$(curl -fsS --max-time 20 -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d "$body" "$SERVER/api/player/power" 2>&1)"
  if [ $? -eq 0 ]; then
    case "$resp" in *'"on":true'*) want=on ;; *'"on":false'*) want=off ;; *) want="" ;; esac
    if [ -n "$want" ] && [ "$want" != "$state" ]; then
      if switch "$want"; then [ "$VIA" != off ] && log "Bildschirm $want"; state="$want"; error=""
      else error="Schalten auf $want fehlgeschlagen"; fi
    fi
  else
    # Server nicht erreichbar: Zustand beibehalten
    error=""; [ "$resp" != "$lasterr" ] && log "Server nicht erreichbar: $resp"
  fi
  [ -n "$error" ] && [ "$error" != "$lasterr" ] && log "$error"
  lasterr="${error:-$resp}"
  sleep "$INTERVAL"
done
EOF
chmod +x "$HOME/koisignage-power.sh"

cat > "$HOME/.config/autostart/koisignage-power.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=KoiSignage HDMI-Schaltung
Exec=$HOME/koisignage-power.sh
X-GNOME-Autostart-enabled=true
EOF

# cec-ctl gehört zum Paket v4l-utils
if ! command -v cec-ctl >/dev/null 2>&1; then
  sudo apt-get install -y v4l-utils >/dev/null 2>&1 || echo "Hinweis: Für HDMI-CEC bitte 'sudo apt install v4l-utils' ausführen."
fi

# Start in den Desktop mit automatischer Anmeldung (B4), falls raspi-config vorhanden ist
if command -v raspi-config >/dev/null 2>&1; then
  sudo raspi-config nonint do_boot_behaviour B4 || echo "Hinweis: Automatische Anmeldung bitte von Hand in raspi-config einstellen."
  # Bildschirm nicht abdunkeln (nicht in jeder Version vorhanden)
  sudo raspi-config nonint do_blanking 1 2>/dev/null || true
fi

echo
echo "Fertig. Nach dem Neustart öffnet sich der Player im Vollbild:"
echo "  $URL"
if [ -n "$KEY" ]; then
  echo "HDMI-Schaltung ist eingerichtet: Der Fernseher geht ausserhalb der Betriebszeiten aus."
  echo "Gleich ausprobieren:  ~/koisignage-power.sh test"
else
  echo "HDMI-Schaltung ruht: In der Adresse fehlt ?key=. Den Direktlink aus der Verwaltung"
  echo "(Bildschirm > Einstellungen) verwenden oder KEY in ~/.config/koisignage/power.conf eintragen."
fi
echo "Neustart mit:  sudo reboot"
