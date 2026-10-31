#!/usr/bin/env bash
# Proves backup.sh's dump-verify-encrypt-promote pipeline against a REAL, throwaway
# Postgres container - not a stub. AC2 is explicit: "the restore is
# exercised, not documented - a dump nobody has restored is a guess." A stub
# that only proves bash control flow would not actually prove that, so this
# test spins up a disposable postgres:17.6-alpine container, seeds it with
# real tables and rows, and runs the real pg_dump/pg_restore/sanity-query
# pipeline against it end to end.
#
# The webhook-alerting side is still verified against a stub curl (same
# technique as check-monitoring.sh), since that part is pure bash logic and a
# real webhook adds nothing a stub doesn't already prove. The stub records its own
# argv and the config it was given, and a background run is inspected through
# /proc/*/cmdline (what `ps` shows) to prove the webhook URL is never on a command line.
#
# Usage:
#   check-backup.sh                      run the whole suite (needs Docker, gpg, flock, realpath)
#   check-backup.sh --status-only [DIR]  read DIR/last-status (default /var/backups/careerscope)
#                                        and exit 1 when it is failed, or an ok, degraded or
#                                        locked status whose AT (the last successful run; a held
#                                        lock keeps it and records the attempt separately) is
#                                        older than 30 hours (24h interval plus 6h grace: a
#                                        scheduled run was missed or a run is hung)
set -euo pipefail

# -- status-only mode: no Docker, safe to run against a real backup directory ----------------
# Freshness bound: the timer runs once a day, so a good status older than the backup interval plus
# a grace period means a run was missed (timer stopped, host down) and is flagged. Defaults: 24 hours
# plus 6 hours grace = 30 hours; override with BACKUP_STATUS_INTERVAL_HOURS and BACKUP_STATUS_GRACE_HOURS.
if [ "${1:-}" = "--status-only" ]; then
  status_dir=${2:-/var/backups/careerscope}
  status_path="$status_dir/last-status"
  interval_hours=${BACKUP_STATUS_INTERVAL_HOURS:-24}
  grace_hours=${BACKUP_STATUS_GRACE_HOURS:-6}
  if [[ ! "$interval_hours" =~ ^[1-9][0-9]*$ ]] || [[ ! "$grace_hours" =~ ^[0-9]+$ ]]; then
    echo "FLAGGED: BACKUP_STATUS_INTERVAL_HOURS and BACKUP_STATUS_GRACE_HOURS must be whole numbers" >&2
    exit 1
  fi
  max_age_seconds=$(((interval_hours + grace_hours) * 3600))
  # careerscope-backup-check.timer runs this daily. A non-zero exit fails the unit; when a webhook is
  # configured (BACKUP_WEBHOOK_URL, else MONITOR_WEBHOOK_URL) the failure is also posted. The URL goes
  # to curl through a config on a pipe, never on a command line.
  alert_on_failure() {
    local rc=$?
    [ "$rc" -ne 0 ] || return 0
    local url=${BACKUP_WEBHOOK_URL:-${MONITOR_WEBHOOK_URL:-}}
    case "$url" in
      https://*) ;;
      *) return "$rc" ;;
    esac
    case "$url" in *'"'* | *$'\n'* | *$'\r'* | *'\'*) return "$rc" ;; esac
    "${BACKUP_CURL_BIN:-curl}" -fsS --max-time 10 -X POST -H 'Content-Type: application/json' \
      --data-binary '{"text":"CareerScope backup status check FAILED; see the careerscope-backup-check journal","content":"CareerScope backup status check FAILED; see the careerscope-backup-check journal"}' \
      -K <(printf 'url = "%s"\n' "$url") >/dev/null 2>&1 || true
    return "$rc"
  }
  trap alert_on_failure EXIT
  if [ ! -f "$status_path" ]; then
    echo "FLAGGED: no last-status in $status_dir" >&2
    exit 1
  fi
  status_value=$(sed -n 's/^STATUS=//p' "$status_path" | head -1)
  status_at=$(sed -n 's/^AT=//p' "$status_path" | head -1)
  if [[ ! "$status_at" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
    echo "FLAGGED: backup status '$status_value' has no valid AT timestamp" >&2
    exit 1
  fi
  at_epoch=$(date -u -d "${status_at:0:4}-${status_at:4:2}-${status_at:6:2}T${status_at:9:2}:${status_at:11:2}:${status_at:13:2}Z" +%s)
  age_seconds=$(($(date -u +%s) - at_epoch))
  case "$status_value" in
    ok | degraded)
      # A timestamp meaningfully in the future is a broken clock or a tampered file, not a fresh run.
      if [ "$age_seconds" -lt -300 ]; then
        echo "FLAGGED: backup status $status_value is stamped in the future ($status_at)" >&2
        exit 1
      fi
      if [ "$age_seconds" -gt "$max_age_seconds" ]; then
        echo "FLAGGED: last backup status $status_value is stale ($status_at is older than $((max_age_seconds / 3600)) hours: ${interval_hours}h interval plus ${grace_hours}h grace); a scheduled run was missed" >&2
        exit 1
      fi
      echo "backup status $status_value at $status_at (within $((max_age_seconds / 3600)) hours)"
      exit 0
      ;;
    locked)
      # AT is the last successful run, not the time of the lock attempt, so a run that hangs while
      # holding the lock cannot keep the status fresh.
      if [ "$age_seconds" -gt "$max_age_seconds" ]; then
        echo "FLAGGED: the last successful backup was at $status_at (older than $((max_age_seconds / 3600)) hours) and the lock is held; a run is hung or the lock is stale" >&2
        exit 1
      fi
      echo "backup status locked; last successful backup at $status_at (within $((max_age_seconds / 3600)) hours)"
      exit 0
      ;;
    *)
      echo "FLAGGED: backup status is '$status_value' (at $status_at)" >&2
      exit 1
      ;;
  esac
fi

dir="$(cd "$(dirname "$0")" && pwd)"
work=$(mktemp -d)
pg_name="careerscope-backup-check-$$"
files_name="careerscope-backup-files-$$"
trap 'docker rm -f "$pg_name" "$files_name" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
# MSYS (Git Bash on Windows) rewrites absolute POSIX paths in arguments, which would corrupt
# the in-container paths passed to docker exec. This is a no-op on Linux.
export MSYS_NO_PATHCONV=1

