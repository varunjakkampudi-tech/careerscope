#!/usr/bin/env bash
# Applies pending migrations on the deployed host and reports the plan for the
# publisher's hot query, which polls a table that only grows.
set -euo pipefail

cd /opt/careerscope/infra/v3
docker compose -f compose.production.yml --env-file .env run --rm --no-deps \
  bootstrap node /app/v2/bootstrap.mjs

echo "== indexes present"
docker exec careerscope-postgres-1 psql -U careerscope -d careerscope -tAc \
  "SELECT indexname FROM pg_indexes
   WHERE indexname IN ('outbox_published_created','execution_status_lease','session_owner')
   ORDER BY 1"

echo "== publisher query plan"
docker exec careerscope-postgres-1 psql -U careerscope -d careerscope -tAc \
  "EXPLAIN SELECT id FROM outbox_events WHERE published_at IS NULL ORDER BY created_at LIMIT 20"
