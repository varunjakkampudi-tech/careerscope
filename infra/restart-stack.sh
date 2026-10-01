#!/usr/bin/env bash
# The supported way to restart the proxy.
#
# The dedicated network-anchor owns the namespace and the only published ports.
# Caddy joins that namespace, so restarting Caddy cannot orphan Postgres, Redis,
# LocalStack, the API or workers. Replacing the anchor is intentionally a full
# stack operation because it necessarily replaces the namespace.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
compose="docker compose -f $root/compose.production.yml"

echo "== restarting proxy"
$compose restart proxy

echo "== waiting for health"
for _ in $(seq 1 30); do
  unhealthy=$(docker ps --filter 'health=unhealthy' --format '{{.Names}}' | wc -l)
  starting=$(docker ps --filter 'health=starting' --format '{{.Names}}' | wc -l)
  if [ "$unhealthy" -eq 0 ] && [ "$starting" -eq 0 ]; then
    break
  fi
  sleep 2
done

echo "== verifying the origin answers"
# Probe from inside the stable shared namespace. This catches a Caddy restart
# that is healthy in isolation but cannot reach the application.
status=0
probe() {
  if docker exec careerscope-proxy-1 wget -qO- -T5 "$2" >/dev/null 2>&1; then
    echo "PASS $1 reachable from the proxy namespace"
  else
    echo "FAIL $1 not reachable from the proxy namespace"
    status=1
  fi
}

probe "web" "http://127.0.0.1:5280/"
probe "api" "http://127.0.0.1:5390/api/health"

docker ps --format '{{.Names}} {{.Status}}'

if [ "$status" -ne 0 ]; then
  echo
  echo "The stack did not come back. Recover with a deliberate full recreation:"
  echo "  $compose up -d --force-recreate"
  exit 1
fi

echo "restart complete"
