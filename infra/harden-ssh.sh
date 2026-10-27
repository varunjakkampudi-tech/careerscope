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

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root" >&2
  exit 1
fi

keys=$(grep -c '^ssh-' /root/.ssh/authorized_keys 2>/dev/null || echo 0)
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
