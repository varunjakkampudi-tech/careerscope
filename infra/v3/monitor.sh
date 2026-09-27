#!/usr/bin/env bash
# Host-native monitor for CS-24: "nothing watches the running system."
#
# Runs standalone on the host (via careerscope-monitor.timer), independent of
# every container it checks, so it keeps working when the whole stack - API,
# workers, even Postgres - is down. It never touches Docker's network or
# nftables state and adds no published port; it only reads.
#
# Classification, in priority order (worst first):
#   unreachable - the public health endpoint could not be reached at all
#                 (DNS, connect, TLS or timeout failure)
#   unhealthy   - it responded, but not with a 200 and status "ok"
#   stopped     - it is healthy, but a worker container is not running
#   stale       - workers are running, but durable work is not draining
#                 (the same expiredLeases/oldestUnpublished/oldestRunning
#                 signal the publisher already computes for its own log,
#                 read here directly from Postgres via `docker exec psql`
#                 so nothing new is exposed over the network)
#   ok          - none of the above
#
# Alerting is edge-triggered plus a bounded re-notify interval, so a real
# outage does not go silent after the first alert but a flapping check does
# not spam the channel every 5 minutes either.
set -euo pipefail

MONITOR_URL=${MONITOR_URL:-https://careerscope.tech/api/health}
MONITOR_WEBHOOK_URL=${MONITOR_WEBHOOK_URL:-}
MONITOR_CONTAINERS=${MONITOR_CONTAINERS:-careerscope-search-1 careerscope-files-1 careerscope-publisher-1}
MONITOR_DB_CONTAINER=${MONITOR_DB_CONTAINER:-careerscope-postgres-1}
MONITOR_STATE_DIR=${MONITOR_STATE_DIR:-/var/lib/careerscope-monitor}
MONITOR_RENOTIFY_SECONDS=${MONITOR_RENOTIFY_SECONDS:-3600}
MONITOR_STALE_SECONDS=${MONITOR_STALE_SECONDS:-300}
MONITOR_CURL_TIMEOUT=${MONITOR_CURL_TIMEOUT:-10}
# Overridable only for check-monitoring.sh's stub-based tests.
DOCKER_BIN=${MONITOR_DOCKER_BIN:-docker}
CURL_BIN=${MONITOR_CURL_BIN:-curl}

state_file="$MONITOR_STATE_DIR/state"
mkdir -p "$MONITOR_STATE_DIR"

status=ok
detail=""

# -- 1. reachability and health -----------------------------------------
health_body=""
if ! health_body=$("$CURL_BIN" -fsS --max-time "$MONITOR_CURL_TIMEOUT" "$MONITOR_URL" 2>/dev/null); then
  status=unreachable
  detail="could not reach $MONITOR_URL within ${MONITOR_CURL_TIMEOUT}s"
elif ! printf '%s' "$health_body" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
  status=unhealthy
  # Health responses never carry secrets (see app.ts's /api/health handler),
  # but cap it anyway - this is the one field in this script sourced from a
  # network response rather than from a value we generated ourselves.
  detail="unexpected response: $(printf '%s' "$health_body" | head -c 200)"
fi

# -- 2. worker containers actually running -------------------------------
if [ "$status" = ok ]; then
  stopped=""
  # set -f: MONITOR_CONTAINERS is intentionally split on spaces (a config
  # value, not a single path), but must never be glob-expanded against the
  # working directory - a value like "*" should be a config mistake, not a
  # pathname substitution.
  set -f
  for container in $MONITOR_CONTAINERS; do
    running=$("$DOCKER_BIN" inspect --format '{{.State.Running}}' "$container" 2>/dev/null || echo "missing")
    if [ "$running" != "true" ]; then
      stopped="$stopped $container"
    fi
  done
  set +f
  if [ -n "$stopped" ]; then
    status=stopped
    detail="not running:$stopped"
  fi
fi

# -- 3. durable work actually draining -----------------------------------
if [ "$status" = ok ]; then
  backlog_query="SELECT
      count(*) FILTER (WHERE o.published_at IS NULL),
      count(*) FILTER (WHERE e.status = 'running' AND e.lease_until < now()),
      coalesce(max(extract(epoch FROM now() - o.created_at)) FILTER (WHERE o.published_at IS NULL), 0),
      coalesce(max(extract(epoch FROM now() - o.created_at)) FILTER (WHERE e.status = 'running'), 0)
    FROM outbox_events o LEFT JOIN command_executions e ON e.id = o.id"
  if backlog=$("$DOCKER_BIN" exec "$MONITOR_DB_CONTAINER" psql -U careerscope -d careerscope -tAc "$backlog_query" 2>/dev/null); then
    IFS='|' read -r unpublished expired oldest_unpublished oldest_running <<<"$backlog"
    unpublished=${unpublished:-0}; expired=${expired:-0}
    oldest_unpublished=${oldest_unpublished:-0}; oldest_running=${oldest_running:-0}
    oldest_unpublished_i=${oldest_unpublished%.*}; oldest_running_i=${oldest_running%.*}
    if [ "${expired:-0}" -gt 0 ] 2>/dev/null \
      || [ "${oldest_unpublished_i:-0}" -gt "$MONITOR_STALE_SECONDS" ] 2>/dev/null \
      || [ "${oldest_running_i:-0}" -gt "$MONITOR_STALE_SECONDS" ] 2>/dev/null; then
      status=stale
      detail="expired leases=$expired oldest unpublished=${oldest_unpublished_i}s oldest running=${oldest_running_i}s"
    fi
  else
    # Cannot read the backlog signal at all - report it as unhealthy rather
    # than silently treating "could not check" the same as "checked and fine".
    status=unhealthy
    detail="could not query durable-work backlog via $MONITOR_DB_CONTAINER"
  fi
fi

# -- 4. notify on transition or after the re-notify window ---------------
now=$(date +%s)
previous_status="unknown"
previous_notified_at=0
if [ -f "$state_file" ]; then
  # shellcheck disable=SC1090
  . "$state_file"
  previous_status=${STATUS:-unknown}
  previous_notified_at=${NOTIFIED_AT:-0}
fi

should_notify=false
if [ "$status" != ok ] && { [ "$status" != "$previous_status" ] || [ "$((now - previous_notified_at))" -ge "$MONITOR_RENOTIFY_SECONDS" ]; }; then
  should_notify=true
elif [ "$status" = ok ] && [ "$previous_status" != ok ] && [ "$previous_status" != unknown ]; then
  should_notify=true
  detail="recovered (previously $previous_status)"
fi

message="CareerScope monitor: $status${detail:+ - $detail}"
echo "$message"

# Minimal JSON string escaping (backslash, quote, control chars). $message is
# built entirely from fixed keywords, container names and numbers this script
# itself produced - never raw network input - except the capped health body
# snippet, which goes through this same escape before being embedded.
json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=$(printf '%s' "$s" | tr -d '\000-\037')
  printf '%s' "$s"
}