# POSIX permissions must be real here. On a filesystem where chmod is a no-op (Git Bash on NTFS) the
# group-readable-passphrase run would succeed and promote an extra dump, which then skews every later
# dump count (the TERM and retention checks), so refuse to run instead of reporting those as defects.
probe="$work/mode-probe"
touch "$probe" && chmod 600 "$probe"
if [ "$(stat -c '%a' "$probe" 2>/dev/null || stat -f '%Lp' "$probe")" != 600 ]; then
  echo 'this filesystem does not keep POSIX permissions (Git Bash on NTFS?); run the suite on Linux, for example in an ubuntu:24.04 container' >&2
  exit 2
fi
rm -f "$probe"

failures=0
check() {
  if [ "$2" = "$3" ]; then
    echo "PASS $1"
  else
    echo "FAIL $1 :: expected '$3', got '$2'"
    failures=$((failures + 1))
  fi
}

# touch a file so it looks N days old (GNU touch, then BSD).
make_old() {
  touch -d "$2 days ago" "$1" 2>/dev/null \
    || touch -t "$(date -v-"$2"d +%Y%m%d0000 2>/dev/null || date -d "$2 days ago" +%Y%m%d0000)" "$1"
}
stamp_hours_ago() {
  date -u -d "$1 hours ago" +%Y%m%dT%H%M%SZ 2>/dev/null || date -u -v-"$1"H +%Y%m%dT%H%M%SZ
}
file_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }

dump_pattern='careerscope-*.dump.gpg'
count_dumps() { find "$work/backups" -maxdepth 1 -name "$dump_pattern" | wc -l | tr -d ' '; }
count_staging() { find "$work/backups" "$work/keys" -name '.staging-*' 2>/dev/null | wc -l | tr -d ' '; }

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

# The dump passphrase lives outside the backup directory, mode 0600, like production.
od -An -N24 -tx1 /dev/urandom | tr -d ' \n' >"$work/backup.pass"
chmod 600 "$work/backup.pass"
mkdir -p "$work/gnupg"
chmod 700 "$work/gnupg"
decrypt_dump() {
  gpg --homedir "$work/gnupg" --batch --quiet --pinentry-mode loopback \
    --passphrase-file "$work/backup.pass" --decrypt "$1"
}

# Stub curl. A POST records its argv (what ps would show), the -K config it was handed and the
# stdin payload. With FAKE_CURL_HOLD set it signals and lingers so the test can inspect ps.
cat >"$work/curl" <<'EOF'
#!/usr/bin/env bash
is_post=0
config=""
previous=""
for arg in "$@"; do
  if [ "$arg" = "-X" ]; then is_post=1; fi
  if [ "$previous" = "-K" ]; then config=$arg; fi
  previous=$arg
done
if [ "$is_post" = 1 ]; then
  echo "post" >>"$FAKE_CALLS_FILE"
  printf '%s\n' "$@" >>"$FAKE_ARGV_FILE"
  if [ -n "$config" ]; then cat "$config" >>"$FAKE_CONFIG_FILE"; fi
  cat >>"$FAKE_BODY_FILE"
  if [ -n "${FAKE_CURL_HOLD:-}" ]; then touch "$FAKE_CURL_HOLD"; sleep 4; fi
  exit 0
fi
exit 1
EOF
chmod +x "$work/curl"

# Stub docker for the TERM test: pg_dump writes a partial file and lingers; everything else is real.
cat >"$work/slow-docker" <<'EOF'
#!/usr/bin/env bash
case " $* " in
  *" pg_dump "*)
    echo "partial plaintext dump"
    touch "$FAKE_DOCKER_HOLD"
    sleep 3
    exit 1
    ;;
esac
exec docker "$@"
EOF
chmod +x "$work/slow-docker"

# Stub age: -r recipient or -R file, -o output, last argument is the input.
cat >"$work/age" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$@" >>"$FAKE_AGE_ARGS"
output=""
previous=""
for arg in "$@"; do
  if [ "$previous" = "-o" ]; then output=$arg; fi
  previous=$arg
  input=$arg
done
{ echo "age-encryption.org/v1"; echo "stub-recipient-stanza"; base64 <"$input"; } >"$output"
EOF
chmod +x "$work/age"

run_backup() {
  BACKUP_DB_CONTAINER="$pg_name" \
  BACKUP_DIR="${CHECK_BACKUP_DIR-$work/backups}" \
  BACKUP_FILES_CONTAINER="${CHECK_FILES_CONTAINER-$files_name}" \
  BACKUP_KEY_DIR="${CHECK_KEY_DIR-$work/keys}" \
  BACKUP_KEY_DIR_OWNER_UID="${CHECK_KEY_UID-$(id -u)}" \
  BACKUP_ALLOW_SAME_DEVICE_KEY_DIR="${CHECK_ALLOW_SAME_DEVICE-1}" \
  BACKUP_GPG_PASSPHRASE_FILE="${CHECK_PASSFILE-$work/backup.pass}" \
  BACKUP_AGE_BIN="${CHECK_AGE_BIN-$work/no-such-age}" \
  BACKUP_AGE_RECIPIENT="${CHECK_AGE_RECIPIENT-}" \
  BACKUP_REALPATH_BIN="${CHECK_REALPATH_BIN-realpath}" \
  BACKUP_DOCKER_BIN="${CHECK_DOCKER_BIN-docker}" \
  BACKUP_CURL_BIN="$work/curl" \
  BACKUP_WEBHOOK_URL="${CHECK_WEBHOOK_URL-https://hooks.example.test/alert}" \
  FAKE_CALLS_FILE="$work/webhook-calls" \
  FAKE_ARGV_FILE="$work/curl-argv" \
  FAKE_CONFIG_FILE="$work/curl-config" \
  FAKE_BODY_FILE="$work/curl-body" \
  FAKE_AGE_ARGS="$work/age-args" \
  "$@" bash "$dir/../host/backup.sh"
}

