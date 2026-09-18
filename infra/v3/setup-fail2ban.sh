#!/usr/bin/env bash
# Installs a fail2ban SSH jail that cannot touch Docker.
#
# fail2ban's default nftables action creates its own table and its own chains.
# That is safe here. What is not safe is any action that flushes globally, so
# this configuration pins the backend explicitly rather than letting fail2ban
# auto-detect and pick an iptables path that would fight with the nftables
# ruleset the host already uses.
#
# Value is limited on this host: password authentication is already disabled, so
# a brute-force attempt cannot succeed regardless. The jail is about cutting off
# log noise and connection churn, not about being the control that stops
# password guessing. That control is sshd.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root" >&2
  exit 1
fi

if ! command -v nft >/dev/null 2>&1; then
  echo "nftables is not present; refusing to configure fail2ban" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
if ! dpkg -s fail2ban >/dev/null 2>&1; then
  echo "== installing fail2ban"
  apt-get update -qq
  apt-get install -y -qq fail2ban
fi

echo "== writing jail configuration"
cat >/etc/fail2ban/jail.d/careerscope.local <<'EOF'
# CareerScope SSH jail.
#
# banaction uses the multiport nftables action, which maintains its own
# `f2b-table` and an addr-set. It never flushes the ruleset, so the Docker NAT
# rules and the careerscope input chain are untouched.
[DEFAULT]
banaction = nftables-multiport
banaction_allports = nftables-allports
backend = systemd

# Never lock the operator out of their own host.
ignoreip = 127.0.0.1/8 ::1

[sshd]
enabled  = true
port     = ssh
mode     = aggressive
maxretry = 5
findtime = 10m
bantime  = 1h
EOF

echo "== validating configuration"
fail2ban-client -t

systemctl enable --quiet fail2ban
systemctl restart fail2ban

# fail2ban takes a moment to build its chains after a restart.
for _ in $(seq 1 15); do
  if fail2ban-client status sshd >/dev/null 2>&1; then break; fi
  sleep 1
done

echo "== jail status"
fail2ban-client status sshd

echo "== docker networking still intact"
if nft list table ip nat >/dev/null 2>&1 && nft list table ip nat | grep -qi docker; then
  echo "PASS docker nat rules present"
else
  echo "FAIL docker nat rules missing after fail2ban start" >&2
  exit 1
fi

if nft list table inet careerscope >/dev/null 2>&1; then
  echo "PASS careerscope firewall table present"
else
  echo "FAIL careerscope firewall table missing after fail2ban start" >&2
  exit 1
fi

echo "fail2ban configured"
