#!/usr/bin/env bash
# Installs the CS-47 scheduler-health checker: scheduler-health.sh, its
# systemd service and timer. Idempotent - safe to re-run after editing
# scheduler-health.sh.
#
# Shares /etc/careerscope-monitor.env with careerscope-monitor.service
# (CS-24) for the webhook - one alerting channel, one place to configure it.
# Set SCHEDULER_WEBHOOK_URL there only if you want this alert routed
# somewhere other than MONITOR_WEBHOOK_URL.
#
# This watches the six timers installed by setup-monitoring.sh (CS-24),
# setup-backup.sh (CS-25), setup-discovery.sh (CS-26), setup-lead-lifecycle.sh
# (CS-27) and setup-proxy-recovery.sh (CS-3). Install those first: until a
# watched timer has actually fired once, this checker reports it as
# "has never recorded a run" - deliberately, because it genuinely cannot
# confirm the timer has ever fired.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root" >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is not present; refusing to install the scheduler health check" >&2
  exit 1
fi

# systemd-analyze ships with systemd, but this checker derives the expected
# interval of the four calendar timers by asking it to expand their own
# OnCalendar expressions. Without it those four cannot be checked, and this
# script must not install something that would then report four permanent
# "could not derive" failures.
if ! command -v systemd-analyze >/dev/null 2>&1; then
  echo "systemd-analyze is not present; refusing to install (the calendar timers' expected intervals cannot be derived without it)" >&2
  exit 1
fi

dir="$(cd "$(dirname "$0")" && pwd)"

echo "== installing scheduler-health.sh"
install -o root -g root -m 0755 "$dir/scheduler-health.sh" /usr/local/bin/careerscope-scheduler-health.sh

echo "== installing systemd units"
install -o root -g root -m 0644 "$dir/careerscope-scheduler-health.service" /etc/systemd/system/careerscope-scheduler-health.service
install -o root -g root -m 0644 "$dir/careerscope-scheduler-health.timer" /etc/systemd/system/careerscope-scheduler-health.timer

echo "== creating state directory (shared with careerscope-monitor, CS-24)"
install -d -o root -g root -m 0700 /var/lib/careerscope-monitor

if [ ! -f /etc/careerscope-monitor.env ]; then
  echo "== no /etc/careerscope-monitor.env yet - creating an empty, root-only template"
  install -o root -g root -m 0600 /dev/null /etc/careerscope-monitor.env
  cat >>/etc/careerscope-monitor.env <<'EOF'
# Shared by careerscope-monitor.service (CS-24), careerscope-proxy-recovery.service
# (CS-3) and careerscope-scheduler-health.service (CS-47).
# MONITOR_URL=https://careerscope.tech/api/health
# MONITOR_WEBHOOK_URL=https://hooks.slack.com/services/...
# SCHEDULER_WEBHOOK_URL=  # optional: route scheduler-health alerts elsewhere
EOF
else
  echo "== /etc/careerscope-monitor.env already exists, leaving it untouched"
fi

echo "== enabling timer"
systemctl daemon-reload
systemctl enable --quiet careerscope-scheduler-health.timer
systemctl restart careerscope-scheduler-health.timer

echo "== running one check now (a non-zero exit here is a real finding, not an install error)"
systemctl start careerscope-scheduler-health.service || true
sleep 1
journalctl -u careerscope-scheduler-health.service -n 10 --no-pager

echo "== timer status"
systemctl list-timers careerscope-scheduler-health.timer --no-pager

echo "CS-47 scheduler health installed. Prove it can fail on this host by disabling"
echo "a watched timer and re-running the check - expect it to name that timer:"
echo "  systemctl stop careerscope-retention.timer"
echo "  /usr/local/bin/careerscope-scheduler-health.sh; echo \"exit=\$?\"   # expect exit 1"
echo "  systemctl start careerscope-retention.timer"
