#!/usr/bin/env bash
# The only supported way to restart the proxy.
#
# Every service uses `network_mode: service:proxy`, so the proxy container owns
# the single network namespace and everything else joins it. That is what keeps
# Postgres, Redis, LocalStack and the API bound to loopback with no reachable
# address from any network.
#
# The cost is that restarting the proxy on its own is an outage. Docker destroys
# the old namespace and builds a new one, but the containers that joined the old
# one are never re-attached: they keep running against a dead namespace, and the
# proxy answers every request with 502 until they are restarted too. Docker does
# not detect or repair this.
#
# So the proxy is never restarted alone. Dependents are restarted after it, in
# dependency order, and the result is verified.
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
compose="docker compose -f $root/compose.production.yml"

# Restart order matters: data services first, then the API, then the workers
# that will not start cleanly without it.
dependents=(postgres redis localstack api web publisher search files)

echo "== restarting proxy"
$compose restart proxy

echo "== reattaching dependents to the new network namespace"
$compose restart "${dependents[@]}"

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
# Probed from inside the proxy namespace, because that is exactly what the
# orphaned-namespace failure breaks: the containers stay healthy on their own
# healthchecks while the proxy can no longer reach any of them.
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
  echo "The stack did not come back. Dependents are probably still attached to a"
  echo "dead namespace. Recover with:"
  echo "  $compose up -d --force-recreate"
  exit 1
fi

echo "restart complete"
