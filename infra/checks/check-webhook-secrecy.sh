#!/usr/bin/env bash
# Proves the alert webhook URL (a credential) never reaches curl's argv in monitor.sh, recover-proxy.sh
# and scheduler-health.sh: it is handed over in a -K config on a pipe. Also proves a non-https URL and a
# URL that could break out of the quoted config value are refused (curl is never called with a POST).
# Runs against a recording stub curl; no host, Docker or network is needed.
set -euo pipefail

dir="$(cd "$(dirname "$0")" && pwd)"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

cat >"$work/curl" <<'STUB'
#!/usr/bin/env bash
is_post=0
config=""
previous=""
for arg in "$@"; do
  [ "$arg" = "-X" ] && is_post=1
  [ "$previous" = "-K" ] && config=$arg
  previous=$arg
done
if [ "$is_post" = 1 ]; then
  echo post >>"$FAKE_CALLS_FILE"
  printf '%s\n' "$@" >>"$FAKE_ARGV_FILE"
  if [ -n "$config" ]; then cat "$config" >>"$FAKE_CONFIG_FILE"; fi
  exit 0
fi
exit 7
STUB
chmod +x "$work/curl"
cat >"$work/docker" <<'STUB'
#!/usr/bin/env bash
case "$1" in inspect) echo true ;; *) echo "0|0|0|0" ;; esac
STUB
chmod +x "$work/docker"
cat >"$work/restart-stack.sh" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$work/restart-stack.sh"

failures=0
check() {
  if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 :: expected '$3', got '$2'"; failures=$((failures + 1)); fi
}
reset() { rm -rf "$work/state"; : >"$work/calls"; : >"$work/argv"; : >"$work/config"; }

run_script() { # <script> <url>
  local script=$1 url=$2
  MONITOR_CURL_BIN="$work/curl" MONITOR_DOCKER_BIN="$work/docker" \
    MONITOR_STATE_DIR="$work/state" PROXY_STATE_DIR="$work/state" SCHEDULER_STATE_DIR="$work/state" \
    PROXY_RESTART_SCRIPT="$work/restart-stack.sh" PROXY_CONFIRM_THRESHOLD=1 \
    SCHEDULER_SYSTEMCTL_BIN="$work/no-such-systemctl" \
    MONITOR_WEBHOOK_URL="$url" SCHEDULER_WEBHOOK_URL="$url" \
    FAKE_CALLS_FILE="$work/calls" FAKE_ARGV_FILE="$work/argv" FAKE_CONFIG_FILE="$work/config" \
    bash "$dir/../host/$script" >"$work/log" 2>&1 || true
}

good='https://hooks.example.test/secret-token-123'
for script in monitor.sh recover-proxy.sh scheduler-health.sh; do
  echo "== $script"
  reset
  run_script "$script" "$good"
  check "$script posted an alert" "$([ "$(wc -l <"$work/calls" | tr -d ' ')" -ge 1 ] && echo yes || echo no)" "yes"
  check "$script: curl was given -K" "$([ "$(grep -c '^-K$' "$work/argv")" -ge 1 ] && echo yes || echo no)" "yes"
  check "$script: the URL is not in curl's argv" "$(grep -c 'secret-token-123' "$work/argv" || true)" "0"
  # Neither a prefix of the URL nor its host may be logged: the log goes to the journal.
  check "$script: no part of the URL is logged" "$(grep -c -e 'https://' -e 'hooks.example' -e 'secret-token' "$work/log" || true)" "0"
  check "$script: the alert outcome is logged without it" "$([ "$(grep -c 'alert sent to configured webhook' "$work/log" || true)" -ge 1 ] && echo yes || echo no)" "yes"
  check "$script: the URL reached curl through the config" "$([ "$(grep -c "^url = \"$good\"\$" "$work/config")" -ge 1 ] && echo yes || echo no)" "yes"

  reset
  run_script "$script" 'http://hooks.example.test/secret-token-123'
  check "$script: a non-https URL is refused" "$(wc -l <"$work/calls" | tr -d ' ')" "0"

  for bad in 'https://h.test/a"b' 'https://h.test/a\b' $'https://h.test/a\nb'; do
    reset
    run_script "$script" "$bad"
    check "$script: a URL with a quote, backslash or newline is refused" "$(wc -l <"$work/calls" | tr -d ' ')" "0"
  done
done

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all webhook-secrecy checks passed"
