#!/usr/bin/env bash
# Proves the deployed image refuses the legacy queue setting names instead of
# silently running a topology its configuration does not describe.
set -euo pipefail

common=(
  -e DATABASE_URL=postgres://x@127.0.0.1/y
  -e REDIS_URL=redis://127.0.0.1:6379
  -e LOCAL_AWS_ENDPOINT=http://127.0.0.1:4566
  -e APP_ORIGIN=https://careerscope.tech
)

probe='import("@careerscope/core").then((m) => { try { const c = m.configuration(); console.log("accepted transport=" + c.SEARCH_QUEUE_TRANSPORT); } catch (e) { console.log("refused: " + e.message.slice(0, 100)); } });'

echo "== default (no transport set)"
docker run --rm "${common[@]}" careerscope:v3 node -e "$probe"

echo "== legacy QUEUE_TRANSPORT"
docker run --rm "${common[@]}" -e QUEUE_TRANSPORT=bullmq careerscope:v3 node -e "$probe"

echo "== legacy QUEUE_REDIS_URL"
docker run --rm "${common[@]}" -e QUEUE_REDIS_URL=redis://127.0.0.1:6380 careerscope:v3 node -e "$probe"

echo "== new name, bullmq without a separate redis"
docker run --rm "${common[@]}" -e SEARCH_QUEUE_TRANSPORT=bullmq careerscope:v3 node -e "$probe"

echo "== files worker transport log"
docker logs careerscope-files-1 2>&1 | grep -i 'files worker transport' | tail -1 || echo "(no transport line yet)"
