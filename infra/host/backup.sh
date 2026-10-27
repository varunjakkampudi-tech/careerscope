#!/usr/bin/env bash
# Host-native scheduled database backup for CS-25: "no scheduled database
# dump exists, even on the host."
#
# Every run does three things, in order, and only promotes the dump to
# "latest" if all three succeed:
#   1. dump   - pg_dump, custom format, captured on the host via docker exec
#   2. verify - restore that exact dump into a disposable scratch database
#               inside the same container, run one sanity query against it,
#               then drop it. This is what makes the restore *exercised*
#               rather than merely documented (AC2): every single scheduled
#               run proves its own dump is actually restorable, not just
#               that pg_dump exited zero.
#   3. promote - atomically rename the verified dump into place and apply
#               retention. A dump that fails step 1 or 2 is deleted, not
#               promoted, and the last known-good file is left exactly as it
#               was (AC3: a failed dump must not look like a current one).
#
# Runs on the host, independent of the container it backs up, the same way
# infra/host/monitor.sh does - via careerscope-backup.timer.
set -euo pipefail

BACKUP_DB_CONTAINER=${BACKUP_DB_CONTAINER:-careerscope-postgres-1}
BACKUP_DB_NAME=${BACKUP_DB_NAME:-careerscope}
BACKUP_DB_USER=${BACKUP_DB_USER:-careerscope}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/careerscope}
BACKUP_RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-14}
BACKUP_WEBHOOK_URL=${BACKUP_WEBHOOK_URL:-${MONITOR_WEBHOOK_URL:-}}
BACKUP_VERIFY_DB=${BACKUP_VERIFY_DB:-careerscope_backup_verify}
# Resume objects (AES-256-GCM ciphertext) and the key that decrypts them live in the
# private volume, mounted in the files container. They are backed up as two separate
# artefacts: the ciphertext archive in BACKUP_DIR and the key in BACKUP_KEY_DIR, so a
# stolen archive alone is unreadable. Set BACKUP_KEY_DIR to a different mount if possible.
# BACKUP_FILES_CONTAINER set to the empty string skips resumes (loudly); it is never skipped by default.
BACKUP_FILES_CONTAINER=${BACKUP_FILES_CONTAINER-careerscope-files-1}
BACKUP_PRIVATE_DIR=${BACKUP_PRIVATE_DIR:-/private}
BACKUP_KEY_DIR=${BACKUP_KEY_DIR:-$BACKUP_DIR/keys}
DOCKER_BIN=${BACKUP_DOCKER_BIN:-docker}
CURL_BIN=${BACKUP_CURL_BIN:-curl}
CURL_TIMEOUT=${BACKUP_CURL_TIMEOUT:-10}

if [[ ! "$BACKUP_RETENTION_DAYS" =~ ^[1-9][0-9]*$ ]]; then
  echo "BACKUP_RETENTION_DAYS must be a positive integer; refusing to run" >&2
  exit 1
fi

