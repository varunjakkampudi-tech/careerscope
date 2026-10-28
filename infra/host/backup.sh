#!/usr/bin/env bash
# Host-native scheduled database backup for CS-25: "no scheduled database
# dump exists, even on the host."
#
# Every run does these things, in order, and only promotes the dump to
# "latest" if all of them succeed:
#   1. dump    - pg_dump, custom format, captured on the host via docker exec
#   2. verify  - restore that exact dump into a disposable scratch database
#                inside the same container, run one sanity query against it,
#                then drop it. This is what makes the restore *exercised*
#                rather than merely documented (AC2): every single scheduled
#                run proves its own dump is actually restorable, not just
#                that pg_dump exited zero.
#   3. encrypt - the verified dump is encrypted (age, else gpg symmetric)
#                before it is promoted. The plaintext copy only ever exists as
#                a .staging file and is removed on every exit path. With no
#                usable encryption the run fails closed.
#   4. promote - atomically rename the encrypted dump into place and apply
#                retention. A dump that fails any earlier step is deleted, not
#                promoted, and the last known-good file is left exactly as it
#                was (AC3: a failed dump must not look like a current one).
#
# Runs on the host, independent of the container it backs up, the same way
# infra/host/monitor.sh does - via careerscope-backup.timer.
set -euo pipefail
umask 077

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
# stolen archive alone is unreadable. The two directories must not nest in either
# direction (resolved with realpath); the run fails otherwise, because a key beside
# its ciphertext defeats the split. BACKUP_KEY_DIR must be owned by BACKUP_KEY_DIR_OWNER_UID
# (root, 0, unless a test overrides it) with mode 700, checked with stat after chmod.
# BACKUP_FILES_CONTAINER set to the empty string skips resumes only when BACKUP_ALLOW_SKIP_RESUMES=1;
# without that opt-in the run fails closed (STATUS=failed). An allowed skip is STATUS=degraded.
BACKUP_FILES_CONTAINER=${BACKUP_FILES_CONTAINER-careerscope-files-1}
BACKUP_PRIVATE_DIR=${BACKUP_PRIVATE_DIR:-/private}
BACKUP_KEY_DIR=${BACKUP_KEY_DIR:-/var/lib/careerscope/backup-keys}
BACKUP_KEY_DIR_OWNER_UID=${BACKUP_KEY_DIR_OWNER_UID:-0}
BACKUP_ALLOW_SKIP_RESUMES=${BACKUP_ALLOW_SKIP_RESUMES:-0}
# Dump encryption: age with BACKUP_AGE_RECIPIENT (a public key) or BACKUP_AGE_RECIPIENTS_FILE
# when age is installed, else gpg symmetric with BACKUP_GPG_PASSPHRASE_FILE (mode 0600 or 0400,
# outside BACKUP_DIR). Neither available means the run fails.
BACKUP_AGE_RECIPIENT=${BACKUP_AGE_RECIPIENT:-}
BACKUP_AGE_RECIPIENTS_FILE=${BACKUP_AGE_RECIPIENTS_FILE:-}
BACKUP_GPG_PASSPHRASE_FILE=${BACKUP_GPG_PASSPHRASE_FILE:-}
AGE_BIN=${BACKUP_AGE_BIN:-age}
GPG_BIN=${BACKUP_GPG_BIN:-gpg}
REALPATH_BIN=${BACKUP_REALPATH_BIN:-realpath}
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

# The key-directory split is only enforceable on resolved paths, so there is no fallback:
# without realpath the run refuses to start.
if ! command -v "$REALPATH_BIN" >/dev/null 2>&1; then
  echo "realpath is required to keep the key directory apart from the backups; refusing to run" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"

status_file="$BACKUP_DIR/last-status"

