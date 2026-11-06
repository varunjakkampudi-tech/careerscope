#!/usr/bin/env bash
# Hardens SSH on the deployed host. Idempotent.
#
# Deliberately sets PermitRootLogin to prohibit-password rather than no: root is
# the only account on this machine and deployment authenticates as root with a
# key, so "no" would lock the operator out entirely. Key-only root is the
# strongest setting that does not break access.
#
# Refuses to disable password authentication unless a working authorized key is
# already present, because that is the only thing standing between this change
# and a lockout. Hostinger's browser console remains the recovery path.
set -euo pipefail

config=/etc/ssh/sshd_config.d/10-careerscope.conf

# Always prints exactly one integer. The earlier `grep -c ... || echo 0` printed two lines
# when the file existed with no matching key, the numeric test then failed, and hardening
# went ahead anyway. Keys of other types (ecdsa-*, sk-*) count too (S1-F042).
count_authorized_keys() {
  local file=$1 count
  count=$(grep -cE '^(ssh-|ecdsa-sha2-|sk-)' "$file" 2>/dev/null || true)
  if [[ "$count" =~ ^[0-9]+$ ]]; then
    echo "$count"
  else
    echo 0
  fi
}

harden() {
  if [ "$(id -u)" -ne 0 ]; then
    echo "must run as root" >&2
    exit 1
  fi

  local keys
  keys=$(count_authorized_keys /root/.ssh/authorized_keys)
  if [ "$keys" -lt 1 ]; then
    echo "Refusing to harden: /root/.ssh/authorized_keys has no key." >&2
    echo "Disabling password authentication now would lock the operator out." >&2
    exit 1
  fi
  echo "==> $keys authorized key(s) present"

  cat >"$config" <<'EOF'
# CareerScope SSH hardening. Overrides the distribution defaults.
PermitRootLogin prohibit-password
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
MaxAuthTries 4
LoginGraceTime 30
X11Forwarding no
AllowAgentForwarding no
EOF
  chmod 644 "$config"

  # Validate before reloading; a bad config would otherwise take sshd down.
  if ! sshd -t; then
    echo "sshd config invalid; reverting" >&2
    rm -f "$config"
    exit 1
  fi

  systemctl reload ssh
  echo "==> reloaded"

  sshd -T | grep -E '^(permitrootlogin|passwordauthentication|pubkeyauthentication|kbdinteractiveauthentication|permitemptypasswords|maxauthtries) '
}

# Sourced by the regression check for count_authorized_keys; nothing runs in that case.
if [ "${HARDEN_SSH_SOURCE_ONLY:-0}" != 1 ]; then
  harden "$@"
fi
