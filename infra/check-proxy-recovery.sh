#!/usr/bin/env bash
# Proves recover-proxy.sh's confirm-then-act-then-cooldown state machine:
# a single bad check never triggers a restart, a confirmed outage does
# trigger exactly one restart-stack.sh invocation, a second confirmed outage
# inside the cooldown window does NOT trigger a second restart (the circuit
# breaker), and recovery is announced once. Runs entirely against stub
# curl/restart-stack scripts - no real host, proxy or webhook needed.
set -euo pipefail

dir="$(cd "$(dirname "$0")" && pwd)"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

calls_file="$work/webhook-calls"
restart_calls_file="$work/restart-calls"
: >"$calls_file"
: >"$restart_calls_file"

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
case "${FAKE_HEALTH_MODE:-ok}" in
  bad) exit 7 ;;
  ok) echo '{"status":"ok"}'; exit 0 ;;
esac
EOF
chmod +x "$work/curl"

cat >"$work/restart-stack.sh" <<EOF
#!/usr/bin/env bash
echo "restart" >>"$restart_calls_file"
exit \${FAKE_RESTART_EXIT:-0}
EOF
chmod +x "$work/restart-stack.sh"

failures=0
check() {
  if [ "$2" = "$3" ]; then
    echo "PASS $1"
  else
    echo "FAIL $1 :: expected '$3', got '$2'"
    failures=$((failures + 1))
  fi
}

run_recovery() {
  MONITOR_CURL_BIN="$work/curl" \
  PROXY_RESTART_SCRIPT="$work/restart-stack.sh" \
  PROXY_STATE_DIR="$work/state" \
  MONITOR_WEBHOOK_URL="https://hooks.example.test/alert" \
  FAKE_CALLS_FILE="$calls_file" \
  bash "$dir/recover-proxy.sh"
}

reset_state() { rm -rf "$work/state"; : >"$calls_file"; : >"$restart_calls_file"; }

echo "== healthy: no restart, no alert"
reset_state
FAKE_HEALTH_MODE=ok run_recovery >/dev/null
check "no restart on a healthy check" "$(wc -l <"$restart_calls_file" | tr -d ' ')" "0"
check "no alert on a healthy check" "$(wc -l <"$calls_file" | tr -d ' ')" "0"

echo "== a single bad check is not enough to act (confirm threshold)"
reset_state
FAKE_HEALTH_MODE=bad PROXY_CONFIRM_THRESHOLD=2 run_recovery >/dev/null
check "no restart on the first bad check alone" "$(wc -l <"$restart_calls_file" | tr -d ' ')" "0"
check "no alert on the first bad check alone" "$(wc -l <"$calls_file" | tr -d ' ')" "0"

echo "== a confirmed outage (threshold reached) triggers exactly one restart"
FAKE_HEALTH_MODE=bad PROXY_CONFIRM_THRESHOLD=2 run_recovery >/dev/null
check "restart-stack.sh is invoked exactly once" "$(wc -l <"$restart_calls_file" | tr -d ' ')" "1"
check "at least one alert is sent for the confirmed outage" "$([ "$(wc -l <"$calls_file" | tr -d ' ')" -ge 1 ] && echo yes)" "yes"

echo "== circuit breaker: still down, but inside the cooldown window - does not restart again"
FAKE_HEALTH_MODE=bad PROXY_CONFIRM_THRESHOLD=2 PROXY_COOLDOWN_SECONDS=3600 run_recovery >/dev/null
check "restart-stack.sh is still only invoked once (not twice)" "$(wc -l <"$restart_calls_file" | tr -d ' ')" "1"

echo "== after the cooldown window elapses, still down - restarts again"
sed -i "s/LAST_RESTART=.*/LAST_RESTART=0/" "$work/state/proxy-recovery-state"
FAKE_HEALTH_MODE=bad PROXY_CONFIRM_THRESHOLD=2 PROXY_COOLDOWN_SECONDS=1 run_recovery >/dev/null
check "restart-stack.sh is invoked a second time once the cooldown has elapsed" "$(wc -l <"$restart_calls_file" | tr -d ' ')" "2"

echo "== recovery is announced once, then no more once it stays healthy"
: >"$calls_file"
FAKE_HEALTH_MODE=ok run_recovery >/dev/null
check "recovery alert fires" "$(wc -l <"$calls_file" | tr -d ' ')" "1"
: >"$calls_file"
FAKE_HEALTH_MODE=ok run_recovery >/dev/null
check "staying healthy does not re-alert" "$(wc -l <"$calls_file" | tr -d ' ')" "0"

echo "== a restart-stack.sh failure is still alerted, not silently absorbed"
reset_state
FAKE_HEALTH_MODE=bad PROXY_CONFIRM_THRESHOLD=1 FAKE_RESTART_EXIT=1 run_recovery >/dev/null
check "restart-stack.sh was invoked" "$(wc -l <"$restart_calls_file" | tr -d ' ')" "1"
check "a failed restart still alerts" "$([ "$(wc -l <"$calls_file" | tr -d ' ')" -ge 2 ] && echo yes)" "yes"

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all proxy-recovery checks passed"
