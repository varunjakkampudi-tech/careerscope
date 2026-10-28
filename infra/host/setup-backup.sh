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
units="$dir/../systemd"

echo "== installing backup.sh"
install -o root -g root -m 0755 "$dir/backup.sh" /usr/local/bin/careerscope-backup.sh

echo "== installing systemd units"
install -o root -g root -m 0644 "$units/careerscope-backup.service" /etc/systemd/system/careerscope-backup.service
install -o root -g root -m 0644 "$units/careerscope-backup.timer" /etc/systemd/system/careerscope-backup.timer

echo "== creating backup directory (root-only: dumps contain private data)"
install -d -o root -g root -m 0700 /var/backups/careerscope

if [ ! -f /etc/careerscope-backup.env ]; then
  echo "== no /etc/careerscope-backup.env yet - creating an empty, root-only template"
  install -o root -g root -m 0600 /dev/null /etc/careerscope-backup.env
  cat >>/etc/careerscope-backup.env <<'EOF'
# Uncomment to alert on a failed backup somewhere other than the journal.
# Defaults to MONITOR_WEBHOOK_URL (infra/careerscope-monitor.env) if unset.
# BACKUP_WEBHOOK_URL=https://hooks.slack.com/services/...

# Dump encryption is REQUIRED: a run with neither option below fails closed.
# Option 1 (preferred): age. Install age and set the PUBLIC key; keep the identity (private key)
# off this host.
# BACKUP_AGE_RECIPIENT=age1...
# Option 2: gpg symmetric. A file holding the passphrase, mode 0600 or 0400, outside
# /var/backups/careerscope. The unit runs with ProtectHome=yes, so the file must NOT be under
# /root or /home (it would be unreadable); use for example /etc/careerscope-backup.pass.
# BACKUP_GPG_PASSPHRASE_FILE=/etc/careerscope-backup.pass

# Directory for the resume encryption key copies. Must be owned by root with mode 0700, must not
# be inside (or contain) /var/backups/careerscope, and must not be under /root or /home.
# Prefer a different mount from the backups. Default if unset: /var/lib/careerscope/backup-keys
# BACKUP_KEY_DIR=/var/lib/careerscope/backup-keys
EOF
  echo "   set BACKUP_AGE_RECIPIENT or BACKUP_GPG_PASSPHRASE_FILE in it (encryption is required), then re-run this script"
else
  echo "== /etc/careerscope-backup.env already exists, leaving it untouched"
fi

echo "== enabling timer"
systemctl daemon-reload
systemctl enable --quiet careerscope-backup.timer
systemctl restart careerscope-backup.timer

# Preflight the encryption and key settings the way the unit will see them. The unit reads the
# same env file, and runs with ProtectHome=yes, so a path under /root or /home cannot be read.
problems=()
preflight() {
  # shellcheck disable=SC1091
  set -a; . /etc/careerscope-backup.env; set +a
  local recipient=${BACKUP_AGE_RECIPIENT:-} recipients_file=${BACKUP_AGE_RECIPIENTS_FILE:-}
  local pass=${BACKUP_GPG_PASSPHRASE_FILE:-} keydir=${BACKUP_KEY_DIR:-/var/lib/careerscope/backup-keys}
  if [ -n "$recipient$recipients_file" ]; then
    command -v age >/dev/null 2>&1       || echo "BACKUP_AGE_RECIPIENT is set but age is not installed (apt install age), or set BACKUP_GPG_PASSPHRASE_FILE instead"
  elif [ -n "$pass" ]; then
    case "$pass" in
      /root/* | /home/*) echo "BACKUP_GPG_PASSPHRASE_FILE ($pass) is under /root or /home; the unit has ProtectHome=yes and cannot read it. Move it, for example to /etc/careerscope-backup.pass" ;;
    esac
    if [ ! -s "$pass" ]; then
      echo "BACKUP_GPG_PASSPHRASE_FILE ($pass) is missing or empty"
    else
      case "$(stat -c '%a' "$pass")" in
        600 | 400) ;;
        *) echo "BACKUP_GPG_PASSPHRASE_FILE ($pass) must have mode 600 or 400 (chmod 600 $pass)" ;;
      esac
    fi
    command -v gpg >/dev/null 2>&1 || echo "BACKUP_GPG_PASSPHRASE_FILE is set but gpg is not installed (apt install gnupg)"
  else
    echo "no dump encryption configured: set BACKUP_AGE_RECIPIENT (and install age) or BACKUP_GPG_PASSPHRASE_FILE in /etc/careerscope-backup.env"
  fi
  case "$keydir" in
    /root/* | /home/*) echo "BACKUP_KEY_DIR ($keydir) is under /root or /home; the unit has ProtectHome=yes and cannot use it" ;;
    /var/backups/careerscope | /var/backups/careerscope/*) echo "BACKUP_KEY_DIR ($keydir) is inside the backup directory; the key must be stored apart from the ciphertext" ;;
  esac
}
while IFS= read -r line; do
  [ -n "$line" ] && problems+=("$line")
done < <(preflight 2>&1)

install_status=0
if [ ${#problems[@]} -gt 0 ]; then
  echo "== backup preflight FAILED; the immediate backup is skipped" >&2
  for problem in "${problems[@]}"; do echo "   - $problem" >&2; done
  echo "   Fix /etc/careerscope-backup.env (see docs/operations/BACKUP.md, Dump encryption settings), then re-run this script." >&2
  install_status=1
else
  echo "== running one backup now (dumps, verifies by restoring, then reports)"
  if ! systemctl start careerscope-backup.service; then
    echo "== the immediate backup FAILED; the installer continues so you can see why" >&2
    install_status=1
  fi
  sleep 2
  journalctl -u careerscope-backup.service -n 10 --no-pager || true
fi

echo "== last backup status"
cat /var/backups/careerscope/last-status 2>/dev/null || echo "(no status file yet - check the journal above)"

echo "== timer status"
systemctl list-timers careerscope-backup.timer --no-pager

if [ "$install_status" -ne 0 ]; then
  echo "backup job installed, but backups are NOT working yet (see the messages above)" >&2
  exit 1
fi
echo "backup job installed"