# Fail fast and clearly if a manual run overlaps the timer's own run, rather
# than letting both race for the same scratch database (Security review,
# P3: a losing racer would otherwise discard its own good dump and report a
# spurious failure - never anything unsafe, but confusing and wasteful).
# Best-effort: flock is standard on Ubuntu (util-linux) but is not something
# a missing-tool situation should turn into a backup outage over, so a host
# without it just skips locking rather than refusing to run at all.
# A held lock is not a failure, so the exit is 0, but it is recorded as STATUS=locked with the
# time. A lock that stays held makes that status old, and check-backup.sh --status-only flags a
# locked status older than 26 hours (a hung run), so it cannot hide behind exit 0 forever.
lock_fd=200
if command -v flock >/dev/null 2>&1; then
  exec 200>"$BACKUP_DIR/.lock"
  if ! flock -n "$lock_fd"; then
    echo "another backup run is already in progress; not starting a second one" >&2
    printf 'STATUS=locked\nAT=%s\n' "$(date -u +%Y%m%dT%H%M%SZ)" >"$status_file"
    exit 0
  fi
else
  echo "flock not available; proceeding without overlap protection" >&2
fi

stamp=$(date -u +%Y%m%dT%H%M%SZ)
staging="$BACKUP_DIR/.staging-$stamp.dump"
staging_encrypted="$BACKUP_DIR/.staging-$stamp.dump.encrypted"
staging_gnupg="$BACKUP_DIR/.staging-gnupg-$stamp"
final="$BACKUP_DIR/careerscope-$stamp.dump"
staging_resumes="$BACKUP_DIR/.staging-resumes-$stamp.tar"
final_resumes="$BACKUP_DIR/careerscope-resumes-$stamp.tar"
staging_key="$BACKUP_KEY_DIR/.staging-key-$stamp.key"
final_key="$BACKUP_KEY_DIR/careerscope-resume-key-$stamp.key"
encryption_method=none

cleanup_scratch() {
  "$DOCKER_BIN" exec "$BACKUP_DB_CONTAINER" psql -U "$BACKUP_DB_USER" -d postgres \
    -tAc "DROP DATABASE IF EXISTS $BACKUP_VERIFY_DB" >/dev/null 2>&1 || true
}

# Every exit path (success, failure, INT, TERM) removes whatever staging files exist, so a
# plaintext dump or key copy is never left behind. After promotion the staging names no longer
# exist, so the removal is a no-op on success.
remove_staging() {
  if [ -d "$staging_gnupg" ] && command -v gpgconf >/dev/null 2>&1; then
    gpgconf --homedir "$staging_gnupg" --kill gpg-agent >/dev/null 2>&1 || true
  fi
  rm -rf "$staging_gnupg"
  rm -f "$staging" "$staging_encrypted" "$staging_resumes" "$staging_key"
}
cleanup() {
  remove_staging
  cleanup_scratch
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  remove_staging
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

# The webhook URL is a credential, so it never appears on a command line (where `ps` shows it to
# every local user): curl reads it from a config supplied through process substitution, and the
# payload comes in on stdin. A URL that could break out of the quoted config value is refused.
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
  case "$BACKUP_WEBHOOK_URL" in
    *'"'* | *$'\n'* | *$'\r'* | *'\'*)
      echo "BACKUP_WEBHOOK_URL contains a quote, backslash or line break; refusing to send an alert" >&2
      return 0
      ;;
  esac
  local escaped; escaped=$(json_escape "$message")
  "$CURL_BIN" -fsS --max-time "$CURL_TIMEOUT" -X POST -H 'Content-Type: application/json' \
    --data-binary @- -K <(printf 'url = "%s"\n' "$BACKUP_WEBHOOK_URL") \
    <<<"{\"text\":\"$escaped\",\"content\":\"$escaped\"}" >/dev/null \
    && echo "alert sent to webhook (${BACKUP_WEBHOOK_URL:0:20}...)" \
    || echo "alert webhook POST failed (${BACKUP_WEBHOOK_URL:0:20}...)" >&2
}

