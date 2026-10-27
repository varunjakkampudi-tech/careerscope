#!/usr/bin/env bash
# Prepares a single Ubuntu 24.04 host to run the CareerScope stack.
# Idempotent: safe to re-run. Installs Docker Engine from Docker's own
# repository because the distribution package lags behind on Compose v2.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

if [ "$(id -u)" -ne 0 ]; then
  echo "provision-host.sh must run as root" >&2
  exit 1
fi

. /etc/os-release
if [ "${ID:-}" != "ubuntu" ]; then
  echo "Unsupported distribution: ${ID:-unknown}" >&2
  exit 1
fi

echo "==> Updating base packages"
apt-get update -qq
apt-get -y -o Dpkg::Options::=--force-confold upgrade
apt-get install -y ca-certificates curl gnupg unattended-upgrades

echo "==> Enabling unattended security upgrades"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker Engine"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

systemctl enable --now docker

echo "==> Configuring host firewall"
# Docker publishes ports by writing its own nat/filter rules, so ufw alone cannot
# protect published ports. Only 22/80/443 are published by the stack; every
# other service binds to the proxy namespace loopback and is unreachable.
#
# This deliberately does NOT use `flush ruleset`: that also deletes the rules
# Docker installs, which silently breaks outbound NAT for every container.
# Only our own table is replaced.
apt-get install -y nftables
systemctl enable --now nftables
cat >/etc/nftables.conf <<'EOF'
#!/usr/sbin/nft -f
table inet careerscope
delete table inet careerscope

table inet careerscope {
  chain input {
    type filter hook input priority filter; policy drop;
    ct state established,related accept
    ct state invalid drop
    iif lo accept
    iifname "docker0" accept
    iifname "br-*" accept
    ip protocol icmp icmp type { echo-request, destination-unreachable, time-exceeded } accept
    ip6 nexthdr ipv6-icmp accept
    udp dport { 68, 546 } accept
    tcp dport { 22, 80, 443 } accept
  }
}
EOF
nft -f /etc/nftables.conf

# Docker writes its rules at daemon start; restart so anything lost earlier is
# reinstated, then prove a container can still reach the network.
systemctl restart docker
sleep 5
docker run --rm alpine:3.23 sh -c 'nslookup deb.debian.org >/dev/null 2>&1 && wget -qO- -T5 https://deb.debian.org >/dev/null' \
  && echo "Container egress OK" \
  || { echo "Container egress BROKEN" >&2; exit 1; }

echo "==> Host ready"
docker --version
docker compose version
nft list chain inet careerscope input
