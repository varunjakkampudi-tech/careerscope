#!/usr/bin/env bash
# Proves the deployed image refuses the legacy queue setting names instead of
# silently running a topology its configuration does not describe.
set -euo pipefail

# The production Redis instances require a password (compose.production.yml sets
# --requirepass), so every Redis URL below carries it. Export REDIS_PASSWORD
# (the same value as in infra/.env) before running this script.
if [ -z "${REDIS_PASSWORD:-}" ]; then
  echo "REDIS_PASSWORD is not set: export it (the value from infra/.env) before running check-queue-contract.sh" >&2
  exit 1
fi

common=(
  -e DATABASE_URL=postgres://x@127.0.0.1/y
  -e "REDIS_URL=redis://:${REDIS_PASSWORD}@127.0.0.1:6379"
  -e "QUEUE_REDIS_URL=redis://:${REDIS_PASSWORD}@127.0.0.1:6380"
  -e APP_ORIGIN=https://careerscope.tech
)

probe='import("@careerscope/core").then((m) => { try { const c = m.configuration(); console.log("accepted transport=" + c.SEARCH_QUEUE_TRANSPORT); } catch (e) { console.log("refused: " + e.message.slice(0, 100)); } });'

echo "== default (no transport set)"
docker run --rm "${common[@]}" careerscope:v3 node -e "$probe"

echo "== legacy QUEUE_TRANSPORT"
docker run --rm "${common[@]}" -e QUEUE_TRANSPORT=bullmq careerscope:v3 node -e "$probe"

echo "== queue cannot share the rate-limit Redis"
docker run --rm "${common[@]}" -e "QUEUE_REDIS_URL=redis://:${REDIS_PASSWORD}@127.0.0.1:6379" careerscope:v3 node -e "$probe"

echo "== new name, bullmq without a separate redis"
docker run --rm "${common[@]}" -e SEARCH_QUEUE_TRANSPORT=bullmq careerscope:v3 node -e "$probe"

echo "== files worker transport log"
docker logs careerscope-files-1 2>&1 | grep -i 'files worker transport' | tail -1 || echo "(no transport line yet)"