# The key must never sit beside the ciphertext it decrypts, in either direction. Compare resolved
# paths so ".." and symlinks cannot hide one directory inside the other.
resolved_backup_dir=$("$REALPATH_BIN" -m -- "$BACKUP_DIR") || fail "could not resolve BACKUP_DIR"
resolved_key_dir=$("$REALPATH_BIN" -m -- "$BACKUP_KEY_DIR") || fail "could not resolve BACKUP_KEY_DIR"
case "$resolved_key_dir/" in
  "$resolved_backup_dir"/*)
    fail "BACKUP_KEY_DIR ($BACKUP_KEY_DIR) is inside BACKUP_DIR ($BACKUP_DIR); the key must be stored apart from the ciphertext"
    ;;
esac
case "$resolved_backup_dir/" in
  "$resolved_key_dir"/*)
    fail "BACKUP_DIR ($BACKUP_DIR) is inside BACKUP_KEY_DIR ($BACKUP_KEY_DIR); the ciphertext must be stored apart from the key"
    ;;
esac
mkdir -p "$BACKUP_KEY_DIR"
chmod 0700 "$BACKUP_KEY_DIR"
# chmod alone proves nothing (it can be a no-op on some filesystems, and the owner may be wrong),
# so read the result back.
key_dir_stat=$(stat -c '%u %a' "$BACKUP_KEY_DIR")
if [ "$key_dir_stat" != "$BACKUP_KEY_DIR_OWNER_UID 700" ]; then
  fail "BACKUP_KEY_DIR must be owned by uid $BACKUP_KEY_DIR_OWNER_UID with mode 700 (found owner and mode: $key_dir_stat)"
fi
if [ "$(stat -c '%d' "$BACKUP_DIR")" = "$(stat -c '%d' "$BACKUP_KEY_DIR")" ]; then
  echo "WARNING: BACKUP_DIR and BACKUP_KEY_DIR are on the same device (same device id); one disk failure loses both, and a copy of that disk holds the key beside the ciphertext. Put the key directory on a different mount" >&2
fi

# Abandoned staging files from a run that was killed before its trap could run (power loss, SIGKILL).
find "$BACKUP_DIR" -maxdepth 1 -name '.staging-*' -mmin +1440 -exec rm -rf -- {} +
find "$BACKUP_KEY_DIR" -maxdepth 1 -name '.staging-*' -mmin +1440 -exec rm -rf -- {} +

# -- 0. choose the encryption before spending time on a dump --------------
if command -v "$AGE_BIN" >/dev/null 2>&1 \
  && { [ -n "$BACKUP_AGE_RECIPIENT" ] || [ -n "$BACKUP_AGE_RECIPIENTS_FILE" ]; }; then
  encryption_method=age
  encrypted_suffix=age
elif command -v "$GPG_BIN" >/dev/null 2>&1 && [ -n "$BACKUP_GPG_PASSPHRASE_FILE" ]; then
  if [ ! -f "$BACKUP_GPG_PASSPHRASE_FILE" ] || [ ! -s "$BACKUP_GPG_PASSPHRASE_FILE" ]; then
    fail "BACKUP_GPG_PASSPHRASE_FILE is missing or empty"
  fi
  passphrase_mode=$(stat -c '%a' "$BACKUP_GPG_PASSPHRASE_FILE")
  if [ "$passphrase_mode" != 600 ] && [ "$passphrase_mode" != 400 ]; then
    fail "BACKUP_GPG_PASSPHRASE_FILE must have mode 600 or 400 (found $passphrase_mode)"
  fi
  resolved_passphrase=$("$REALPATH_BIN" -m -- "$BACKUP_GPG_PASSPHRASE_FILE") \
    || fail "could not resolve BACKUP_GPG_PASSPHRASE_FILE"
  case "$resolved_passphrase" in
    "$resolved_backup_dir"/*)
      fail "BACKUP_GPG_PASSPHRASE_FILE is inside BACKUP_DIR; the passphrase must not sit beside the dumps it protects"
      ;;
  esac
  encryption_method=gpg
  encrypted_suffix=gpg
else
  fail "no dump encryption available: install age and set BACKUP_AGE_RECIPIENT (or BACKUP_AGE_RECIPIENTS_FILE), or provide gpg and BACKUP_GPG_PASSPHRASE_FILE"
fi

encrypt_dump() {
  local input=$1 output=$2
  case "$encryption_method" in
    age)
      if [ -n "$BACKUP_AGE_RECIPIENT" ]; then
        "$AGE_BIN" -r "$BACKUP_AGE_RECIPIENT" -o "$output" "$input"
      else
        "$AGE_BIN" -R "$BACKUP_AGE_RECIPIENTS_FILE" -o "$output" "$input"
      fi
      ;;
    gpg)
      mkdir -p "$staging_gnupg"
      chmod 0700 "$staging_gnupg"
      "$GPG_BIN" --homedir "$staging_gnupg" --batch --yes --quiet --pinentry-mode loopback \
        --passphrase-file "$BACKUP_GPG_PASSPHRASE_FILE" --symmetric --cipher-algo AES256 \
        -o "$output" "$input"
      # gpg can decrypt with the passphrase alone, so prove the result is readable.
      "$GPG_BIN" --homedir "$staging_gnupg" --batch --quiet --pinentry-mode loopback \
        --passphrase-file "$BACKUP_GPG_PASSPHRASE_FILE" --decrypt "$output" >/dev/null
      ;;
  esac
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

# -- 2a. encrypt the verified dump; the plaintext never leaves staging ----
if ! encrypt_dump "$staging" "$staging_encrypted" 2>"$BACKUP_DIR/.last-encrypt-stderr"; then
  fail "dump encryption ($encryption_method) failed, see $BACKUP_DIR/.last-encrypt-stderr"
fi
if [ ! -s "$staging_encrypted" ]; then
  fail "dump encryption ($encryption_method) produced an empty file"
fi
rm -f "$staging"
final="$final.$encrypted_suffix"

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
elif [ "$BACKUP_ALLOW_SKIP_RESUMES" = 1 ]; then
  echo "WARNING: BACKUP_FILES_CONTAINER is empty; resume objects and the key are NOT backed up" >&2
else
  fail "BACKUP_FILES_CONTAINER is empty; resume objects and the key would not be backed up (set BACKUP_ALLOW_SKIP_RESUMES=1 to allow)"
fi

# -- 3. promote and retain --------------------------------------------------
# From here on every command is a post-promotion step (rename, chmod, status write, retention). Any of
# them failing must still record STATUS=failed and send the alert, rather than exiting under set -e with
# a stale "ok" status, so the ERR trap routes the failure through fail().
trap 'fail "a step after promotion failed (line $LINENO); check the backup directory and permissions"' ERR
mv -f "$staging_encrypted" "$final"
chmod 0600 "$final"
if [ "$resumes_state" = ok ]; then
  mv -f "$staging_resumes" "$final_resumes"
  mv -f "$staging_key" "$final_key"
  chmod 0600 "$final_resumes" "$final_key"
fi
# An opted-in skip of the resume objects is a partial backup: degraded, not ok.
overall=ok
if [ "$resumes_state" != ok ]; then
  overall=degraded
fi
{
  echo "STATUS=$overall"
  echo "AT=$stamp"
  echo "FILE=$final"
  echo "ENCRYPTION=$encryption_method"
  echo "TABLES=$table_count"
  echo "RESUMES=$resumes_state"
  if [ "$resumes_state" = ok ]; then
    echo "RESUMES_FILE=$final_resumes"
    echo "RESUME_KEY_FILE=$final_key"
    echo "RESUME_OBJECTS=$resume_objects"
  else
    echo "REASON=resume objects and key skipped (BACKUP_ALLOW_SKIP_RESUMES=1)"
  fi
} >"$status_file"
echo "backup $overall: $final ($table_count tables verified by restore; encryption: $encryption_method; resumes: $resumes_state, $resume_objects objects)"

# Retention: delete anything older than the window, but only real, promoted
# dumps - never a .staging file mid-write, and never touch last-status.
# (careerscope-*.dump covers dumps promoted before encryption existed.)
find "$BACKUP_DIR" -maxdepth 1 \( -name 'careerscope-*.dump' -o -name 'careerscope-*.dump.age' \
  -o -name 'careerscope-*.dump.gpg' -o -name 'careerscope-resumes-*.tar' \) \
  -mtime "+$BACKUP_RETENTION_DAYS" -delete
find "$BACKUP_KEY_DIR" -maxdepth 1 -name 'careerscope-resume-key-*.key' -mtime "+$BACKUP_RETENTION_DAYS" -delete

exit 0
