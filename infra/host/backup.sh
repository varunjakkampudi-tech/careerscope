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
#   3. encrypt - the verified dump, the resume object archive and the resume key
#                are encrypted (age, else gpg symmetric) before they are promoted. The plaintext copy only ever exists as
#                a .staging file and is removed on every exit path. With no
#                usable encryption the run fails closed.
#   4. promote - atomically rename the encrypted dump into place and apply
#                retention. A dump that fails any earlier step is deleted, not
#                promoted, and the last known-good file is left exactly as it
#                was (AC3: a failed dump must not look like a current one).
#
# Runs on the host, independent of the container it backs up, the same way
# infra/host/monitor.sh does - via careerscope-backup.timer.
# -E makes the ERR trap below apply inside functions and command substitutions too.
set -Eeuo pipefail
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
# artefacts: the object archive in BACKUP_DIR and the key in BACKUP_KEY_DIR. Both are
# encrypted with the same backup encryption as the dump, so neither the object names (which
# carry owner ids and plaintext hashes) nor the key are readable without the backup secret,
# and no plaintext key copy is retained. The key copy is named by a short fingerprint of the
# key and written once, not on every run. The two directories must not nest in either
# direction (resolved with realpath); the run fails otherwise. BACKUP_KEY_DIR must be owned by
# BACKUP_KEY_DIR_OWNER_UID (root, 0, unless a test overrides it) with mode 700, checked with stat
# after chmod. Placing both on one device fails closed unless BACKUP_ALLOW_SAME_DEVICE_KEY_DIR=1.
# BACKUP_FILES_CONTAINER set to the empty string skips resumes only when BACKUP_ALLOW_SKIP_RESUMES=1;
# without that opt-in the run fails closed (STATUS=failed). An allowed skip is STATUS=degraded.
BACKUP_FILES_CONTAINER=${BACKUP_FILES_CONTAINER-careerscope-files-1}
BACKUP_PRIVATE_DIR=${BACKUP_PRIVATE_DIR:-/private}
BACKUP_KEY_DIR=${BACKUP_KEY_DIR:-/var/lib/careerscope/backup-keys}
BACKUP_KEY_DIR_OWNER_UID=${BACKUP_KEY_DIR_OWNER_UID:-0}
BACKUP_ALLOW_SKIP_RESUMES=${BACKUP_ALLOW_SKIP_RESUMES:-0}
BACKUP_ALLOW_SAME_DEVICE_KEY_DIR=${BACKUP_ALLOW_SAME_DEVICE_KEY_DIR:-0}
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

stamp=$(date -u +%Y%m%dT%H%M%SZ)
staging="$BACKUP_DIR/.staging-$stamp.dump"
staging_encrypted="$BACKUP_DIR/.staging-$stamp.dump.encrypted"
staging_gnupg="$BACKUP_DIR/.staging-gnupg-$stamp"
final="$BACKUP_DIR/careerscope-$stamp.dump"
staging_resumes="$BACKUP_DIR/.staging-resumes-$stamp.tar"
staging_resumes_encrypted="$BACKUP_DIR/.staging-resumes-$stamp.tar.encrypted"
staging_resumes_list="$BACKUP_DIR/.staging-resumes-list-$stamp"
staging_resumes_stderr="$BACKUP_DIR/.staging-resumes-stderr-$stamp"
# Diagnostics from pg_dump, pg_restore and the encryption tools can echo row data or object names, so
# they live only in root-only staging files, are removed on every exit path, and only a line count
# is ever recorded.
staging_dump_stderr="$BACKUP_DIR/.staging-dump-stderr-$stamp"
staging_restore_stderr="$BACKUP_DIR/.staging-restore-stderr-$stamp"
staging_encrypt_stderr="$BACKUP_DIR/.staging-encrypt-stderr-$stamp"
final_resumes="$BACKUP_DIR/careerscope-resumes-$stamp.tar"
staging_key="$BACKUP_KEY_DIR/.staging-key-$stamp.key"
staging_key_encrypted="$BACKUP_KEY_DIR/.staging-key-$stamp.key.encrypted"
encryption_method=none

status_file="$BACKUP_DIR/last-status"

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
  rm -f "$staging" "$staging_encrypted" "$staging_resumes" "$staging_resumes_encrypted" \
    "$staging_resumes_list" "$staging_resumes_stderr" "$staging_key" "$staging_key_encrypted" \
    "$staging_dump_stderr" "$staging_restore_stderr" "$staging_encrypt_stderr"
}
# Number of lines in a diagnostics file (0 when it does not exist). Never prints the content.
line_count() {
  if [ -f "$1" ]; then grep -c '' "$1" || true; else echo 0; fi
}
cleanup() {
  # A failing removal must not stop the scratch cleanup or change the exit status.
  remove_staging || true
  cleanup_scratch
}

