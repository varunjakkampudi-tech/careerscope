#!/usr/bin/env bash
# Installs the CS-25 host backup: backup.sh, its systemd service and timer,
# and the backup directory it writes to. Idempotent - safe to re-run.
#
# Dumps contain private data (resumes, emails, everything else in the
# database), so the backup directory and every dump in it are root-only.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root" >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is not present; refusing to install the backup job" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not present; refusing to install the backup job" >&2
  exit 1
fi

dir="$(cd "$(dirname "$0")" && pwd)"

echo "== installing backup.sh"
install -o root -g root -m 0755 "$dir/backup.sh" /usr/local/bin/careerscope-backup.sh

echo "== installing systemd units"
install -o root -g root -m 0644 "$dir/careerscope-backup.service" /etc/systemd/system/careerscope-backup.service
install -o root -g root -m 0644 "$dir/careerscope-backup.timer" /etc/systemd/system/careerscope-backup.timer

echo "== creating backup directory (root-only: dumps contain private data)"
install -d -o root -g root -m 0700 /var/backups/careerscope

if [ ! -f /etc/careerscope-backup.env ]; then
  echo "== no /etc/careerscope-backup.env yet - creating an empty, root-only template"
  install -o root -g root -m 0600 /dev/null /etc/careerscope-backup.env
  cat >>/etc/careerscope-backup.env <<'EOF'
# Uncomment to alert on a failed backup somewhere other than the journal.
# Defaults to MONITOR_WEBHOOK_URL (infra/careerscope-monitor.env) if unset.
# BACKUP_WEBHOOK_URL=https://hooks.slack.com/services/...
EOF
  echo "   edit it if you want a separate webhook, then re-run this script"
else
  echo "== /etc/careerscope-backup.env already exists, leaving it untouched"
fi

echo "== enabling timer"
systemctl daemon-reload
systemctl enable --quiet careerscope-backup.timer
systemctl restart careerscope-backup.timer

echo "== running one backup now (dumps, verifies by restoring, then reports)"
systemctl start careerscope-backup.service
sleep 2
journalctl -u careerscope-backup.service -n 10 --no-pager

echo "== last backup status"
cat /var/backups/careerscope/last-status 2>/dev/null || echo "(no status file yet - check the journal above)"

echo "== timer status"
systemctl list-timers careerscope-backup.timer --no-pager

echo "backup job installed"
