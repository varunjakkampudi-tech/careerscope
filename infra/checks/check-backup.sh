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
files_name="careerscope-backup-files-$$"
trap 'docker rm -f "$pg_name" "$files_name" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
# MSYS (Git Bash on Windows) rewrites absolute POSIX paths in arguments, which would corrupt
# the in-container paths passed to docker exec. This is a no-op on Linux.
export MSYS_NO_PATHCONV=1

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
  postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94 >/dev/null

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

echo "== starting a disposable stand-in for the files container (private volume)"
key_hex=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
docker run -d --name "$files_name" --entrypoint sleep \
  postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94 600 >/dev/null
docker exec "$files_name" sh -c "mkdir -p /private/objects && umask 077 \
  && printf 'ciphertext-one' >/private/objects/o1_r1_h1.bin \
  && head -c 4096 /dev/urandom >/private/objects/o2_r2_h2.bin \
  && printf '%s' '$key_hex' >/private/encryption.key"

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
  BACKUP_FILES_CONTAINER="${CHECK_FILES_CONTAINER-$files_name}" \
  BACKUP_KEY_DIR="${CHECK_KEY_DIR-$work/keys}" \
  BACKUP_CURL_BIN="$work/curl" \
  BACKUP_WEBHOOK_URL="https://hooks.example.test/alert" \
  FAKE_CALLS_FILE="$work/webhook-calls" \
  "$@" bash "$dir/../host/backup.sh"
}

echo "== a real backup: dump, restore-verify, promote"
rm -rf "$work/backups" "$work/keys"; : >"$work/webhook-calls"
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

echo "== resume objects and the key are backed up as separate artefacts"
resumes_tar=$(find "$work/backups" -maxdepth 1 -name 'careerscope-resumes-*.tar')
key_copy=$(find "$work/keys" -maxdepth 1 -name 'careerscope-resume-key-*.key')
check "one resume archive promoted" "$(printf '%s\n' "$resumes_tar" | grep -c .)" "1"
check "one key copy promoted, in its own directory" "$(printf '%s\n' "$key_copy" | grep -c .)" "1"
check "the archive does not contain the key" "$(tar -tf "$resumes_tar" | grep -c 'encryption.key')" "0"
check "the archive holds both objects" "$(tar -tf "$resumes_tar" | grep -c '\.bin$')" "2"
check "status records resumes ok and the object count" "$(grep -c '^RESUMES=ok' "$work/backups/last-status")-$(grep -c '^RESUME_OBJECTS=2' "$work/backups/last-status")" "1-1"
check "key copy is root-restrictable (0600)" "$(stat -c '%a' "$key_copy" 2>/dev/null || stat -f '%Lp' "$key_copy")" "600"
check "key copy equals the live key" "$(tr -d '\n' <"$key_copy")" "$key_hex"
check "no staging files left behind (archive or key)" "$(find "$work/backups" -name '.staging-*' | wc -l | tr -d ' ')" "0"

echo "== restoring the archive and key reproduces the original bytes"
mkdir -p "$work/restore"
restore_start=$(date +%s)
tar -xf "$resumes_tar" -C "$work/restore"
restore_secs=$(( $(date +%s) - restore_start ))
for object in o1_r1_h1.bin o2_r2_h2.bin; do
  original=$(docker exec "$files_name" sha256sum "/private/objects/$object" | cut -d' ' -f1)
  restored=$(sha256sum "$work/restore/objects/$object" | cut -d' ' -f1)
  check "restored $object is byte-identical" "$restored" "$original"
done
echo "(fixture resume extraction took ${restore_secs}s)"

echo "== an unreadable key fails the whole backup and promotes nothing new"
sleep 1.1
docker exec "$files_name" sh -c "printf 'not-a-hex-key' >/private/encryption.key"
: >"$work/webhook-calls"
key_exit=0
out=$(run_backup 2>&1) || key_exit=$?
check "bad key returns nonzero" "$key_exit" "1"
check "bad key reports failure" "$(printf '%s' "$out" | grep -c 'backup FAILED')" "1"
check "no new dump, archive or key was promoted" "$(find "$work/backups" "$work/keys" -type f \( -name 'careerscope-*.dump' -o -name 'careerscope-resumes-*.tar' -o -name 'careerscope-resume-key-*.key' \) | wc -l | tr -d ' ')" "3"
check "no staging files after a key failure" "$(find "$work/backups" -name '.staging-*' | wc -l | tr -d ' ')" "0"
check "key failure sends one alert" "$(wc -l <"$work/webhook-calls" | tr -d ' ')" "1"
docker exec "$files_name" sh -c "printf '%s' '$key_hex' >/private/encryption.key"

