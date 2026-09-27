#!/usr/bin/env bash
# Installs the CS-3 proxy split-brain detector/auto-recovery. Idempotent.
#
# Shares /etc/careerscope-monitor.env with careerscope-monitor.service (CS-24)
# for MONITOR_URL/MONITOR_WEBHOOK_URL - one webhook, one place to configure it.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root" >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is not present; refusing to install the proxy recovery timer" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not present; refusing to install the proxy recovery timer" >&2
  exit 1
fi

dir="$(cd "$(dirname "$0")" && pwd)"

echo "== installing recover-proxy.sh"
install -o root -g root -m 0755 "$dir/recover-proxy.sh" /usr/local/bin/careerscope-recover-proxy.sh

echo "== installing systemd units"
install -o root -g root -m 0644 "$dir/careerscope-proxy-recovery.service" /etc/systemd/system/careerscope-proxy-recovery.service
install -o root -g root -m 0644 "$dir/careerscope-proxy-recovery.timer" /etc/systemd/system/careerscope-proxy-recovery.timer

echo "== creating state directory (shared with careerscope-monitor, CS-24)"
install -d -o root -g root -m 0700 /var/lib/careerscope-monitor

if [ ! -f /etc/careerscope-monitor.env ]; then
  echo "== no /etc/careerscope-monitor.env yet - creating an empty, root-only template"
  install -o root -g root -m 0600 /dev/null /etc/careerscope-monitor.env
  cat >>/etc/careerscope-monitor.env <<'EOF'
# Shared by careerscope-monitor.service (CS-24) and careerscope-proxy-recovery.service (CS-3).
# MONITOR_URL=https://careerscope.tech/api/health
# MONITOR_WEBHOOK_URL=https://hooks.slack.com/services/...
EOF
else
  echo "== /etc/careerscope-monitor.env already exists, leaving it untouched"
fi

echo "== enabling timer"
systemctl daemon-reload
systemctl enable --quiet careerscope-proxy-recovery.timer
systemctl restart careerscope-proxy-recovery.timer

echo "== timer status"
systemctl list-timers careerscope-proxy-recovery.timer --no-pager

echo "CS-3 proxy recovery installed. Prove it by killing Caddy (docker kill careerscope-proxy-1)"
echo "and watching this recover on its own within a couple of confirm-then-restart cycles:"
echo "  journalctl -u careerscope-proxy-recovery.service -f"
