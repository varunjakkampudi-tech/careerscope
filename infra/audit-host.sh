#!/usr/bin/env bash
# Read-only snapshot of the deployed host. Records what is actually true rather
# than what documentation claims. Safe to run at any time; changes nothing.
set -uo pipefail

section() { printf '\n== %s\n' "$1"; }

section "identity"
. /etc/os-release && echo "$PRETTY_NAME"
uname -srm
hostnamectl --static 2>/dev/null || true
uptime -p

section "resources"
free -h | awk 'NR<=3'
df -h / | awk 'NR<=2'
echo "inodes:"
df -i / | awk 'NR<=2'
echo "swap: $(swapon --show --noheadings | wc -l) device(s)"

section "time"
timedatectl | sed -n '1,6p'

section "listening sockets"
ss -lntup 2>/dev/null | awk 'NR==1 || /LISTEN/' | sed 's/users:(([^)]*))/<proc>/'

section "systemd"
echo "failed units: $(systemctl --failed --no-legend | wc -l)"
systemctl --failed --no-legend || true
for unit in docker nftables ssh unattended-upgrades fail2ban; do
  printf '%-22s %s\n' "$unit" "$(systemctl is-active "$unit" 2>/dev/null || echo absent)"
done

section "patching"
echo "pending security updates: $(apt-get -s upgrade 2>/dev/null | grep -ci '^Inst.*security' || echo 0)"
echo "reboot required: $([ -f /var/run/reboot-required ] && echo yes || echo no)"

section "ssh configuration"
sshd -T 2>/dev/null | grep -E '^(permitrootlogin|passwordauthentication|pubkeyauthentication|kbdinteractiveauthentication|port) ' || true

section "firewall"
nft list tables 2>/dev/null || echo "nftables unavailable"
echo "--- careerscope input chain ---"
nft list chain inet careerscope input 2>/dev/null || echo "careerscope table absent"
echo "--- docker nat present ---"
if nft list table ip nat >/dev/null 2>&1 && nft list table ip nat | grep -q -i docker; then
  echo "yes"
else
  echo "NO - docker NAT missing"
fi

section "docker"
docker --version
docker compose version
docker system df 2>/dev/null | awk 'NR<=5'
echo "--- journald ---"
journalctl --disk-usage 2>/dev/null || true

section "containers"
docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null

section "published ports"
docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -E '0\.0\.0\.0|:::' || echo "none published beyond proxy"
