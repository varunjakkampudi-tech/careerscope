#!/usr/bin/env bash
# Proves purge-verification-accounts.sh cannot match a real account. The script deletes rows, so the
# checks use a recording stub docker and never reach a database. Refusals must happen before any
# docker call, and a deletion must be bound to the one domain the operator names (S1-F041).
set -euo pipefail

dir="$(cd "$(dirname "$0")" && pwd)"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cat >"$work/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$@" >>"$FAKE_ARGV_FILE"
printf '%s\n' '---' >>"$FAKE_ARGV_FILE"
cat >>"$FAKE_STDIN_FILE" 2>/dev/null || true
# The count query asks for matching accounts; answer with the configured count.
case "$*" in *count\(\**) echo "${FAKE_COUNT:-0}" ;; esac
exit 0
STUB
chmod +x "$work/docker"

failures=0
check() {
  if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 :: expected '$3', got '$2'"; failures=$((failures + 1)); fi
}
reset() { : >"$work/argv"; : >"$work/stdin"; }
run() { # <env assignments...>
  PATH="$work:$PATH" FAKE_ARGV_FILE="$work/argv" FAKE_STDIN_FILE="$work/stdin" \
    env "$@" bash "$dir/../host/purge-verification-accounts.sh" >"$work/log" 2>&1
}

echo "== refusals happen before any database call"
reset
status=0; run PURGE_EMAIL_DOMAIN_UNSET=1 || status=$?
check "no domain is refused" "$([ "$status" -ne 0 ] && echo refused || echo ran)" "refused"
check "no docker call on refusal" "$(wc -l <"$work/argv" | tr -d ' ')" "0"

reset
status=0; run PURGE_EMAIL_DOMAIN='example.invalid%' || status=$?
check "a domain with a wildcard is refused" "$([ "$status" -eq 2 ] && echo refused || echo ran)" "refused"
check "a malformed domain makes no docker call" "$(wc -l <"$work/argv" | tr -d ' ')" "0"

echo "== a domain with no matching accounts deletes nothing"
reset
status=0; run PURGE_EMAIL_DOMAIN=example.invalid FAKE_COUNT=0 || status=$?
check "zero matches exits cleanly" "$status" "0"
check "no delete is sent when nothing matches" "$(grep -c 'DELETE' "$work/stdin" || true)" "0"

echo "== a deletion is bound to the named domain"
reset
run PURGE_EMAIL_DOMAIN=example.invalid FAKE_COUNT=2 || true
check "the match pattern is the verify namespace at that domain" \
  "$(grep -c '^pattern=verify-%@example.invalid$' "$work/argv" || true)" "1"
check "the SQL reads the pattern variable, not a literal namespace" \
  "$(grep -c "LIKE :'pattern'" "$work/stdin" || true)" "1"
check "no unbound verify match is left in the SQL" \
  "$(grep -c "LIKE 'verify-%'" "$work/stdin" || true)" "0"

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all purge-scope checks passed"
