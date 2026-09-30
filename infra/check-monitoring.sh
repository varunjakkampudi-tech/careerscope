#!/usr/bin/env bash
# Proves monitor.sh classifies each state correctly and only alerts on a
# transition or after the re-notify window - never on every run of a
# continuing outage, and never silently on a continuing outage either.
#
# Runs entirely against stub `docker`/`curl` binaries; it never touches a real
# host, a real container or a real webhook. The literal "stop a container and
# observe the alert" proof AC3 asks for is a one-time manual step against the
# real deployment, documented in docs/OPERATIONS/DEPLOYMENT.md - that step
# needs a live host and cannot be part of an automated suite that also has to
# run on a laptop or in CI.
set -euo pipefail

dir="$(cd "$(dirname "$0")" && pwd)"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

calls_file="$work/webhook-calls"
: >"$calls_file"

cat >"$work/curl" <<'EOF'
#!/usr/bin/env bash
# Fake curl. Distinguishes the health GET from the webhook POST by looking
# for -X POST in the argument list.
is_post=0
for arg in "$@"; do
  if [ "$arg" = "-X" ]; then is_post=1; fi
done
if [ "$is_post" = 1 ]; then
  echo "post" >>"$FAKE_CALLS_FILE"
  [ "${FAKE_WEBHOOK_MODE:-ok}" = ok ] && exit 0 || exit 1
fi
case "${FAKE_HEALTH_MODE:-ok}" in
  unreachable) exit 7 ;;
  unhealthy) echo '{"status":"degraded"}'; exit 0 ;;
  ok) echo '{"status":"ok","version":"test"}'; exit 0 ;;
esac
EOF
chmod +x "$work/curl"

cat >"$work/docker" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = inspect ]; then
  container=${*: -1}
  if [ "$container" = "${FAKE_STOPPED_CONTAINER:-}" ]; then
    echo false
  else
    echo true
  fi
  exit 0
fi
if [ "$1" = exec ]; then
  if [ "${FAKE_PSQL_FAIL:-0}" = 1 ]; then
    exit 1
  fi
  echo "${FAKE_BACKLOG:-0|0|0|0}"
  exit 0
fi
exit 1
EOF
chmod +x "$work/docker"

failures=0
check() {
  if [ "$2" = "$3" ]; then
    echo "PASS $1"
  else
    echo "FAIL $1 :: expected '$3', got '$2'"
    failures=$((failures + 1))
  fi
}

run_monitor() {
  MONITOR_CURL_BIN="$work/curl" \
  MONITOR_DOCKER_BIN="$work/docker" \
  MONITOR_STATE_DIR="$work/state" \
  MONITOR_WEBHOOK_URL="${MONITOR_WEBHOOK_URL_OVERRIDE:-https://hooks.example.test/alert}" \
  FAKE_CALLS_FILE="$calls_file" \
  bash "$dir/monitor.sh" 2>"$work/stderr" | tee "$work/stdout"
}

reset_state() { rm -rf "$work/state"; : >"$calls_file"; }

echo "== classification: unreachable"
reset_state
FAKE_HEALTH_MODE=unreachable run_monitor >/dev/null
check "unreachable reported" "$(grep -o 'unreachable' "$work/stdout" | head -1)" "unreachable"

echo "== classification: unhealthy (bad health body)"
reset_state
FAKE_HEALTH_MODE=unhealthy run_monitor >/dev/null
check "unhealthy reported" "$(grep -o 'unhealthy' "$work/stdout" | head -1)" "unhealthy"

echo "== classification: stopped (a worker container is not running)"
reset_state
FAKE_HEALTH_MODE=ok FAKE_STOPPED_CONTAINER=careerscope-search-1 run_monitor >/dev/null
check "stopped reported" "$(grep -o 'stopped' "$work/stdout" | head -1)" "stopped"
check "names the stopped container" "$(grep -c 'careerscope-search-1' "$work/stdout")" "1"

echo "== classification: stale (backlog not draining)"
reset_state
FAKE_HEALTH_MODE=ok FAKE_BACKLOG="0|1|900|900" run_monitor >/dev/null
check "stale reported" "$(grep -o 'stale' "$work/stdout" | head -1)" "stale"

echo "== classification: unhealthy when the backlog itself cannot be read"
reset_state
FAKE_HEALTH_MODE=ok FAKE_PSQL_FAIL=1 run_monitor >/dev/null
check "unreadable backlog treated as unhealthy, not ok" "$(grep -o 'unhealthy' "$work/stdout" | head -1)" "unhealthy"

echo "== classification: ok"
reset_state
FAKE_HEALTH_MODE=ok run_monitor >/dev/null
check "ok reported" "$(grep -o ': ok$' "$work/stdout" | head -1)" ": ok"
check "no alert sent when healthy" "$(wc -l <"$calls_file" | tr -d ' ')" "0"

echo "== alerting: fires on the first bad run, not again on the very next run"
reset_state
FAKE_HEALTH_MODE=unreachable run_monitor >/dev/null
first_count=$(wc -l <"$calls_file" | tr -d ' ')
FAKE_HEALTH_MODE=unreachable run_monitor >/dev/null
second_count=$(wc -l <"$calls_file" | tr -d ' ')
check "first bad run alerts" "$first_count" "1"
check "second consecutive bad run does not re-alert" "$second_count" "1"

echo "== alerting: re-alerts once the re-notify window has elapsed"
sed -i "s/NOTIFIED_AT=.*/NOTIFIED_AT=0/" "$work/state/state"
MONITOR_RENOTIFY_SECONDS=1 FAKE_HEALTH_MODE=unreachable run_monitor >/dev/null
third_count=$(wc -l <"$calls_file" | tr -d ' ')
check "re-alerts after the window elapses" "$third_count" "2"

echo "== alerting: recovery is announced once"
reset_state
FAKE_HEALTH_MODE=unreachable run_monitor >/dev/null
FAKE_HEALTH_MODE=ok run_monitor >/dev/null
recovered_count=$(wc -l <"$calls_file" | tr -d ' ')
check "recovery alerts exactly once" "$recovered_count" "2"
FAKE_HEALTH_MODE=ok run_monitor >/dev/null
check "staying healthy does not re-alert" "$(wc -l <"$calls_file" | tr -d ' ')" "2"

echo "== security: a plain-http webhook URL is refused, not silently sent over"
reset_state
MONITOR_WEBHOOK_URL_OVERRIDE="http://hooks.example.test/alert" FAKE_HEALTH_MODE=unreachable run_monitor >/dev/null
check "insecure webhook is not posted to" "$(wc -l <"$calls_file" | tr -d ' ')" "0"
check "insecure webhook is refused, logged" "$(grep -c 'refusing to send' "$work/stderr")" "1"

echo "== security: the webhook URL is never printed in full"
reset_state
FAKE_HEALTH_MODE=unreachable run_monitor >/dev/null
check "full webhook URL absent from stdout" "$(grep -c '/alert' "$work/stdout")" "0"

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all monitor checks passed"
