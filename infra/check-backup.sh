#!/usr/bin/env bash
# Proves backup.sh's dump-verify-promote pipeline against a REAL, throwaway
# Postgres container - not a stub. AC2 is explicit: "the restore is
# exercised, not documented - a dump nobody has restored is a guess." A stub
# that only proves bash control flow would not actually prove that, so this
# test spins up a disposable postgres:17.6-alpine container, seeds it with
# real tables and rows, and runs the real pg_dump/pg_restore/sanity-query
# pipeline against it end to end.
#
# The webhook-alerting side is still verified against a stub curl (same
# technique as check-monitoring.sh), since that part is pure bash logic and a
# real webhook adds nothing a stub doesn't already prove.
set -euo pipefail

dir="$(cd "$(dirname "$0")" && pwd)"
work=$(mktemp -d)
pg_name="careerscope-backup-check-$$"
trap 'docker rm -f "$pg_name" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

failures=0
check() {
  if [ "$2" = "$3" ]; then
    echo "PASS $1"
  else
    echo "FAIL $1 :: expected '$3', got '$2'"
    failures=$((failures + 1))
  fi
}

echo "== starting a disposable postgres for this test only"
docker run -d --name "$pg_name" \
  -e POSTGRES_PASSWORD=test -e POSTGRES_USER=careerscope -e POSTGRES_DB=careerscope \
  postgres:17.6-alpine >/dev/null

ready=0
for _ in $(seq 1 30); do
  # The official image starts a temporary Unix-socket-only server during
  # initdb, then stops it before starting the real TCP listener. A socket
  # pg_isready can therefore succeed during that shutdown window and race the
  # seed query. TCP readiness is true only for the final server we will test.
  if docker exec "$pg_name" pg_isready -h 127.0.0.1 -U careerscope -d careerscope >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" != 1 ]; then
  echo "disposable PostgreSQL never became ready" >&2
  docker logs "$pg_name" >&2 || true
  exit 1
fi
docker exec "$pg_name" psql -U careerscope -d careerscope -c \
  "CREATE TABLE widgets (id serial primary key, name text); INSERT INTO widgets (name) VALUES ('a'), ('b'), ('c');" >/dev/null

cat >"$work/curl" <<'EOF'
#!/usr/bin/env bash
is_post=0
for arg in "$@"; do
  if [ "$arg" = "-X" ]; then is_post=1; fi
done
if [ "$is_post" = 1 ]; then
  echo "post" >>"$FAKE_CALLS_FILE"
  exit 0
fi
exit 1
EOF
chmod +x "$work/curl"

run_backup() {
  BACKUP_DB_CONTAINER="$pg_name" \
  BACKUP_DIR="$work/backups" \
  BACKUP_CURL_BIN="$work/curl" \
  BACKUP_WEBHOOK_URL="https://hooks.example.test/alert" \
  FAKE_CALLS_FILE="$work/webhook-calls" \
  "$@" bash "$dir/backup.sh"
}

echo "== a real backup: dump, restore-verify, promote"
rm -rf "$work/backups"; : >"$work/webhook-calls"
out=$(run_backup)
check "reports ok" "$(printf '%s' "$out" | grep -c '^backup ok:')" "1"
check "reports the real table count from the restored copy" "$(printf '%s' "$out" | grep -o 'tables verified' | head -1)" "tables verified"
check "one dump file promoted" "$(find "$work/backups" -maxdepth 1 -name 'careerscope-*.dump' | wc -l | tr -d ' ')" "1"
check "no staging file left behind" "$(find "$work/backups" -maxdepth 1 -name '.staging-*' | wc -l | tr -d ' ')" "0"
check "status file says ok" "$(grep -c '^STATUS=ok' "$work/backups/last-status")" "1"
check "promoted dump is root-restrictable (0600)" "$(stat -c '%a' "$(find "$work/backups" -maxdepth 1 -name 'careerscope-*.dump')" 2>/dev/null || stat -f '%Lp' "$(find "$work/backups" -maxdepth 1 -name 'careerscope-*.dump')")" "600"
check "backup dir is root-only (0700)" "$(stat -c '%a' "$work/backups" 2>/dev/null || stat -f '%Lp' "$work/backups")" "700"
check "no scratch verification database left behind" "$(docker exec "$pg_name" psql -U careerscope -d postgres -tAc "select count(*) from pg_database where datname='careerscope_backup_verify'" | tr -d ' ')" "0"
check "success does not send a webhook alert" "$(wc -l <"$work/webhook-calls" | tr -d ' ')" "0"
first_dump=$(find "$work/backups" -maxdepth 1 -name 'careerscope-*.dump')
first_dump_sum=$(sha256sum "$first_dump" | cut -d' ' -f1)

echo "== the restored copy actually has the seeded rows, not just a schema"
docker exec "$pg_name" psql -U careerscope -d postgres -tAc "CREATE DATABASE careerscope_recheck" >/dev/null
docker exec -i "$pg_name" pg_restore -U careerscope -d careerscope_recheck --no-owner <"$first_dump" >/dev/null 2>&1 || true
row_count=$(docker exec "$pg_name" psql -U careerscope -d careerscope_recheck -tAc "SELECT count(*) FROM widgets" 2>/dev/null | tr -d ' ')
check "the dump this test produced restores the real seeded rows elsewhere" "$row_count" "3"
docker exec "$pg_name" psql -U careerscope -d postgres -tAc "DROP DATABASE careerscope_recheck" >/dev/null 2>&1 || true

echo "== a failing dump does not touch the last good file or promote a new one"
sleep 1.1 # ensure the next timestamp-stamped filename actually differs
: >"$work/webhook-calls"
out=$(BACKUP_DB_NAME=does_not_exist run_backup 2>&1 || true)
check "reports failure" "$(printf '%s' "$out" | grep -c 'backup FAILED')" "1"
check "still exactly one promoted dump (the first one, untouched)" "$(find "$work/backups" -maxdepth 1 -name 'careerscope-*.dump' | wc -l | tr -d ' ')" "1"
check "the untouched dump is byte-identical to the earlier good one" "$(sha256sum "$(find "$work/backups" -maxdepth 1 -name 'careerscope-*.dump')" | cut -d' ' -f1)" "$first_dump_sum"
check "status file now says failed, not ok" "$(grep -c '^STATUS=failed' "$work/backups/last-status")" "1"
check "no leftover staging file from the failed attempt" "$(find "$work/backups" -maxdepth 1 -name '.staging-*' | wc -l | tr -d ' ')" "0"
check "failure sends exactly one webhook alert" "$(wc -l <"$work/webhook-calls" | tr -d ' ')" "1"

echo "== retention deletes only old, real, promoted dumps"
touch -d '30 days ago' "$work/backups/careerscope-old-fake.dump" 2>/dev/null \
  || touch -t "$(date -v-30d +%Y%m%d0000 2>/dev/null || date -d '30 days ago' +%Y%m%d0000)" "$work/backups/careerscope-old-fake.dump"
: >"$work/webhook-calls"
BACKUP_RETENTION_DAYS=14 run_backup >/dev/null
check "the 30-day-old fake dump was cleaned up by retention" "$(find "$work/backups" -maxdepth 1 -name 'careerscope-old-fake.dump' | wc -l | tr -d ' ')" "0"
# Two real dumps exist by this point (the first successful one, plus this
# section's own successful run) - retention must keep both, only the 30-day
# fake one was old enough to remove.
check "both real dumps (old enough to keep) survive retention" "$(find "$work/backups" -maxdepth 1 -name 'careerscope-*.dump' | wc -l | tr -d ' ')" "2"

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all backup checks passed"