# BACKUP_VERIFY_DB is interpolated directly into SQL (Postgres identifiers
# cannot be bind-parameterized the way values can). It is root-config-only
# today, so there is no reachable injection path, but validating it removes
# that assumption entirely rather than resting on it (Security review, P3).
if [[ ! "$BACKUP_VERIFY_DB" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  echo "BACKUP_VERIFY_DB must be a plain identifier; refusing to run" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR" "$BACKUP_KEY_DIR"
chmod 0700 "$BACKUP_DIR" "$BACKUP_KEY_DIR"

# Fail fast and clearly if a manual run overlaps the timer's own run, rather
# than letting both race for the same scratch database (Security review,
# P3: a losing racer would otherwise discard its own good dump and report a
# spurious failure - never anything unsafe, but confusing and wasteful).
# Best-effort: flock is standard on Ubuntu (util-linux) but is not something
# a missing-tool situation should turn into a backup outage over, so a host
# without it just skips locking rather than refusing to run at all.
lock_fd=200
if command -v flock >/dev/null 2>&1; then
  exec 200>"$BACKUP_DIR/.lock"
  if ! flock -n "$lock_fd"; then
    echo "another backup run is already in progress; not starting a second one" >&2
    exit 0
  fi
else
  echo "flock not available; proceeding without overlap protection" >&2
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
staging="$BACKUP_DIR/.staging-$stamp.dump"
final="$BACKUP_DIR/careerscope-$stamp.dump"
staging_resumes="$BACKUP_DIR/.staging-resumes-$stamp.tar"
final_resumes="$BACKUP_DIR/careerscope-resumes-$stamp.tar"
staging_key="$BACKUP_KEY_DIR/.staging-key-$stamp.key"
final_key="$BACKUP_KEY_DIR/careerscope-resume-key-$stamp.key"
status_file="$BACKUP_DIR/last-status"

cleanup_scratch() {
  "$DOCKER_BIN" exec "$BACKUP_DB_CONTAINER" psql -U "$BACKUP_DB_USER" -d postgres \
    -tAc "DROP DATABASE IF EXISTS $BACKUP_VERIFY_DB" >/dev/null 2>&1 || true
}
trap cleanup_scratch EXIT

fail() {
  rm -f "$staging" "$staging_resumes" "$staging_key"
  echo "backup FAILED: $1" >&2
  cat >"$status_file" <<EOF
STATUS=failed
AT=$stamp
REASON=$1
EOF
  send_alert "CareerScope backup FAILED: $1"
  # Preserve the failed status/alert while letting the oneshot systemd unit
  # report failure to the independent scheduler-health monitor.
  exit 1
}

json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=$(printf '%s' "$s" | tr -d '\000-\037')
  printf '%s' "$s"
}

send_alert() {
  local message=$1
  if [ -z "$BACKUP_WEBHOOK_URL" ]; then
    echo "no BACKUP_WEBHOOK_URL (or MONITOR_WEBHOOK_URL) configured; alert only recorded to this log" >&2
    return 0
  fi
  if [[ "$BACKUP_WEBHOOK_URL" != https://* ]]; then
    echo "BACKUP_WEBHOOK_URL is not https; refusing to send an alert in cleartext" >&2
    return 0
  fi
  local escaped; escaped=$(json_escape "$message")
  "$CURL_BIN" -fsS --max-time "$CURL_TIMEOUT" -X POST -H 'Content-Type: application/json' \
    -d "{\"text\":\"$escaped\",\"content\":\"$escaped\"}" "$BACKUP_WEBHOOK_URL" >/dev/null \
    && echo "alert sent to webhook (${BACKUP_WEBHOOK_URL:0:20}...)" \
    || echo "alert webhook POST failed (${BACKUP_WEBHOOK_URL:0:20}...)" >&2
}

# -- 1. dump --------------------------------------------------------------
if ! "$DOCKER_BIN" exec "$BACKUP_DB_CONTAINER" pg_dump -U "$BACKUP_DB_USER" -Fc "$BACKUP_DB_NAME" \
  >"$staging" 2>"$BACKUP_DIR/.last-dump-stderr"; then
  fail "pg_dump exited non-zero, see $BACKUP_DIR/.last-dump-stderr"
fi
if [ ! -s "$staging" ]; then
  fail "pg_dump produced an empty file"
fi

# -- 2. verify: an actual restore, not just a structural listing ----------
cleanup_scratch
if ! "$DOCKER_BIN" exec "$BACKUP_DB_CONTAINER" psql -U "$BACKUP_DB_USER" -d postgres \
  -tAc "CREATE DATABASE $BACKUP_VERIFY_DB" >/dev/null 2>&1; then
  fail "could not create scratch verification database"
fi
if ! "$DOCKER_BIN" exec -i "$BACKUP_DB_CONTAINER" pg_restore -U "$BACKUP_DB_USER" \
  -d "$BACKUP_VERIFY_DB" --no-owner <"$staging" >/dev/null 2>"$BACKUP_DIR/.last-restore-stderr"; then
  fail "restore into the scratch database failed, see $BACKUP_DIR/.last-restore-stderr"
fi
# A real sanity query, not just "pg_restore exited zero" - proves the
# restored database actually answers a query the application depends on.
table_count=$("$DOCKER_BIN" exec "$BACKUP_DB_CONTAINER" psql -U "$BACKUP_DB_USER" -d "$BACKUP_VERIFY_DB" \
  -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'" 2>/dev/null || echo 0)
if [ "${table_count:-0}" -lt 1 ] 2>/dev/null; then
  fail "restored scratch database has no tables; dump is not usable"
fi
cleanup_scratch

# -- 2b. resume objects and the key ---------------------------------------
# Taken AFTER the dump on purpose: an upload that lands between the two leaves an orphan
# object (harmless), whereas the opposite order could leave a database row whose object is
# missing from the archive.
resumes_state=skipped
resume_objects=0
if [ -n "$BACKUP_FILES_CONTAINER" ]; then
  if ! "$DOCKER_BIN" exec "$BACKUP_FILES_CONTAINER" tar -C "$BACKUP_PRIVATE_DIR" -cf - objects \
    >"$staging_resumes" 2>"$BACKUP_DIR/.last-resumes-stderr"; then
    fail "resume object archive failed, see $BACKUP_DIR/.last-resumes-stderr"
  fi
  if [ ! -s "$staging_resumes" ] || ! tar -tf "$staging_resumes" >"$BACKUP_DIR/.last-resumes-list" 2>/dev/null; then
    fail "resume object archive is empty or unreadable"
  fi
  resume_objects=$(grep -c '\.bin$' "$BACKUP_DIR/.last-resumes-list" || true)
  if ! "$DOCKER_BIN" exec "$BACKUP_FILES_CONTAINER" cat "$BACKUP_PRIVATE_DIR/encryption.key" \
    >"$staging_key" 2>/dev/null; then
    fail "could not read the resume encryption key"
  fi
  # The key must be exactly 64 hex characters; anything else could not decrypt the archive.
  if ! [[ "$(tr -d '\n\r' <"$staging_key")" =~ ^[a-f0-9]{64}$ ]]; then
    fail "resume encryption key file is not a 64-character hex key"
  fi
  resumes_state=ok
else
  echo "WARNING: BACKUP_FILES_CONTAINER is empty; resume objects and the key are NOT backed up" >&2
fi

# -- 3. promote and retain --------------------------------------------------
mv -f "$staging" "$final"
chmod 0600 "$final"
if [ "$resumes_state" = ok ]; then
  mv -f "$staging_resumes" "$final_resumes"
  mv -f "$staging_key" "$final_key"
  chmod 0600 "$final_resumes" "$final_key"
fi
{
  echo "STATUS=ok"
  echo "AT=$stamp"
  echo "FILE=$final"
  echo "TABLES=$table_count"
  echo "RESUMES=$resumes_state"
  if [ "$resumes_state" = ok ]; then
    echo "RESUMES_FILE=$final_resumes"
    echo "RESUME_KEY_FILE=$final_key"
    echo "RESUME_OBJECTS=$resume_objects"
  fi
} >"$status_file"
echo "backup ok: $final ($table_count tables verified by restore; resumes: $resumes_state, $resume_objects objects)"

# Retention: delete anything older than the window, but only real, promoted
# dumps - never a .staging file mid-write, and never touch last-status.
find "$BACKUP_DIR" -maxdepth 1 \( -name 'careerscope-*.dump' -o -name 'careerscope-resumes-*.tar' \) \
  -mtime "+$BACKUP_RETENTION_DAYS" -delete
find "$BACKUP_KEY_DIR" -maxdepth 1 -name 'careerscope-resume-key-*.key' -mtime "+$BACKUP_RETENTION_DAYS" -delete

exit 0