echo "== a real backup: dump, restore-verify, encrypt, promote"
rm -rf "$work/backups" "$work/keys"; : >"$work/webhook-calls"
out=$(run_backup 2>&1)
check "reports ok" "$(printf '%s' "$out" | grep -c '^backup ok:')" "1"
check "last-status records the table count of the restored copy (the seed creates one table)" "$(grep -c '^TABLES=1$' "$work/backups/last-status")" "1"
check "one encrypted dump file promoted" "$(count_dumps)" "1"
check "no plaintext dump is promoted" "$(find "$work/backups" -maxdepth 1 -name 'careerscope-*.dump' | wc -l | tr -d ' ')" "0"
check "no staging file left behind" "$(find "$work/backups" -maxdepth 1 -name '.staging-*' | wc -l | tr -d ' ')" "0"
check "status file says ok" "$(grep -c '^STATUS=ok' "$work/backups/last-status")" "1"
check "status records the encryption method" "$(grep -c '^ENCRYPTION=gpg' "$work/backups/last-status")" "1"
check "promoted dump is root-restrictable (0600)" "$(file_mode "$(find "$work/backups" -maxdepth 1 -name "$dump_pattern")")" "600"
check "backup dir is root-only (0700)" "$(file_mode "$work/backups")" "700"
check "no scratch verification database left behind" "$(docker exec "$pg_name" psql -U careerscope -d postgres -tAc "select count(*) from pg_database where datname='careerscope_backup_verify'" | tr -d ' ')" "0"
check "success does not send a webhook alert" "$(wc -l <"$work/webhook-calls" | tr -d ' ')" "0"
check "same-device key directory produces a warning" "$(printf '%s' "$out" | grep -c 'on the same device')" "1"
check "no unencrypted pg_dump or pg_restore diagnostics are left in the backup dir" "$(find "$work/backups" -maxdepth 1 \( -name '.last-*stderr*' -o -name '.staging-*stderr*' \) | wc -l | tr -d ' ')" "0"
check "status records only a count of diagnostic lines" "$(grep -c '^DIAGNOSTIC_LINES=[0-9][0-9]*$' "$work/backups/last-status")" "1"
first_dump=$(find "$work/backups" -maxdepth 1 -name "$dump_pattern")
first_dump_sum=$(sha256sum "$first_dump" | cut -d' ' -f1)

echo "== the promoted dump is encrypted, and decrypts to a restorable copy with the seeded rows"
check "the promoted file is not a plaintext pg_dump archive" "$(head -c 5 "$first_dump" | grep -c PGDMP || true)" "0"
decrypt_dump "$first_dump" >"$work/plain.dump"
check "the decrypted dump is a pg_dump custom archive" "$(head -c 5 "$work/plain.dump")" "PGDMP"
docker exec "$pg_name" psql -U careerscope -d postgres -tAc "CREATE DATABASE careerscope_recheck" >/dev/null
docker exec -i "$pg_name" pg_restore -U careerscope -d careerscope_recheck --no-owner <"$work/plain.dump" >/dev/null 2>&1 || true
row_count=$(docker exec "$pg_name" psql -U careerscope -d careerscope_recheck -tAc "SELECT count(*) FROM widgets" 2>/dev/null | tr -d ' ')
check "the dump this test produced restores the real seeded rows elsewhere" "$row_count" "3"
docker exec "$pg_name" psql -U careerscope -d postgres -tAc "DROP DATABASE careerscope_recheck" >/dev/null 2>&1 || true
rm -f "$work/plain.dump"

echo "== resume objects and the key are backed up as separate artefacts"
resumes_tar=$(find "$work/backups" -maxdepth 1 -name 'careerscope-resumes-*.tar.gpg')
key_copy=$(find "$work/keys" -maxdepth 1 -name 'careerscope-resume-key-*.key.gpg')
check "one encrypted resume archive promoted" "$(printf '%s\n' "$resumes_tar" | grep -c .)" "1"
check "one encrypted key copy promoted, in its own directory" "$(printf '%s\n' "$key_copy" | grep -c .)" "1"
check "no plaintext resume archive or key copy is retained" "$(find "$work/backups" "$work/keys" -type f \( -name '*.tar' -o -name '*.key' \) | wc -l | tr -d ' ')" "0"
check "no plaintext object listing is retained" "$(find "$work/backups" -name '.last-resumes-list' | wc -l | tr -d ' ')" "0"
check "no object name (owner id or hash) is readable in the backup set without the key" "$(grep -rl 'o1_r1_h1\|o2_r2_h2' "$work/backups" "$work/keys" 2>/dev/null | wc -l | tr -d ' ')" "0"
check "the key is not readable in the backup set without the backup secret" "$(grep -rl "$key_hex" "$work/backups" "$work/keys" 2>/dev/null | wc -l | tr -d ' ')" "0"
decrypt_dump "$resumes_tar" >"$work/resumes.tar"
check "the decrypted archive does not contain the key" "$(tar -tf "$work/resumes.tar" | grep -c 'encryption.key')" "0"
check "the decrypted archive holds both objects" "$(tar -tf "$work/resumes.tar" | grep -c '\.bin$')" "2"
check "status records resumes ok and the object count" "$(grep -c '^RESUMES=ok' "$work/backups/last-status")-$(grep -c '^RESUME_OBJECTS=2' "$work/backups/last-status")" "1-1"
check "key copy is root-restrictable (0600)" "$(file_mode "$key_copy")" "600"
check "the key copy is named by a fingerprint of the key, not a run stamp" "$(basename "$key_copy")" "careerscope-resume-key-$(printf '%s' "$key_hex" | sha256sum | cut -c1-12).key.gpg"
check "key directory is 0700" "$(file_mode "$work/keys")" "700"
check "the decrypted key copy equals the live key" "$(decrypt_dump "$key_copy" | tr -d '\n')" "$key_hex"
check "no staging files left behind (archive or key)" "$(count_staging)" "0"