echo "== a missing files container fails the backup instead of silently skipping resumes"
sleep 1.1
miss_exit=0
out=$(CHECK_FILES_CONTAINER="no-such-container-$$" run_backup 2>&1) || miss_exit=$?
check "missing files container returns nonzero" "$miss_exit" "1"

echo "== a key directory inside the backup directory is refused"
sleep 1.1
dumps_before=$(find "$work/backups" -maxdepth 1 -name 'careerscope-*.dump' | wc -l | tr -d ' ')
inside_exit=0
out=$(CHECK_KEY_DIR="$work/backups/keys" run_backup 2>&1) || inside_exit=$?
check "key dir inside backup dir returns nonzero" "$inside_exit" "1"
check "key dir inside backup dir explains the refusal" "$(printf '%s' "$out" | grep -c 'is inside BACKUP_DIR')" "1"
check "key dir inside backup dir records failed status" "$(grep -c '^STATUS=failed' "$work/backups/last-status")" "1"
check "key dir inside backup dir promotes nothing" "$(find "$work/backups" -maxdepth 1 -name 'careerscope-*.dump' | wc -l | tr -d ' ')" "$dumps_before"
check "key dir inside backup dir is not created" "$([ -e "$work/backups/keys" ] && echo yes || echo no)" "no"
sleep 1.1
dotdot_exit=0
out=$(CHECK_KEY_DIR="$work/backups/../backups/keys" run_backup 2>&1) || dotdot_exit=$?
check "a .. path into the backup dir is also refused" "$dotdot_exit" "1"

echo "== skipping resumes fails closed unless explicitly allowed"
sleep 1.1
skip_exit=0
out=$(CHECK_FILES_CONTAINER="" run_backup 2>&1) || skip_exit=$?
check "empty files container without opt-in returns nonzero" "$skip_exit" "1"
check "empty files container without opt-in records failed status" "$(grep -c '^STATUS=failed' "$work/backups/last-status")" "1"
check "empty files container without opt-in promotes nothing" "$(find "$work/backups" -maxdepth 1 -name 'careerscope-*.dump' | wc -l | tr -d ' ')" "$dumps_before"

echo "== skipping resumes with BACKUP_ALLOW_SKIP_RESUMES=1 is explicit and loud"
sleep 1.1
out=$(CHECK_FILES_CONTAINER="" BACKUP_ALLOW_SKIP_RESUMES=1 run_backup 2>&1)
check "warns that resumes are not backed up" "$(printf '%s' "$out" | grep -c 'NOT backed up')" "1"
check "status records resumes skipped" "$(grep -c '^RESUMES=skipped' "$work/backups/last-status")" "1"
# remove the skip run's dump so later counts only see full backups
latest_dump=$(find "$work/backups" -maxdepth 1 -name 'careerscope-*.dump' | sort | tail -1)
rm -f "$latest_dump"

echo "== invalid retention configuration fails before changing backup state"
touch -d '30 days ago' "$work/backups/careerscope-invalid-retention.dump" 2>/dev/null \
  || touch -t "$(date -v-30d +%Y%m%d0000 2>/dev/null || date -d '30 days ago' +%Y%m%d0000)" "$work/backups/careerscope-invalid-retention.dump"
status_before=$(sha256sum "$work/backups/last-status" | cut -d' ' -f1)
dump_count_before=$(find "$work/backups" -maxdepth 1 -name 'careerscope-*.dump' | wc -l | tr -d ' ')
retention_exit=0
BACKUP_RETENTION_DAYS="1;touch $work/retention-canary" run_backup >"$work/invalid-retention-output" 2>&1 || retention_exit=$?
check "invalid retention config returns nonzero" "$retention_exit" "1"
check "invalid retention config fails closed" "$(grep -c 'must be a positive integer' "$work/invalid-retention-output")" "1"
check "invalid retention config preserves dump count" "$(find "$work/backups" -maxdepth 1 -name 'careerscope-*.dump' | wc -l | tr -d ' ')" "$dump_count_before"
check "invalid retention config leaves prior status unchanged" "$(sha256sum "$work/backups/last-status" | cut -d' ' -f1)" "$status_before"
[ ! -e "$work/retention-canary" ] || { echo "FAIL invalid retention executed shell content"; failures=$((failures + 1)); }
rm -f "$work/backups/careerscope-invalid-retention.dump"

echo "== a failing dump does not touch the last good file or promote a new one"
sleep 1.1 # ensure the next timestamp-stamped filename actually differs
: >"$work/webhook-calls"
backup_exit=0
out=$(BACKUP_DB_NAME=does_not_exist run_backup 2>&1) || backup_exit=$?
check "failed backup returns nonzero to systemd" "$backup_exit" "1"
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
