#!/usr/bin/env bash
# Verifies the host firewall does what it claims and, critically, that it has not
# broken Docker.
#
# This check exists because an earlier ruleset used `nft flush ruleset`, which
# deletes the NAT rules Docker installs and silently kills container egress. The
# symptom was an opaque apt timeout inside a build, not a firewall error.
set -uo pipefail

failures=0

check() {
  if [ "$2" = "$3" ]; then
    printf 'PASS %-40s %s\n' "$1" "$2"
  else
    printf 'FAIL %-40s got %s, expected %s\n' "$1" "$2" "$3"
    failures=$((failures + 1))
  fi
}

echo "== firewall present and owning only its own table"
check "careerscope table exists" \
  "$(nft list tables 2>/dev/null | grep -c 'inet careerscope')" "1"
check "input policy is drop" \
  "$(nft list chain inet careerscope input 2>/dev/null | grep -c 'policy drop')" "1"

echo "== docker networking untouched"
check "docker nat table present" \
  "$(nft list tables 2>/dev/null | grep -c '^table ip nat$')" "1"
check "docker nat rules present" \
  "$(nft list table ip nat 2>/dev/null | grep -ci docker | awk '{print ($1>0)?1:0}')" "1"

echo "== container egress"
if docker run --rm alpine:3.23 sh -c 'wget -qO- -T5 https://deb.debian.org >/dev/null' 2>/dev/null; then
  check "container reaches the internet" "1" "1"
else
  check "container reaches the internet" "0" "1"
fi

echo "== listening sockets"
for port in 22 80 443; do
  check "port $port listening" \
    "$(ss -lnt "sport = :$port" 2>/dev/null | grep -c LISTEN | awk '{print ($1>0)?1:0}')" "1"
done
for port in 5280 5390 5432 6379 4566; do
  check "port $port not listening externally" \
    "$(ss -lnt "sport = :$port" 2>/dev/null | grep -c '0\.0\.0\.0\|\[::\]')" "0"
done

echo "== published container ports"
check "only the proxy publishes ports" \
  "$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -c '0\.0\.0\.0')" "1"

if [ "$failures" -gt 0 ]; then
  echo "$failures firewall check(s) failed" >&2
  exit 1
fi
echo "host firewall consistent and docker networking intact"