echo "== restoring the archive and key reproduces the original bytes"
mkdir -p "$work/restore"
restore_start=$(date +%s)
tar -xf "$work/resumes.tar" -C "$work/restore"
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
check "no new dump, archive or key was promoted" "$(find "$work/backups" "$work/keys" -type f \( -name "$dump_pattern" -o -name 'careerscope-resumes-*.tar.gpg' -o -name 'careerscope-resume-key-*.key.gpg' \) | wc -l | tr -d ' ')" "3"
check "no staging files after a key failure" "$(count_staging)" "0"
check "key failure sends one alert" "$(wc -l <"$work/webhook-calls" | tr -d ' ')" "1"
docker exec "$files_name" sh -c "printf '%s' '$key_hex' >/private/encryption.key"

echo "== a missing files container fails the backup instead of silently skipping resumes"
sleep 1.1
miss_exit=0
out=$(CHECK_FILES_CONTAINER="no-such-container-$$" run_backup 2>&1) || miss_exit=$?
check "missing files container returns nonzero" "$miss_exit" "1"

echo "== a key directory inside the backup directory is refused"
sleep 1.1
dumps_before=$(count_dumps)
inside_exit=0
out=$(CHECK_KEY_DIR="$work/backups/keys" run_backup 2>&1) || inside_exit=$?
check "key dir inside backup dir returns nonzero" "$inside_exit" "1"
check "key dir inside backup dir explains the refusal" "$(printf '%s' "$out" | grep -c 'is inside BACKUP_DIR')" "1"
check "key dir inside backup dir records failed status" "$(grep -c '^STATUS=failed' "$work/backups/last-status")" "1"
check "key dir inside backup dir promotes nothing" "$(count_dumps)" "$dumps_before"
check "key dir inside backup dir is not created" "$([ -e "$work/backups/keys" ] && echo yes || echo no)" "no"
sleep 1.1
dotdot_exit=0
out=$(CHECK_KEY_DIR="$work/backups/../backups/keys" run_backup 2>&1) || dotdot_exit=$?
check "a .. path into the backup dir is also refused" "$dotdot_exit" "1"

echo "== the symmetric case: a backup directory inside the key directory is refused"
sleep 1.1
nest_exit=0
out=$(CHECK_BACKUP_DIR="$work/keys/nested-backups" run_backup 2>&1) || nest_exit=$?
check "backup dir inside key dir returns nonzero" "$nest_exit" "1"
check "backup dir inside key dir explains the refusal" "$(printf '%s' "$out" | grep -c 'is inside BACKUP_KEY_DIR')" "1"
check "backup dir inside key dir promotes nothing" "$(find "$work/keys/nested-backups" -maxdepth 1 -name "$dump_pattern" 2>/dev/null | wc -l | tr -d ' ')" "0"
rm -rf "$work/keys/nested-backups"

echo "== realpath is required, not optional"
sleep 1.1
real_exit=0
out=$(CHECK_REALPATH_BIN="no-such-realpath-$$" run_backup 2>&1) || real_exit=$?
check "missing realpath returns nonzero" "$real_exit" "1"
check "missing realpath explains the refusal" "$(printf '%s' "$out" | grep -c 'realpath is required')" "1"

echo "== the key directory owner and mode are verified with stat, not assumed from chmod"
sleep 1.1
owner_exit=0
out=$(CHECK_KEY_UID=99999 run_backup 2>&1) || owner_exit=$?
check "a key dir owned by the wrong uid returns nonzero" "$owner_exit" "1"
check "a key dir owned by the wrong uid explains the refusal" "$(printf '%s' "$out" | grep -c 'must be owned by uid 99999 with mode 700')" "1"
check "the owner check records failed status" "$(grep -c '^STATUS=failed' "$work/backups/last-status")" "1"
if [ "$(id -u)" != 0 ]; then
  sleep 1.1
  default_exit=0
  out=$(CHECK_KEY_UID=0 run_backup 2>&1) || default_exit=$?
  check "without root ownership the production default (uid 0) refuses" "$default_exit" "1"
else
  echo "SKIP the non-root default owner check (running as root)"
fi

echo "== a key directory on the same device as the backup directory fails closed unless explicitly allowed"
sleep 1.1
dumps_before_device=$(count_dumps)
: >"$work/webhook-calls"
device_exit=0
out=$(CHECK_ALLOW_SAME_DEVICE=0 run_backup 2>&1) || device_exit=$?
check "same-device key dir without the override returns nonzero" "$device_exit" "1"
check "same-device key dir explains the override variable" "$(printf '%s' "$out" | grep -c 'BACKUP_ALLOW_SAME_DEVICE_KEY_DIR=1')" "1"
check "same-device key dir records failed status" "$(grep -c '^STATUS=failed' "$work/backups/last-status")" "1"
check "same-device key dir promotes nothing" "$(count_dumps)" "$dumps_before_device"
check "same-device key dir sends one alert" "$(wc -l <"$work/webhook-calls" | tr -d ' ')" "1"

echo "== a failure before the first dump step still records STATUS=failed and sends the alert"
# mkdir of the key directory runs before any dump work; a regular file in its path makes it fail.
sleep 1.1
printf 'STATUS=ok\nAT=%s\n' "$(stamp_hours_ago 1)" >"$work/backups/last-status"
: >"$work/webhook-calls"
touch "$work/not-a-directory"
early_exit=0
out=$(CHECK_KEY_DIR="$work/not-a-directory/keys" run_backup 2>&1) || early_exit=$?
check "an early failure returns nonzero" "$early_exit" "1"
check "an early failure reports FAILED" "$(printf '%s' "$out" | grep -c 'backup FAILED: unexpected failure')" "1"
check "an early failure replaces the ok status with failed" "$(grep -c '^STATUS=failed' "$work/backups/last-status")-$(grep -c '^STATUS=ok' "$work/backups/last-status")" "1-0"
check "an early failure sends exactly one alert" "$(wc -l <"$work/webhook-calls" | tr -d ' ')" "1"
check "an early failure promotes nothing" "$(count_dumps)" "$dumps_before_device"
rm -f "$work/not-a-directory"

