#!/bin/sh
#
# Start an X server, then hand off — the wrapper for the `api-scrape` image.
#
# ## Why a display at all
#
# The scrape tier runs Chromium *headed* (`DEFAULTS.headless = false` in
# packages/providers/src/scrape/browser.ts). That is not a disguise: Naukri's
# edge refuses a headless Chromium outright, and headless mode is the literal
# thing it checks for. A headed browser needs somewhere to draw, and a server
# has no display, so one is manufactured here.
#
# ## Why not xvfb-run
#
# `xvfb-run` is the obvious answer and the wrong one for PID 1. It runs the
# command as a *child* and waits on it, and Debian's copy does not forward
# SIGTERM — so `docker stop` would kill the wrapper, the server would never see
# the signal, and the graceful drain in apps/api/src/index.ts would be skipped
# in favour of a SIGKILL nine seconds later. Starting Xvfb by hand and `exec`ing
# the real command keeps the server as PID 1, exactly as the plain `api` image
# has it.
#
# Xvfb is left as an orphan child of the server. It is never reaped, which is
# fine: the container's whole process tree goes when PID 1 goes, and an X server
# that outlives the thing it was drawing for has nothing to leak into.
set -eu

DISPLAY_NUM="${XVFB_DISPLAY:-99}"
SCREEN="${XVFB_SCREEN:-1920x1080x24}"

# The socket directory, before the server that wants to bind in it. X creates
# this itself when it can, but it runs here as an unprivileged user, and under
# systemd `PrivateTmp=true` gives the unit an empty /tmp on every start — so on
# the documented deployment it is reliably absent. /tmp is 1777, so creating it
# needs no privilege; an existing one is left exactly as it is.
if [ ! -d /tmp/.X11-unix ]; then
  mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
fi

# -nolisten tcp: the only client is on this machine, over the unix socket.
Xvfb ":${DISPLAY_NUM}" -screen 0 "${SCREEN}" -nolisten tcp -noreset >/dev/null 2>&1 &

# Wait for the socket rather than sleeping a fixed amount. Chromium launching
# half a second before the server is listening fails with "Missing X server",
# which reads like a missing package rather than a race.
socket="/tmp/.X11-unix/X${DISPLAY_NUM}"
waited=0
while [ ! -e "$socket" ]; do
  if [ "$waited" -ge 100 ]; then
    echo "[xvfb] X server did not come up within 10s; starting anyway" >&2
    break
  fi
  waited=$((waited + 1))
  sleep 0.1
done

export DISPLAY=":${DISPLAY_NUM}"
echo "[xvfb] display ${DISPLAY} ready (${SCREEN})"

exec "$@"