fail() {
  # A failure inside this handler must not re-enter it through the ERR trap.
  trap - ERR
  # If removal fails (set -e), the status and alert below must still happen.
  remove_staging || true
  echo "backup FAILED: $1" >&2
  {
    cat >"$status_file" <<EOF
STATUS=failed
AT=$stamp
REASON=$1
EOF
  } 2>/dev/null || echo "could not write status file" >&2
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
    && echo "alert sent to configured webhook" \
    || echo "alert webhook POST failed" >&2
}

mkdir -p "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"
# Earlier versions left unencrypted diagnostics here; they can hold row data, so they are removed.
rm -f "$BACKUP_DIR/.last-dump-stderr" "$BACKUP_DIR/.last-restore-stderr" "$BACKUP_DIR/.last-encrypt-stderr"

# From here on any unexpected failure (a command failing under set -e, including mkdir and chmod
# before the first dump step) records STATUS=failed and sends the alert instead of exiting with a
# stale "ok" status. It is replaced by a more specific message after promotion.
trap 'fail "unexpected failure at line $LINENO; check the backup directory, key directory and permissions"' ERR

# Fail fast and clearly if a manual run overlaps the timer's own run, rather
# than letting both race for the same scratch database (Security review,
# P3: a losing racer would otherwise discard its own good dump and report a
# spurious failure - never anything unsafe, but confusing and wasteful).
# Best-effort: flock is standard on Ubuntu (util-linux) but is not something
# a missing-tool situation should turn into a backup outage over, so a host
# without it just skips locking rather than refusing to run at all.
# A held lock is not a failure, so the exit is 0. It must not make the backup look fresh, though: a
# hung run that holds the lock forever would otherwise keep refreshing the status. So AT keeps the
# time of the last successful run (carried over from an ok, degraded or locked status), the attempt
# time goes into LOCK_ATTEMPT_AT and the separate last-lock-attempt file, and check-backup.sh
# --status-only flags a locked status whose AT is older than the staleness bound. A previous failed
# or missing status is left as it is, because those are already flagged.
lock_fd=200
if command -v flock >/dev/null 2>&1; then
  exec 200>"$BACKUP_DIR/.lock"
  if ! flock -n "$lock_fd"; then
    echo "another backup run is already in progress; not starting a second one" >&2
    attempt=$(date -u +%Y%m%dT%H%M%SZ)
    printf 'LOCK_ATTEMPT_AT=%s\n' "$attempt" >"$BACKUP_DIR/last-lock-attempt"
    prior_status=$(sed -n 's/^STATUS=//p' "$status_file" 2>/dev/null | head -1 || true)
    prior_at=$(sed -n 's/^AT=//p' "$status_file" 2>/dev/null | head -1 || true)
    case "$prior_status" in
      ok | degraded | locked)
        if [[ "$prior_at" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
          printf 'STATUS=locked\nAT=%s\nLOCK_ATTEMPT_AT=%s\n' "$prior_at" "$attempt" >"$status_file.tmp" \
            && mv -f "$status_file.tmp" "$status_file" || true
        fi
        ;;
    esac
    exit 0
  fi
else
  echo "flock not available; proceeding without overlap protection" >&2
fi

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

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
  # One disk failure loses both, and a copy of that disk holds the key beside the ciphertext.
  if [ "$BACKUP_ALLOW_SAME_DEVICE_KEY_DIR" != 1 ]; then
    fail "BACKUP_DIR and BACKUP_KEY_DIR are on the same device; put the key directory on a different mount (or set BACKUP_ALLOW_SAME_DEVICE_KEY_DIR=1 to accept the risk)"
  fi
  echo "WARNING: BACKUP_DIR and BACKUP_KEY_DIR are on the same device (same device id) and BACKUP_ALLOW_SAME_DEVICE_KEY_DIR=1 accepts that; one disk failure loses both. Put the key directory on a different mount" >&2
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
  >"$staging" 2>"$staging_dump_stderr"; then
  fail "pg_dump exited non-zero ($(line_count "$staging_dump_stderr") diagnostic lines, not retained)"
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
  -d "$BACKUP_VERIFY_DB" --no-owner <"$staging" >/dev/null 2>"$staging_restore_stderr"; then
  fail "restore into the scratch database failed ($(line_count "$staging_restore_stderr") diagnostic lines, not retained)"
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
if ! encrypt_dump "$staging" "$staging_encrypted" 2>"$staging_encrypt_stderr"; then
  fail "dump encryption ($encryption_method) failed ($(line_count "$staging_encrypt_stderr") diagnostic lines, not retained)"
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
  # Object names carry owner ids and plaintext hashes, so the listing, the tar's stderr and the
  # archive itself stay in root-only staging files that are removed on exit; only the encrypted
  # archive is promoted. A diagnostic goes to the journal, never into the backup set.
  if ! "$DOCKER_BIN" exec "$BACKUP_FILES_CONTAINER" tar -C "$BACKUP_PRIVATE_DIR" -cf - objects \
    >"$staging_resumes" 2>"$staging_resumes_stderr"; then
    cat "$staging_resumes_stderr" >&2 || true
    fail "resume object archive failed (tar output is in the journal, not in the backup set)"
  fi
  if [ ! -s "$staging_resumes" ] || ! tar -tf "$staging_resumes" >"$staging_resumes_list" 2>/dev/null; then
    fail "resume object archive is empty or unreadable"
  fi
  resume_objects=$(grep -c '\.bin$' "$staging_resumes_list" || true)
  if ! encrypt_dump "$staging_resumes" "$staging_resumes_encrypted" 2>"$staging_encrypt_stderr"; then
    fail "resume archive encryption ($encryption_method) failed ($(line_count "$staging_encrypt_stderr") diagnostic lines, not retained)"
  fi
  if [ ! -s "$staging_resumes_encrypted" ]; then
    fail "resume archive encryption ($encryption_method) produced an empty file"
  fi
  rm -f "$staging_resumes" "$staging_resumes_list" "$staging_resumes_stderr"
  final_resumes="$final_resumes.$encrypted_suffix"
  if ! "$DOCKER_BIN" exec "$BACKUP_FILES_CONTAINER" cat "$BACKUP_PRIVATE_DIR/encryption.key" \
    >"$staging_key" 2>/dev/null; then
    fail "could not read the resume encryption key"
  fi
  # The key must be exactly 64 hex characters; anything else could not decrypt the archive.
  if ! [[ "$(tr -d '\n\r' <"$staging_key")" =~ ^[a-f0-9]{64}$ ]]; then
    fail "resume encryption key file is not a 64-character hex key"
  fi
  # The key copy is named by a short fingerprint of the key and written once: an unchanged key
  # does not add another copy on every run. Only the encrypted form is ever retained.
  key_fingerprint=$(tr -d '\n\r' <"$staging_key" | sha256sum | cut -c1-12)
  final_key="$BACKUP_KEY_DIR/careerscope-resume-key-$key_fingerprint.key.$encrypted_suffix"
  if [ ! -s "$final_key" ]; then
    if ! encrypt_dump "$staging_key" "$staging_key_encrypted" 2>"$staging_encrypt_stderr"; then
      fail "resume key encryption ($encryption_method) failed ($(line_count "$staging_encrypt_stderr") diagnostic lines, not retained)"
    fi
    if [ ! -s "$staging_key_encrypted" ]; then
      fail "resume key encryption ($encryption_method) produced an empty file"
    fi
  fi
  rm -f "$staging_key"
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
  mv -f "$staging_resumes_encrypted" "$final_resumes"
  if [ -f "$staging_key_encrypted" ]; then
    mv -f "$staging_key_encrypted" "$final_key"
  fi
  chmod 0600 "$final_resumes" "$final_key"
  # Retention keys on age, so the copy for the key in use is refreshed on every run.
  touch "$final_key"
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
  echo "DIAGNOSTIC_LINES=$(( $(line_count "$staging_dump_stderr") + $(line_count "$staging_restore_stderr") ))"
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
# Older plaintext archives and key copies (*.tar, *.key) from earlier versions age out here too.
find "$BACKUP_DIR" -maxdepth 1 \( -name 'careerscope-*.dump' -o -name 'careerscope-*.dump.age' \
  -o -name 'careerscope-*.dump.gpg' -o -name 'careerscope-resumes-*.tar' \
  -o -name 'careerscope-resumes-*.tar.age' -o -name 'careerscope-resumes-*.tar.gpg' \) \
  -mtime "+$BACKUP_RETENTION_DAYS" -delete
find "$BACKUP_KEY_DIR" -maxdepth 1 \( -name 'careerscope-resume-key-*.key' \
  -o -name 'careerscope-resume-key-*.key.age' -o -name 'careerscope-resume-key-*.key.gpg' \) \
  -mtime "+$BACKUP_RETENTION_DAYS" -delete

exit 0