echo "== the dump is encrypted or the run fails closed"
sleep 1.1
none_exit=0
out=$(CHECK_PASSFILE="" run_backup 2>&1) || none_exit=$?
check "no age and no passphrase file returns nonzero" "$none_exit" "1"
check "no encryption explains the refusal" "$(printf '%s' "$out" | grep -c 'no dump encryption available')" "1"
check "no encryption promotes nothing" "$(count_dumps)" "$dumps_before"
check "no encryption leaves no plaintext staging file" "$(count_staging)" "0"
sleep 1.1
chmod 644 "$work/backup.pass"
loose_exit=0
out=$(run_backup 2>&1) || loose_exit=$?
chmod 600 "$work/backup.pass"
check "a group-readable passphrase file returns nonzero" "$loose_exit" "1"
check "a group-readable passphrase file explains the refusal" "$(printf '%s' "$out" | grep -c 'must have mode 600 or 400')" "1"
sleep 1.1
mkdir -p "$work/backups"
cp "$work/backup.pass" "$work/backups/inside.pass"
chmod 600 "$work/backups/inside.pass"
beside_exit=0
out=$(CHECK_PASSFILE="$work/backups/inside.pass" run_backup 2>&1) || beside_exit=$?
rm -f "$work/backups/inside.pass"
check "a passphrase file inside the backup dir returns nonzero" "$beside_exit" "1"
check "a passphrase file inside the backup dir explains the refusal" "$(printf '%s' "$out" | grep -c 'passphrase must not sit beside')" "1"
sleep 1.1
: >"$work/age-args"
age_exit=0
out=$(CHECK_AGE_BIN="$work/age" CHECK_AGE_RECIPIENT="age1examplerecipient" CHECK_PASSFILE="" run_backup 2>&1) || age_exit=$?
check "age is used when it is present with a recipient" "$age_exit" "0"
check "age received the recipient with -r for the dump, the resume archive and the key" "$(grep -c '^age1examplerecipient$' "$work/age-args")" "3"
check "status records age" "$(grep -c '^ENCRYPTION=age' "$work/backups/last-status")" "1"
age_dump=$(find "$work/backups" -maxdepth 1 -name 'careerscope-*.dump.age')
check "the age dump is promoted with the .age suffix" "$(printf '%s\n' "$age_dump" | grep -c .)" "1"
check "the age dump is not plaintext" "$(head -c 5 "$age_dump" | grep -c PGDMP || true)" "0"
check "age also encrypts the resume archive and the key copy" "$(find "$work/backups" -maxdepth 1 -name 'careerscope-resumes-*.tar.age' | wc -l | tr -d ' ')-$(find "$work/keys" -maxdepth 1 -name 'careerscope-resume-key-*.key.age' | wc -l | tr -d ' ')" "1-1"
rm -f "$age_dump" "$work"/backups/careerscope-resumes-*.tar.age "$work"/keys/careerscope-resume-key-*.key.age

echo "== skipping resumes fails closed unless explicitly allowed"
sleep 1.1
skip_exit=0
out=$(CHECK_FILES_CONTAINER="" run_backup 2>&1) || skip_exit=$?
check "empty files container without opt-in returns nonzero" "$skip_exit" "1"
check "empty files container without opt-in records failed status" "$(grep -c '^STATUS=failed' "$work/backups/last-status")" "1"
check "empty files container without opt-in promotes nothing" "$(count_dumps)" "$dumps_before"

echo "== skipping resumes with BACKUP_ALLOW_SKIP_RESUMES=1 is explicit, loud and degraded"
sleep 1.1
out=$(CHECK_FILES_CONTAINER="" BACKUP_ALLOW_SKIP_RESUMES=1 run_backup 2>&1)
check "warns that resumes are not backed up" "$(printf '%s' "$out" | grep -c 'NOT backed up')" "1"
check "status records resumes skipped" "$(grep -c '^RESUMES=skipped' "$work/backups/last-status")" "1"
check "an allowed skip is STATUS=degraded, not ok" "$(grep -c '^STATUS=degraded' "$work/backups/last-status")-$(grep -c '^STATUS=ok' "$work/backups/last-status")" "1-0"
check "the run output calls it degraded" "$(printf '%s' "$out" | grep -c '^backup degraded:')" "1"
# remove the skip run's dump so later counts only see full backups
latest_dump=$(find "$work/backups" -maxdepth 1 -name "$dump_pattern" | sort | tail -1)
rm -f "$latest_dump"

echo "== check-backup.sh --status-only flags failed, and locked with a last success older than 30 hours"
mkdir -p "$work/status-ok" "$work/status-locked-new" "$work/status-locked-old" "$work/status-failed" \
  "$work/status-ok-edge" "$work/status-ok-stale" "$work/status-degraded-stale" "$work/status-ok-noat" "$work/status-ok-future"
printf 'STATUS=ok\nAT=%s\n' "$(stamp_hours_ago 1)" >"$work/status-ok/last-status"
printf 'STATUS=ok\nAT=%s\n' "$(stamp_hours_ago 29)" >"$work/status-ok-edge/last-status"
printf 'STATUS=ok\nAT=%s\n' "$(stamp_hours_ago 31)" >"$work/status-ok-stale/last-status"
printf 'STATUS=degraded\nAT=%s\n' "$(stamp_hours_ago 72)" >"$work/status-degraded-stale/last-status"
printf 'STATUS=ok\n' >"$work/status-ok-noat/last-status"
printf 'STATUS=ok\nAT=%s\n' "$(stamp_hours_ago -5)" >"$work/status-ok-future/last-status"
printf 'STATUS=locked\nAT=%s\nLOCK_ATTEMPT_AT=%s\n' "$(stamp_hours_ago 2)" "$(stamp_hours_ago 0)" >"$work/status-locked-new/last-status"
printf 'STATUS=locked\nAT=%s\nLOCK_ATTEMPT_AT=%s\n' "$(stamp_hours_ago 31)" "$(stamp_hours_ago 0)" >"$work/status-locked-old/last-status"
printf 'STATUS=failed\nAT=%s\nREASON=x\n' "$(stamp_hours_ago 1)" >"$work/status-failed/last-status"
for case_name in ok ok-edge ok-stale degraded-stale ok-noat ok-future locked-new locked-old failed; do
  status_exit=0
  bash "$dir/check-backup.sh" --status-only "$work/status-$case_name" >/dev/null 2>&1 || status_exit=$?
  case "$case_name" in
    ok | ok-edge | locked-new) expected=0 ;;
    *) expected=1 ;;
  esac
  check "status-only exit for $case_name" "$status_exit" "$expected"
