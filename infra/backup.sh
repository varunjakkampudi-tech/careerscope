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
# infra/monitor.sh does - via careerscope-backup.timer.
set -euo pipefail

BACKUP_DB_CONTAINER=${BACKUP_DB_CONTAINER:-careerscope-postgres-1}
BACKUP_DB_NAME=${BACKUP_DB_NAME:-careerscope}
BACKUP_DB_USER=${BACKUP_DB_USER:-careerscope}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/careerscope}
BACKUP_RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-14}
BACKUP_WEBHOOK_URL=${BACKUP_WEBHOOK_URL:-${MONITOR_WEBHOOK_URL:-}}
BACKUP_VERIFY_DB=${BACKUP_VERIFY_DB:-careerscope_backup_verify}
DOCKER_BIN=${BACKUP_DOCKER_BIN:-docker}
CURL_BIN=${BACKUP_CURL_BIN:-curl}
CURL_TIMEOUT=${BACKUP_CURL_TIMEOUT:-10}

# BACKUP_VERIFY_DB is interpolated directly into SQL (Postgres identifiers
# cannot be bind-parameterized the way values can). It is root-config-only
# today, so there is no reachable injection path, but validating it removes
# that assumption entirely rather than resting on it (Security review, P3).
if [[ ! "$BACKUP_VERIFY_DB" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  echo "BACKUP_VERIFY_DB must be a plain identifier; refusing to run" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"

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
status_file="$BACKUP_DIR/last-status"

cleanup_scratch() {
  "$DOCKER_BIN" exec "$BACKUP_DB_CONTAINER" psql -U "$BACKUP_DB_USER" -d postgres \
    -tAc "DROP DATABASE IF EXISTS $BACKUP_VERIFY_DB" >/dev/null 2>&1 || true
}
trap cleanup_scratch EXIT

fail() {
  rm -f "$staging"
  echo "backup FAILED: $1" >&2
  cat >"$status_file" <<EOF
STATUS=failed
AT=$stamp
REASON=$1
EOF
  send_alert "CareerScope backup FAILED: $1"
  exit 0
  # Exit 0 deliberately: this is an observability tool. A failed dump is
  # reported through the alert and the status file (AC3), not through the
  # exit code of a systemd unit nobody is watching for that specifically.
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

# -- 3. promote and retain --------------------------------------------------
mv -f "$staging" "$final"
chmod 0600 "$final"
cat >"$status_file" <<EOF
STATUS=ok
AT=$stamp
FILE=$final
TABLES=$table_count
EOF
echo "backup ok: $final ($table_count tables verified by restore)"

# Retention: delete anything older than the window, but only real, promoted
# dumps - never a .staging file mid-write, and never touch last-status.
find "$BACKUP_DIR" -maxdepth 1 -name 'careerscope-*.dump' -mtime "+$BACKUP_RETENTION_DAYS" -delete

exit 0
