#!/usr/bin/env bash
# Removes accounts created by the live verification scripts.
#
# The match is the verify-* local part at the ONE domain the operator names. The domain is
# required and has no default, so a real owner whose address merely starts with "verify-" on
# another domain is never matched (S1-F041). The match count is printed before anything is
# deleted. Deletion order follows the foreign key graph; lead_history and resume_results hang off
# owned rows rather than off users, so they have to go first.
#
# Usage: PURGE_EMAIL_DOMAIN=<domain> bash host/purge-verification-accounts.sh
set -euo pipefail

domain=${PURGE_EMAIL_DOMAIN:?PURGE_EMAIL_DOMAIN is required: the one domain the throwaway accounts use}
if ! [[ "$domain" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
  echo "PURGE_EMAIL_DOMAIN must be a plain lower-case domain such as example.invalid" >&2
  exit 2
fi
pattern="verify-%@${domain}"

matching=$(docker exec careerscope-postgres-1 psql -U careerscope -d careerscope -tAc \
  "SELECT count(*) FROM users WHERE email LIKE '${pattern}'")
echo "accounts matching ${pattern}: ${matching}"
if [ "$matching" = 0 ]; then
  exit 0
fi

docker exec -i careerscope-postgres-1 psql -U careerscope -d careerscope -v ON_ERROR_STOP=1 \
  -v pattern="$pattern" <<'SQL'
BEGIN;
CREATE TEMP TABLE purge_owners ON COMMIT DROP AS
  SELECT id FROM users WHERE email LIKE :'pattern';

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