done

stale_exit=0
BACKUP_STATUS_GRACE_HOURS=8 bash "$dir/check-backup.sh" --status-only "$work/status-ok-stale" >/dev/null 2>&1 || stale_exit=$?
check "a longer grace period (24h + 8h) accepts a 31 hour old ok status" "$stale_exit" "0"
stale_message=$(bash "$dir/check-backup.sh" --status-only "$work/status-ok-stale" 2>&1 || true)
check "the stale message names the bound" "$(printf '%s' "$stale_message" | grep -c 'older than 30 hours')" "1"

: >"$work/webhook-calls"
BACKUP_CURL_BIN="$work/curl" BACKUP_WEBHOOK_URL="https://hooks.example.test/alert" FAKE_CALLS_FILE="$work/webhook-calls" \
  FAKE_ARGV_FILE="$work/curl-argv" FAKE_CONFIG_FILE="$work/curl-config" FAKE_BODY_FILE="$work/curl-body" \
  bash "$dir/check-backup.sh" --status-only "$work/status-locked-old" >/dev/null 2>&1 </dev/null || true
check "a failing status check posts one webhook alert" "$(wc -l <"$work/webhook-calls" | tr -d ' ')" "1"
BACKUP_CURL_BIN="$work/curl" BACKUP_WEBHOOK_URL="https://hooks.example.test/alert" FAKE_CALLS_FILE="$work/webhook-calls" \
  FAKE_ARGV_FILE="$work/curl-argv" FAKE_CONFIG_FILE="$work/curl-config" FAKE_BODY_FILE="$work/curl-body" \
  bash "$dir/check-backup.sh" --status-only "$work/status-ok" >/dev/null 2>&1 </dev/null || true
check "a healthy status check posts nothing" "$(wc -l <"$work/webhook-calls" | tr -d ' ')" "1"

echo "== a held lock is a deliberate STATUS=locked with the time, exit 0, and no new dump"
if command -v flock >/dev/null 2>&1; then
  sleep 1.1
  dumps_before_lock=$(count_dumps)
  exec 8>"$work/backups/.lock"
  flock -n 8
  locked_exit=0
  out=$(run_backup 2>&1) || locked_exit=$?
  flock -u 8
  exec 8>&-
  check "a held lock exits 0" "$locked_exit" "0"
  check "a held lock says why on stderr" "$(printf '%s' "$out" | grep -c 'already in progress')" "1"
  check "a held lock records STATUS=locked" "$(grep -c '^STATUS=locked' "$work/backups/last-status")" "1"
  check "a held lock records the time" "$(grep -c '^AT=[0-9]\{8\}T[0-9]\{6\}Z$' "$work/backups/last-status")" "1"
  check "a held lock promotes nothing" "$(count_dumps)" "$dumps_before_lock"
  locked_status_exit=0
  bash "$dir/check-backup.sh" --status-only "$work/backups" >/dev/null 2>&1 || locked_status_exit=$?
  check "a fresh locked status from a real run is not flagged" "$locked_status_exit" "0"
else
  echo "SKIP the held-lock checks (flock is not installed)"
fi

echo "== a hung run that holds the lock for more than 30 hours is flagged, not hidden by fresh lock attempts"
if command -v flock >/dev/null 2>&1; then
  sleep 1.1
  hung_at=$(stamp_hours_ago 31)
  printf 'STATUS=ok\nAT=%s\n' "$hung_at" >"$work/backups/last-status"
  exec 8>"$work/backups/.lock"
  flock -n 8
  hung_exit=0
  run_backup >/dev/null 2>&1 || hung_exit=$?
  flock -u 8
  exec 8>&-
  check "a held lock still exits 0" "$hung_exit" "0"
  check "a held lock keeps the last successful AT" "$(grep -c "^AT=$hung_at$" "$work/backups/last-status")" "1"
  check "a held lock records STATUS=locked with the attempt time" "$(grep -c '^STATUS=locked$' "$work/backups/last-status")-$(grep -c '^LOCK_ATTEMPT_AT=[0-9]\{8\}T[0-9]\{6\}Z$' "$work/backups/last-status")" "1-1"
  check "the attempt time is also written to last-lock-attempt" "$(grep -c '^LOCK_ATTEMPT_AT=' "$work/backups/last-lock-attempt")" "1"
  hung_status_exit=0
  hung_message=$(bash "$dir/check-backup.sh" --status-only "$work/backups" 2>&1) || hung_status_exit=$?
  check "a locked status whose last success is 31 hours old is flagged" "$hung_status_exit" "1"
  check "the hung-lock message names the bound" "$(printf '%s' "$hung_message" | grep -c 'older than 30 hours')" "1"
  # A second attempt must not refresh AT either.
  exec 8>"$work/backups/.lock"
  flock -n 8
  run_backup >/dev/null 2>&1 || true
  flock -u 8
  exec 8>&-
  check "a repeated held lock still keeps the last successful AT" "$(grep -c "^AT=$hung_at$" "$work/backups/last-status")" "1"
else
  echo "SKIP the hung-lock check (flock is not installed)"
fi

echo "== invalid retention configuration fails before changing backup state"
make_old "$work/backups/careerscope-invalid-retention.dump.gpg" 30
printf 'STATUS=ok\nAT=%s\n' "$(stamp_hours_ago 1)" >"$work/backups/last-status"
status_before=$(sha256sum "$work/backups/last-status" | cut -d' ' -f1)
dump_count_before=$(count_dumps)
retention_exit=0
BACKUP_RETENTION_DAYS="1;touch $work/retention-canary" run_backup >"$work/invalid-retention-output" 2>&1 || retention_exit=$?
check "invalid retention config returns nonzero" "$retention_exit" "1"
check "invalid retention config fails closed" "$(grep -c 'must be a positive integer' "$work/invalid-retention-output")" "1"
check "invalid retention config preserves dump count" "$(count_dumps)" "$dump_count_before"
check "invalid retention config leaves prior status unchanged" "$(sha256sum "$work/backups/last-status" | cut -d' ' -f1)" "$status_before"
[ ! -e "$work/retention-canary" ] || { echo "FAIL invalid retention executed shell content"; failures=$((failures + 1)); }
rm -f "$work/backups/careerscope-invalid-retention.dump.gpg"

