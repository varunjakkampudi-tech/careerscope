#!/usr/bin/env bash
# Installs the CS-24 host monitor: monitor.sh, its systemd service and timer,
# and the state directory it writes to. Idempotent - safe to re-run after
# editing monitor.sh or changing /etc/careerscope-monitor.env.
#
# Before running, put your webhook URL (and any MONITOR_* override) in
# /etc/careerscope-monitor.env, e.g.:
#   MONITOR_WEBHOOK_URL=https://hooks.slack.com/services/...
# That file is read only by the systemd service (root-owned, mode 600) and is
# never written to by this script - the operator's webhook URL is never
# generated or guessed here.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root" >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is not present; refusing to install the monitor" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not present; refusing to install the monitor" >&2
  exit 1
fi

dir="$(cd "$(dirname "$0")" && pwd)"

echo "== installing monitor.sh"
install -o root -g root -m 0755 "$dir/monitor.sh" /usr/local/bin/careerscope-monitor.sh

echo "== installing systemd units"
install -o root -g root -m 0644 "$dir/careerscope-monitor.service" /etc/systemd/system/careerscope-monitor.service
install -o root -g root -m 0644 "$dir/careerscope-monitor.timer" /etc/systemd/system/careerscope-monitor.timer

echo "== creating state directory"
install -d -o root -g root -m 0700 /var/lib/careerscope-monitor

if [ ! -f /etc/careerscope-monitor.env ]; then
  echo "== no /etc/careerscope-monitor.env yet - creating an empty, root-only template"
  install -o root -g root -m 0600 /dev/null /etc/careerscope-monitor.env
  cat >>/etc/careerscope-monitor.env <<'EOF'
# Uncomment and set to receive alerts. Without this, the monitor still runs
# and still logs every classification to the journal, it just cannot notify.
# MONITOR_WEBHOOK_URL=https://hooks.slack.com/services/...
EOF
  echo "   edit it, then re-run this script or 'systemctl restart careerscope-monitor.timer'"
else
  echo "== /etc/careerscope-monitor.env already exists, leaving it untouched"
fi

echo "== enabling timer"
systemctl daemon-reload
systemctl enable --quiet careerscope-monitor.timer
systemctl restart careerscope-monitor.timer

echo "== running one check now"
systemctl start careerscope-monitor.service
sleep 1
journalctl -u careerscope-monitor.service -n 5 --no-pager

echo "== timer status"
systemctl list-timers careerscope-monitor.timer --no-pager

echo "monitor installed"
