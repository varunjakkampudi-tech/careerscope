#!/bin/sh
set -eu
umask 077

password_file="${HOME}/.vnc/passwd"
if [ ! -s "$password_file" ]; then
  echo "[application] Browser password missing. Run the documented x11vnc -storepasswd setup first." >&2
  exit 1
fi
chmod 600 "$password_file"

: "${DISPLAY:?The application runtime requires the Xvfb display wrapper}"
x11vnc -display "$DISPLAY" -localhost -rfbport 5900 -rfbauth "$password_file" -forever -shared >/dev/null 2>&1 &
websockify --web=/usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &

exec "$@"