echo "== a failing dump does not touch the last good file or promote a new one"
sleep 1.1 # ensure the next timestamp-stamped filename actually differs
printf 'row data from an older version' >"$work/backups/.last-dump-stderr" # left by earlier versions
: >"$work/webhook-calls"
: >"$work/curl-argv"; : >"$work/curl-config"; : >"$work/curl-body"
backup_exit=0
out=$(BACKUP_DB_NAME=does_not_exist run_backup 2>&1) || backup_exit=$?
check "failed backup returns nonzero to systemd" "$backup_exit" "1"
check "reports failure" "$(printf '%s' "$out" | grep -c 'backup FAILED')" "1"
check "still exactly one promoted dump (the first one, untouched)" "$(count_dumps)" "1"
check "the untouched dump is byte-identical to the earlier good one" "$(sha256sum "$(find "$work/backups" -maxdepth 1 -name "$dump_pattern")" | cut -d' ' -f1)" "$first_dump_sum"
check "status file now says failed, not ok" "$(grep -c '^STATUS=failed' "$work/backups/last-status")" "1"
check "no leftover staging file from the failed attempt" "$(find "$work/backups" -maxdepth 1 -name '.staging-*' | wc -l | tr -d ' ')" "0"
check "a failed dump leaves no diagnostics file (pg_dump stderr can echo data)" "$(find "$work/backups" -maxdepth 1 -name '.last-*stderr*' | wc -l | tr -d ' ')" "0"
check "the failure reason keeps only a count of diagnostic lines" "$(grep -c '^REASON=pg_dump exited non-zero ([0-9][0-9]* diagnostic lines, not retained)$' "$work/backups/last-status")" "1"
check "failure sends exactly one webhook alert" "$(wc -l <"$work/webhook-calls" | tr -d ' ')" "1"

echo "== the webhook URL is passed to curl through a config, never on the command line"
check "curl was given -K" "$(grep -c '^-K$' "$work/curl-argv")" "1"
check "the URL is not in curl's argv" "$(grep -c 'hooks.example.test' "$work/curl-argv" || true)" "0"
check "the URL reached curl through the config" "$(grep -c '^url = "https://hooks.example.test/alert"$' "$work/curl-config")" "1"
check "the alert text reached curl on stdin" "$(grep -c 'backup FAILED' "$work/curl-body")" "1"

echo "== while curl is running, no process command line contains the URL (what ps shows)"
sleep 1.1
rm -f "$work/curl-hold"
( FAKE_CURL_HOLD="$work/curl-hold" BACKUP_DB_NAME=does_not_exist run_backup >/dev/null 2>&1 || true ) &
hold_pid=$!
for _ in $(seq 1 100); do
  [ -e "$work/curl-hold" ] && break
  sleep 0.2
done
check "the stub curl was running while it was inspected" "$([ -e "$work/curl-hold" ] && echo yes || echo no)" "yes"
url_hits=0
stub_seen=0
for cmdline_file in /proc/[0-9]*/cmdline; do
  cmdline=$(tr '\0' ' ' <"$cmdline_file" 2>/dev/null || true)
  case "$cmdline" in *hooks.example.test*) url_hits=$((url_hits + 1)) ;; esac
  case "$cmdline" in *"$work/curl"*) stub_seen=$((stub_seen + 1)) ;; esac
done
wait "$hold_pid" || true
check "positive control: ps sees the running curl process" "$([ "$stub_seen" -ge 1 ] && echo yes || echo no)" "yes"
check "no process command line contains the webhook URL" "$url_hits" "0"

echo "== a webhook URL that could break out of the curl config is refused"
for bad_url in 'https://hooks.example.test/a"b' $'https://hooks.example.test/a\nurl = "https://evil.example"' 'https://hooks.example.test/a\b'; do
  sleep 1.1
  : >"$work/webhook-calls"
  out=$(CHECK_WEBHOOK_URL="$bad_url" BACKUP_DB_NAME=does_not_exist run_backup 2>&1 || true)
  check "refuses a URL with a quote, backslash or newline" "$(printf '%s' "$out" | grep -c 'refusing to send an alert')" "1"
  check "no webhook call is made for it" "$(wc -l <"$work/webhook-calls" | tr -d ' ')" "0"
done

echo "== a TERM signal removes every staging file, plaintext included"
sleep 1.1
rm -f "$work/docker-hold"
( CHECK_DOCKER_BIN="$work/slow-docker" FAKE_DOCKER_HOLD="$work/docker-hold" run_backup >/dev/null 2>&1 ) &
term_pid=$!
for _ in $(seq 1 100); do
  [ -e "$work/docker-hold" ] && break
  sleep 0.2
