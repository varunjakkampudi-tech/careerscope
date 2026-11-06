#!/usr/bin/env bash
# Proves check-queue-contract.sh never puts the Redis password on the docker command line.
# A process listing shows argv to every local user, so the password travels in the environment
# and docker receives variable names only. Runs against a recording stub docker; no daemon is needed.
set -euo pipefail

dir="$(cd "$(dirname "$0")" && pwd)"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cat >"$work/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" >>"$FAKE_ARGV_FILE"
printf '%s\n' '---' >>"$FAKE_ARGV_FILE"
exit 0
STUB
chmod +x "$work/docker"

failures=0
check() {
  if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 :: expected '$3', got '$2'"; failures=$((failures + 1)); fi
}

secret='probe-secret-7f3a'
: >"$work/argv"
PATH="$work:$PATH" FAKE_ARGV_FILE="$work/argv" REDIS_PASSWORD="$secret" \
  CAREERSCOPE_IMAGE=careerscope:probe bash "$dir/check-queue-contract.sh" >"$work/log" 2>&1 || true

check "the password is not in any docker argument" \
  "$(grep -c -- "$secret" "$work/argv" || true)" "0"
check "docker run was still invoked for each probe" \
  "$(grep -c '^run$' "$work/argv" || true)" "4"
check "every probe passes the queue URL by name" \
  "$(grep -c '^QUEUE_REDIS_URL$' "$work/argv" || true)" "4"

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all queue-contract secrecy checks passed"
