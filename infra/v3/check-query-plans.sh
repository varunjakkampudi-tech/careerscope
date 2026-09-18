#!/usr/bin/env bash
# Reports whether the hot-path indexes exist and whether the publisher's poll
# actually uses one. Run after applying migrations on the deployed host.
set -euo pipefail

psql() { docker exec careerscope-postgres-1 psql -U careerscope -d careerscope -tAc "$1"; }

echo "== indexes present"
psql "SELECT indexname FROM pg_indexes
      WHERE indexname IN ('outbox_published_created','execution_status_lease','session_owner')
      ORDER BY 1"

echo "== publisher poll plan"
psql "EXPLAIN SELECT id FROM outbox_events WHERE published_at IS NULL ORDER BY created_at LIMIT 20"

echo "== lease reclaim plan"
psql "EXPLAIN SELECT id FROM command_executions WHERE status = 'running' AND lease_until < now()"

echo "== session revoke plan"
psql "EXPLAIN DELETE FROM sessions WHERE owner_id = '00000000-0000-0000-0000-000000000000'"