done
check "the dump was in progress when TERM was sent" "$([ -e "$work/docker-hold" ] && echo yes || echo no)" "yes"
check "a partial plaintext staging file exists mid-dump" "$(find "$work/backups" -maxdepth 1 -name '.staging-*.dump' | wc -l | tr -d ' ')" "1"
backup_pid=""
for cmdline_file in /proc/[0-9]*/cmdline; do
  cmdline=$(tr '\0' ' ' <"$cmdline_file" 2>/dev/null || true)
  case "$cmdline" in
    "bash "*"/host/backup.sh"*)
      backup_pid=${cmdline_file#/proc/}
      backup_pid=${backup_pid%/cmdline}
      ;;
  esac
done
term_exit=0
if [ -n "$backup_pid" ]; then kill -TERM "$backup_pid"; fi
wait "$term_pid" || term_exit=$?
check "TERM ends the run with status 143" "$term_exit" "143"
check "TERM leaves no staging file" "$(count_staging)" "0"
check "TERM promotes nothing" "$(count_dumps)" "1"

echo "== retention and stale staging cleanup"
make_old "$work/backups/careerscope-old-fake.dump.gpg" 30
make_old "$work/backups/careerscope-resumes-old.tar.gpg" 30
make_old "$work/backups/careerscope-resumes-old.tar" 30
make_old "$work/keys/careerscope-resume-key-old.key" 30
make_old "$work/keys/careerscope-resume-key-old2.key.gpg" 30
make_old "$work/backups/.staging-abandoned.dump" 2
make_old "$work/keys/.staging-abandoned.key" 2
make_old "$work/backups/.staging-gnupg-abandoned" 2 2>/dev/null || true
touch "$work/backups/.staging-fresh.dump" "$work/keys/.staging-fresh.key"
: >"$work/webhook-calls"
sleep 1.1
BACKUP_RETENTION_DAYS=14 run_backup >/dev/null 2>&1
check "the 30-day-old fake dump was cleaned up by retention" "$(find "$work/backups" -maxdepth 1 -name 'careerscope-old-fake.dump.gpg' | wc -l | tr -d ' ')" "0"
# Two real dumps exist by this point (the first successful one, plus this
# section's own successful run) - retention must keep both, only the 30-day
# fake one was old enough to remove.
check "both real dumps (old enough to keep) survive retention" "$(count_dumps)" "2"
check "an unchanged key keeps exactly one encrypted key copy across all those runs" "$(find "$work/keys" -maxdepth 1 -name 'careerscope-resume-key-*.key.gpg' | wc -l | tr -d ' ')" "1"
check "the old encrypted archive and plaintext legacy copies were cleaned up by retention" "$(find "$work/backups" "$work/keys" -name 'careerscope-resumes-old.tar*' -o -name 'careerscope-resume-key-old*' | wc -l | tr -d ' ')" "0"
check "an abandoned staging file older than a day is pruned from the backup dir" "$([ -e "$work/backups/.staging-abandoned.dump" ] && echo kept || echo pruned)" "pruned"
check "an abandoned staging file older than a day is pruned from the key dir" "$([ -e "$work/keys/.staging-abandoned.key" ] && echo kept || echo pruned)" "pruned"
check "a fresh staging file is left alone in the backup dir" "$([ -e "$work/backups/.staging-fresh.dump" ] && echo kept || echo pruned)" "kept"
check "a fresh staging file is left alone in the key dir" "$([ -e "$work/keys/.staging-fresh.key" ] && echo kept || echo pruned)" "kept"
rm -f "$work/backups/.staging-fresh.dump" "$work/keys/.staging-fresh.key"
check "the final status after a good run is ok" "$(grep -c '^STATUS=ok' "$work/backups/last-status")" "1"

echo "== a failure after promotion records STATUS=failed and sends the alert"
# A find that fails only for the retention step (-mtime), which runs after the dump is promoted.
mkdir -p "$work/stubbin"
cat >"$work/stubbin/find" <<'EOF'
#!/usr/bin/env bash
case " $* " in
  *" -mtime "*) exit 1 ;;
esac
exec "$REAL_FIND" "$@"
EOF
chmod +x "$work/stubbin/find"
sleep 1.1
: >"$work/webhook-calls"
post_exit=0
out=$(run_backup env REAL_FIND="$(command -v find)" PATH="$work/stubbin:$PATH" 2>&1) || post_exit=$?
check "a post-promotion failure returns nonzero" "$post_exit" "1"
check "a post-promotion failure reports FAILED" "$(printf '%s' "$out" | grep -c 'backup FAILED: a step after promotion failed')" "1"
check "a post-promotion failure overwrites the ok status with failed" "$(grep -c '^STATUS=failed' "$work/backups/last-status")-$(grep -c '^STATUS=ok' "$work/backups/last-status")" "1-0"
check "a post-promotion failure sends exactly one alert" "$(wc -l <"$work/webhook-calls" | tr -d ' ')" "1"

echo "== a failure whose status file cannot be written still sends exactly one alert"
# A directory in place of last-status makes every write to it fail, even when run as root.
rm -f "$work/backups/last-status"; mkdir "$work/backups/last-status"
: >"$work/webhook-calls"
unwritable_exit=0
out=$(CHECK_PASSFILE="" run_backup 2>&1) || unwritable_exit=$?
check "an unwritable status file still returns 1" "$unwritable_exit" "1"
check "an unwritable status file is reported" "$(printf '%s' "$out" | grep -c 'could not write status file')" "1"
check "an unwritable status file still sends exactly one alert" "$(wc -l <"$work/webhook-calls" | tr -d ' ')" "1"
rmdir "$work/backups/last-status"

echo "== a failure whose staging files cannot be removed still records STATUS=failed and sends one alert"
# A stub rm that refuses every staging path stands in for an undeletable staging file (root ignores modes).
cat >"$work/stubbin/rm" <<'EOF'
#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in *.staging-*) echo "rm: cannot remove '$arg': Operation not permitted" >&2; exit 1 ;; esac
done
exec "$REAL_RM" "$@"
EOF
chmod +x "$work/stubbin/rm"
sleep 1.1
: >"$work/webhook-calls"
printf 'STATUS=ok\nAT=%s\n' "$(stamp_hours_ago 1)" >"$work/backups/last-status"
undeletable_exit=0
out=$(BACKUP_DB_NAME=does_not_exist run_backup env REAL_RM="$(command -v rm)" REAL_FIND="$(command -v find)" PATH="$work/stubbin:$PATH" 2>&1) || undeletable_exit=$?
check "an undeletable staging file still returns 1" "$undeletable_exit" "1"
check "an undeletable staging file was left in place (the stub refused)" "$([ "$(count_staging)" -ge 1 ] && echo yes || echo no)" "yes"
check "an undeletable staging file still reports FAILED" "$(printf '%s' "$out" | grep -c 'backup FAILED')" "1"
check "an undeletable staging file still records STATUS=failed" "$(grep -c '^STATUS=failed' "$work/backups/last-status")" "1"
check "an undeletable staging file still sends exactly one alert" "$(wc -l <"$work/webhook-calls" | tr -d ' ')" "1"
find "$work/backups" "$work/keys" -name '.staging-*' -exec rm -rf {} + 2>/dev/null || true

echo "== production image, compose, Redis secret and resume-key checks (Node)"
if command -v node >/dev/null 2>&1; then
  node "$dir/check-production-config.mjs" || failures=$((failures + 1))
else
  echo "SKIP infra/checks/check-production-config.mjs (node is not installed); CI runs it"
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all backup checks passed"
