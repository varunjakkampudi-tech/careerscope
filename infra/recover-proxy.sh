#!/usr/bin/env bash
# CS-3: "proxy restart strands every service behind a healthy-looking 502."
#
# Implements the System Designer's Option 1 + Option 2 (see .ai/backlog.json,
# CS-3's own completedSteps): a host-native, symptom-based detector for the
# exact failure restart-stack.sh's own header comment already documents -
# every container can report healthy while the proxy's network namespace is
# dead and every request answers 502 - that auto-invokes restart-stack.sh
# (the one supported recovery) once the symptom is confirmed, with a circuit
# breaker so a failure restart-stack.sh cannot fix does not thrash the stack
# forever.
#
# Deliberately separate from monitor.sh (CS-24): that script's job is general
# health/staleness observability across many possible causes; this one's job
# is exactly one specific, known failure mode and exactly one specific,
# already-reviewed recovery action.
set -euo pipefail

MONITOR_URL=${MONITOR_URL:-https://careerscope.tech/api/health}
MONITOR_WEBHOOK_URL=${MONITOR_WEBHOOK_URL:-}
PROXY_STATE_DIR=${PROXY_STATE_DIR:-/var/lib/careerscope-monitor}
# Require this many consecutive bad checks before acting - a single blip
# (a deploy in progress, a momentary network hiccup) must not trigger a
# restart-stack.sh run on its own.
CONFIRM_THRESHOLD=${PROXY_CONFIRM_THRESHOLD:-2}
# Circuit breaker: never auto-restart more than once inside this window,
# regardless of how many more bad checks follow - a failure restart-stack.sh
# cannot fix must not thrash Postgres/Redis/the workers repeatedly.
COOLDOWN_SECONDS=${PROXY_COOLDOWN_SECONDS:-3600}
CURL_TIMEOUT=${MONITOR_CURL_TIMEOUT:-10}
DOCKER_BIN=${MONITOR_DOCKER_BIN:-docker}
CURL_BIN=${MONITOR_CURL_BIN:-curl}
RESTART_SCRIPT=${PROXY_RESTART_SCRIPT:-"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/restart-stack.sh"}

state_file="$PROXY_STATE_DIR/proxy-recovery-state"
mkdir -p "$PROXY_STATE_DIR"

json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=$(printf '%s' "$s" | tr -d '\000-\037')
  printf '%s' "$s"
}

send_alert() {
  local message=$1
  echo "$message"
  if [ -z "$MONITOR_WEBHOOK_URL" ]; then
    echo "no MONITOR_WEBHOOK_URL configured; alert only recorded to this log" >&2
    return 0
  fi
  if [[ "$MONITOR_WEBHOOK_URL" != https://* ]]; then
    echo "MONITOR_WEBHOOK_URL is not https; refusing to send an alert in cleartext" >&2
    return 0
  fi
  local escaped; escaped=$(json_escape "$message")
  "$CURL_BIN" -fsS --max-time "$CURL_TIMEOUT" -X POST -H 'Content-Type: application/json' \
    -d "{\"text\":\"$escaped\",\"content\":\"$escaped\"}" "$MONITOR_WEBHOOK_URL" >/dev/null \
    && echo "alert sent to webhook (${MONITOR_WEBHOOK_URL:0:20}...)" \
    || echo "alert webhook POST failed (${MONITOR_WEBHOOK_URL:0:20}...)" >&2
}

# -- symptom check: does the public origin actually answer? -----------------
healthy=true
if ! health_body=$("$CURL_BIN" -fsS --max-time "$CURL_TIMEOUT" "$MONITOR_URL" 2>/dev/null); then
  healthy=false
elif ! printf '%s' "$health_body" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
  healthy=false
fi

consecutive=0
last_restart=0
if [ -f "$state_file" ]; then
  # shellcheck disable=SC1090
  . "$state_file"
  consecutive=${CONSECUTIVE:-0}
  last_restart=${LAST_RESTART:-0}
fi

now=$(date +%s)

if [ "$healthy" = true ]; then
  if [ "$consecutive" -ge "$CONFIRM_THRESHOLD" ]; then
    send_alert "CareerScope proxy recovery: origin answering again after $consecutive bad check(s)"
  else
    echo "origin healthy"
  fi
  cat >"$state_file" <<EOF
CONSECUTIVE=0
LAST_RESTART=$last_restart
EOF
  exit 0
fi

consecutive=$((consecutive + 1))
echo "origin unhealthy or unreachable (consecutive check: $consecutive)"

if [ "$consecutive" -lt "$CONFIRM_THRESHOLD" ]; then
  # Not yet confirmed - could be a single blip. Record the count and wait for
  # the next scheduled run to confirm before acting.
  cat >"$state_file" <<EOF
CONSECUTIVE=$consecutive
LAST_RESTART=$last_restart
EOF
  exit 0
fi

if [ "$((now - last_restart))" -lt "$COOLDOWN_SECONDS" ]; then
  send_alert "CareerScope proxy still down after $consecutive checks, but an auto-restart already ran within the last $((COOLDOWN_SECONDS / 60)) minutes - not retrying automatically again. Manual intervention needed: bash $RESTART_SCRIPT, or the force-recreate escape hatch it prints if that alone does not recover the stack."
  cat >"$state_file" <<EOF
CONSECUTIVE=$consecutive
LAST_RESTART=$last_restart
EOF
  exit 0
fi

send_alert "CareerScope proxy confirmed down after $consecutive checks - running restart-stack.sh automatically"
if "$RESTART_SCRIPT" >"$PROXY_STATE_DIR/last-restart-output" 2>&1; then
  send_alert "CareerScope proxy auto-restart completed; restart-stack.sh reported success"
else
  send_alert "CareerScope proxy auto-restart FAILED - restart-stack.sh itself did not report success. See $PROXY_STATE_DIR/last-restart-output on the host, or the force-recreate escape hatch it prints. Manual intervention needed."
fi

cat >"$state_file" <<EOF
CONSECUTIVE=$consecutive
LAST_RESTART=$now
EOF

exit 0