notified_at=$previous_notified_at
if [ "$should_notify" = true ]; then
  notified_at=$now
  if [ -n "$MONITOR_WEBHOOK_URL" ]; then
    if [[ "$MONITOR_WEBHOOK_URL" != https://* ]]; then
      echo "MONITOR_WEBHOOK_URL is not https; refusing to send an alert in cleartext" >&2
    else
      # Both keys are sent so one payload works for a Slack incoming webhook
      # ("text") and a Discord incoming webhook ("content") without asking
      # which one is configured; each ignores the field it does not use.
      escaped_message=$(json_escape "$message")
      payload="{\"text\":\"$escaped_message\",\"content\":\"$escaped_message\"}"
      "$CURL_BIN" -fsS --max-time "$MONITOR_CURL_TIMEOUT" -X POST -H 'Content-Type: application/json' \
        -d "$payload" "$MONITOR_WEBHOOK_URL" >/dev/null \
        && echo "alert sent to webhook (${MONITOR_WEBHOOK_URL:0:20}...)" \
        || echo "alert webhook POST failed (${MONITOR_WEBHOOK_URL:0:20}...)" >&2
    fi
  else
    echo "no MONITOR_WEBHOOK_URL configured; alert only recorded to this log" >&2
  fi
fi

cat >"$state_file" <<EOF
STATUS=$status
NOTIFIED_AT=$notified_at
EOF

# This is an observability tool, not a gate: a check that cannot itself run
# (e.g. curl missing) already reports unreachable/unhealthy above, so exit 0
# always and let the alert, not the exit code, carry the signal.
exit 0
