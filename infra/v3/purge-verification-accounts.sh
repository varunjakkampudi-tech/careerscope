#!/usr/bin/env bash
# Removes accounts created by the live verification scripts. Only the throwaway
# verify-* namespace is matched. Deletion order follows the foreign key graph;
# lead_history and resume_results hang off owned rows rather than off users, so
# they have to go first.
set -euo pipefail

docker exec -i careerscope-postgres-1 psql -U careerscope -d careerscope -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
CREATE TEMP TABLE purge_owners ON COMMIT DROP AS
  SELECT id FROM users WHERE email LIKE 'verify-%';

DELETE FROM lead_history WHERE lead_id IN
  (SELECT id FROM saved_leads WHERE owner_id IN (SELECT id FROM purge_owners));
DELETE FROM saved_leads WHERE owner_id IN (SELECT id FROM purge_owners);
DELETE FROM run_events WHERE owner_id IN (SELECT id FROM purge_owners);
DELETE FROM search_jobs WHERE owner_id IN (SELECT id FROM purge_owners);
DELETE FROM search_runs WHERE owner_id IN (SELECT id FROM purge_owners);
DELETE FROM resume_results WHERE owner_id IN (SELECT id FROM purge_owners);
DELETE FROM resume_uploads WHERE owner_id IN (SELECT id FROM purge_owners);
DELETE FROM candidate_profiles WHERE owner_id IN (SELECT id FROM purge_owners);
DELETE FROM sessions WHERE owner_id IN (SELECT id FROM purge_owners);
DELETE FROM users WHERE id IN (SELECT id FROM purge_owners);
COMMIT;
SQL

docker exec careerscope-postgres-1 psql -U careerscope -d careerscope -tAc \
  "SELECT 'remaining_users=' || count(*) FROM users"
