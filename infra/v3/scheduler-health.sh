#!/usr/bin/env bash
# CS-47: "nothing watches the six unattended host timers themselves."
#
# One host-native scheduler-health checker for all six existing timers
# (monitor, backup, discovery, liveness, retention, proxy-recovery), rather
# than six separate ad-hoc watchdogs. It reads real systemd state only -
# `systemctl show` / `systemctl list-timers` / `systemd-analyze calendar` -
# derives each timer's expected interval from the unit itself where systemd
# can tell it (TimersMonotonic for OnUnitActiveSec timers, the OnCalendar
# expression expanded by systemd-analyze for calendar timers) instead of
# duplicating the schedule here, and emits ONE aggregated, sanitized alert
# naming every timer that is overdue, failed, disabled, missing or
# unreadable.
#
# It never touches Docker, nftables or the proxy; it only reads systemd.
#
# THE CENTRAL RULE OF THIS SCRIPT (see the engineering contract): "I could
# not look" is never reported as "everything is fine." Every one of the
# following is a LOUD failure, never a silent pass:
#   - the timer unit is not installed (LoadState != loaded)
#   - the timer is disabled, or not active
#   - systemctl is missing, errors, or returns empty/unparseable output
#   - LastTriggerUSec is n/a, 0, epoch-like, absent or unparseable
#   - the expected interval cannot be derived from the unit
#   - an active timer has no next elapse scheduled at all
#   - the triggered service ever failed (Result != success, or a non-zero
#     ExecMainStatus, or ActiveState=failed)
#   - FEWER than SCHEDULER_EXPECTED_COUNT (6) timers could be evaluated, or
#     `systemctl list-timers` does not list all six
#
# Severity/strictness follows the ticket's second-opinion ranking (AC3):
#   HIGH   - backup, monitor, proxy-recovery
#   MEDIUM - discovery, liveness
#   LOWER  - retention
# Backup is the strictest of all: the ticket's own words are that a silently
# dead backup timer is the worst case, because the owner would believe
# recoverability exists when it does not. It therefore gets the smallest
# grace fraction (10% of its own derived interval) of any timer here.
#
# NOT a dead-man's-switch: this runs ON the host it watches, so it dies with
# the host. See docs/KNOWN-LIMITATIONS.md, "Nothing watches the watcher."
#
# Exit codes (deliberately NOT monitor.sh's always-0: this is a verifier as
# well as an alerter, and a green exit must mean "I looked at all six and
# they are fine"):
#   0 - all six timers evaluated and healthy
#   1 - evaluated, and at least one timer is overdue/failed/disabled
#   2 - structurally unable to verify (no systemctl, missing units, fewer
#       than six timers evaluated, unreadable systemd output)
set -euo pipefail

SCHEDULER_WEBHOOK_URL=${SCHEDULER_WEBHOOK_URL:-${MONITOR_WEBHOOK_URL:-}}
SCHEDULER_STATE_DIR=${SCHEDULER_STATE_DIR:-/var/lib/careerscope-monitor}
SCHEDULER_RENOTIFY_SECONDS=${SCHEDULER_RENOTIFY_SECONDS:-21600}
SCHEDULER_EXPECTED_COUNT=${SCHEDULER_EXPECTED_COUNT:-6}
SCHEDULER_MAX_MESSAGE_CHARS=${SCHEDULER_MAX_MESSAGE_CHARS:-1500}
CURL_TIMEOUT=${MONITOR_CURL_TIMEOUT:-10}
# Overridable only for check-scheduler-health.sh's stub-based tests.
SYSTEMCTL_BIN=${SCHEDULER_SYSTEMCTL_BIN:-systemctl}
ANALYZE_BIN=${SCHEDULER_ANALYZE_BIN:-systemd-analyze}
CURL_BIN=${MONITOR_CURL_BIN:-curl}

# unit : tier : grace as a percentage of the derived interval : grace floor (s)
#
# The floors matter for short-interval timers (10% of monitor's 5 minutes is
# 30 seconds, which would alert on ordinary systemd scheduling jitter); the
# percentages matter for long-interval ones. Every floor here is larger than
# the corresponding unit's own RandomizedDelaySec (300-600s), so a randomized
# start is never mistaken for an overdue run.
TIMER_POLICY="careerscope-backup.timer:HIGH:10:600
careerscope-monitor.timer:HIGH:50:600
careerscope-proxy-recovery.timer:HIGH:50:600
careerscope-discovery.timer:MEDIUM:100:1800
careerscope-liveness.timer:MEDIUM:100:1800
careerscope-retention.timer:LOWER:200:3600"

state_file="$SCHEDULER_STATE_DIR/scheduler-health-state"
mkdir -p "$SCHEDULER_STATE_DIR"

problems=()
problem_keys=()
structural=0
evaluated=0

# -- sanitization --------------------------------------------------------
# Everything that reaches the alert is either a literal this script wrote, a
# unit name from the hardcoded table above, a number this script computed, or
# a systemd state token passed through sanitize_token. No URL, no token, no
# env value, no command output body, no host path ever reaches the webhook.
sanitize_token() {
  local s=$1
  s=$(printf '%s' "$s" | tr -cd 'A-Za-z0-9._:+ -')
  printf '%s' "${s:0:64}"
}

json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  s=$(printf '%s' "$s" | tr -d '\000-\037')
  printf '%s' "$s"
}

send_alert() {
  local message=$1
  if [ -z "$SCHEDULER_WEBHOOK_URL" ]; then
    echo "no SCHEDULER_WEBHOOK_URL (or MONITOR_WEBHOOK_URL) configured; alert only recorded to this log" >&2
    return 0
  fi
  if [[ "$SCHEDULER_WEBHOOK_URL" != https://* ]]; then
    echo "SCHEDULER_WEBHOOK_URL is not https; refusing to send an alert in cleartext" >&2
    return 0
  fi
  local escaped; escaped=$(json_escape "$message")
  "$CURL_BIN" -fsS --max-time "$CURL_TIMEOUT" -X POST -H 'Content-Type: application/json' \
    -d "{\"text\":\"$escaped\",\"content\":\"$escaped\"}" "$SCHEDULER_WEBHOOK_URL" >/dev/null \
    && echo "alert sent to webhook (${SCHEDULER_WEBHOOK_URL:0:20}...)" \
    || echo "alert webhook POST failed (${SCHEDULER_WEBHOOK_URL:0:20}...)" >&2
}

record_problem() {
  local key=$1 tier=$2 text=$3
  problem_keys+=("$key")
  problems+=("[$tier] $text")
}

record_structural() {
  structural=1
  record_problem "$1" CRITICAL "$2"
}

# -- parsing helpers (every one FAILS rather than returning a default) ----
trim() { printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }

prop() { # prop <show-output> <key>  -> value (may be empty; callers check)
  printf '%s\n' "$1" | sed -n "s/^$2=//p" | head -1
}

# systemd renders timestamps either as raw microseconds (older) or as a
# human string (newer). Accept both; refuse anything else. "n/a", 0 and any
# epoch-like value are refused, not defaulted.
parse_timestamp() { # -> epoch seconds on stdout, non-zero exit if unusable
  local v; v=$(trim "$1")
  [ -n "$v" ] || return 1
  case "$v" in n/a|N/A|-|0) return 1 ;; esac
  if [[ "$v" =~ ^[0-9]+$ ]]; then
    local sec=$(( v / 1000000 ))
    [ "$sec" -ge 1000000000 ] || return 1
    printf '%s' "$sec"; return 0
  fi
  local e
  e=$(date -d "$v" +%s 2>/dev/null) || return 1
  [[ "$e" =~ ^[0-9]+$ ]] || return 1
  [ "$e" -ge 1000000000 ] || return 1
  printf '%s' "$e"
}

# systemd renders timespans either as raw microseconds or as "1h 30min 5s".
# Sub-second units are ignored for the total but still count as parsed.
parse_timespan() { # -> whole seconds on stdout, non-zero exit if unusable
  local v; v=$(trim "$1")
  [ -n "$v" ] || return 1
  case "$v" in infinity|n/a|N/A|-) return 1 ;; esac
  if [[ "$v" =~ ^[0-9]+$ ]]; then
    printf '%s' $(( v / 1000000 )); return 0
  fi
  local spaced total=0 matched=0 num='' tok
  spaced=$(printf '%s' "$v" | sed -E 's/([0-9])([A-Za-z])/\1 \2/g; s/([A-Za-z])([0-9])/\1 \2/g')
  for tok in $spaced; do
    if [[ "$tok" =~ ^[0-9]+$ ]]; then
      [ -z "$num" ] || return 1   # two numbers in a row: not a timespan
      num=$tok
      continue
    fi
    [ -n "$num" ] || return 1     # a unit with no number before it
    case "$tok" in
      us|usec|microseconds|microsecond|ms|msec|milliseconds|millisecond) : ;;
      s|sec|secs|second|seconds) total=$((total + num)) ;;
      m|min|mins|minute|minutes) total=$((total + num * 60)) ;;
      h|hr|hour|hours) total=$((total + num * 3600)) ;;
      d|day|days) total=$((total + num * 86400)) ;;
      w|week|weeks) total=$((total + num * 604800)) ;;
      M|month|months) total=$((total + num * 2629800)) ;;
      y|year|years) total=$((total + num * 31557600)) ;;
      *) return 1 ;;
    esac
    matched=1; num=''
  done
  [ -z "$num" ] || return 1
  [ "$matched" = 1 ] || return 1
  [ "$total" -gt 0 ] || return 1
  printf '%s' "$total"
}

human_duration() {
  local s=$1
  if [ "$s" -lt 120 ]; then printf '%ss' "$s"
  elif [ "$s" -lt 7200 ]; then printf '%sm' "$((s / 60))"
  elif [ "$s" -lt 172800 ]; then printf '%sh' "$((s / 3600))"
  else printf '%sd' "$((s / 86400))"; fi
}

# Interval for an OnUnitActiveSec/OnBootSec timer, taken from the unit's own
# TimersMonotonic property, e.g.
#   TimersMonotonic={ OnBootUSec=2min } { OnUnitActiveUSec=5min }
monotonic_interval() { # <TimersMonotonic value> -> seconds
  local v=$1 key raw
  for key in OnUnitActiveUSec OnUnitInactiveUSec OnBootUSec OnStartupUSec; do
    raw=$(printf '%s' "$v" | sed -n "s/.*$key=\([^};]*\).*/\1/p" | head -1)
    raw=$(trim "$raw")
    [ -n "$raw" ] || continue
    parse_timespan "$raw" && return 0
    return 1   # present but unparseable: fail, never fall through to a guess
  done
  return 1
}

# Interval for a calendar timer, derived by asking systemd itself to expand
# the unit's own OnCalendar expression twice and taking the difference -
# rather than restating the schedule in this file, where it could silently
# drift away from the unit.
calendar_interval() { # <OnCalendar spec> -> seconds
  local spec=$1 out t1 t2 e1 e2 delta
  command -v "$ANALYZE_BIN" >/dev/null 2>&1 || return 1
  out=$("$ANALYZE_BIN" calendar --iterations=2 "$spec" 2>/dev/null) || return 1
  [ -n "$out" ] || return 1
  t1=$(printf '%s\n' "$out" | sed -n 's/^[[:space:]]*Next elapse:[[:space:]]*//p' | head -1)
  t2=$(printf '%s\n' "$out" | sed -n 's/^[[:space:]]*Iter[^#]*#2:[[:space:]]*//p' | head -1)
  e1=$(parse_timestamp "$t1") || return 1
  e2=$(parse_timestamp "$t2") || return 1
  delta=$((e2 - e1))
  [ "$delta" -gt 0 ] || return 1
  printf '%s' "$delta"
}

now=$(date +%s)

# -- 0. can we look at all? ----------------------------------------------
if ! command -v "$SYSTEMCTL_BIN" >/dev/null 2>&1; then
  record_structural "systemctl-missing" \
    "systemctl is not available - scheduler health could NOT be verified for any timer"
else
  # -- 1. independent cross-check: does systemd itself list all six? ------
  # An empty or short result set here is a failure, not a pass.
  timers_listed=""
  if ! timers_listed=$("$SYSTEMCTL_BIN" list-timers --all --no-pager 2>/dev/null); then
    record_structural "list-timers-failed" \
      "systemctl list-timers failed - could not confirm any timer is scheduled"
  elif [ -z "$(trim "$timers_listed")" ]; then
    record_structural "list-timers-empty" \
      "systemctl list-timers returned nothing - refusing to read an empty result as healthy"
  else
    listed_count=0
    missing_from_listing=""
    while IFS=: read -r unit _tier _pct _floor; do
      [ -n "$unit" ] || continue
      if printf '%s\n' "$timers_listed" | grep -Fq "$unit"; then
        listed_count=$((listed_count + 1))
      else
        missing_from_listing="$missing_from_listing $unit"
      fi
    done <<<"$TIMER_POLICY"
    if [ "$listed_count" -lt "$SCHEDULER_EXPECTED_COUNT" ]; then
      record_structural "list-timers-short" \
        "only $listed_count of $SCHEDULER_EXPECTED_COUNT expected timers appear in systemctl list-timers; absent:$(sanitize_token "$missing_from_listing")"
    fi
  fi

  # -- 2. per-timer evaluation ------------------------------------------
  while IFS=: read -r unit tier pct floor; do
    [ -n "$unit" ] || continue
    service=""
    show_out=""
    if ! show_out=$("$SYSTEMCTL_BIN" show "$unit" --no-pager \
      --property=LoadState --property=ActiveState --property=UnitFileState \
      --property=LastTriggerUSec --property=NextElapseUSecRealtime \
      --property=NextElapseUSecMonotonic --property=TimersMonotonic \
      --property=TimersCalendar --property=Unit 2>/dev/null); then
      record_problem "$unit:show-failed" "$tier" "$unit: systemctl show failed - state unknown, NOT assumed healthy"
      continue
    fi
    if [ -z "$(trim "$show_out")" ]; then
      record_problem "$unit:show-empty" "$tier" "$unit: systemctl show returned no output - state unknown, NOT assumed healthy"
      continue
    fi

    load_state=$(trim "$(prop "$show_out" LoadState)")
    if [ -z "$load_state" ]; then
      record_problem "$unit:show-unparseable" "$tier" "$unit: systemctl show output could not be parsed (no LoadState) - state unknown, NOT assumed healthy"
      continue
    fi
    if [ "$load_state" != loaded ]; then
      record_problem "$unit:not-loaded" "$tier" "$unit: not installed/loaded (LoadState=$(sanitize_token "$load_state"))"
      continue
    fi

    # From here on we have a real, loaded unit, so it counts as evaluated
    # even if it turns out to be unhealthy.
    evaluated=$((evaluated + 1))

    file_state=$(trim "$(prop "$show_out" UnitFileState)")
    active_state=$(trim "$(prop "$show_out" ActiveState)")
    case "$file_state" in
      enabled|enabled-runtime|static) : ;;
      "") record_problem "$unit:filestate-unknown" "$tier" "$unit: enablement state unreadable - NOT assumed enabled"; continue ;;
      *) record_problem "$unit:disabled" "$tier" "$unit: not enabled (UnitFileState=$(sanitize_token "$file_state")) - it will not run again"; continue ;;
    esac
    if [ "$active_state" != active ]; then
      record_problem "$unit:inactive" "$tier" "$unit: timer is not active (ActiveState=$(sanitize_token "${active_state:-unreadable}")) - nothing is scheduling it"
      continue
    fi

    # An active timer with no next elapse at all is not scheduling anything.
    next_real=$(trim "$(prop "$show_out" NextElapseUSecRealtime)")
    next_mono=$(trim "$(prop "$show_out" NextElapseUSecMonotonic)")
    has_next=no
    if parse_timestamp "$next_real" >/dev/null 2>&1; then has_next=yes; fi
    if [ "$has_next" = no ] && parse_timespan "$next_mono" >/dev/null 2>&1; then has_next=yes; fi
    if [ "$has_next" = no ]; then
      record_problem "$unit:no-next-elapse" "$tier" "$unit: active but has no next elapse scheduled - it will not fire again"
      continue
    fi

    # Expected interval, derived from the unit itself.
    interval=""
    timers_mono=$(prop "$show_out" TimersMonotonic)
    timers_cal=$(prop "$show_out" TimersCalendar)
    if [ -n "$(trim "$timers_mono")" ]; then
      if ! interval=$(monotonic_interval "$timers_mono"); then
        record_problem "$unit:interval-unparseable" "$tier" "$unit: TimersMonotonic could not be parsed - expected interval unknown, NOT assumed healthy"
        continue
      fi
    elif [ -n "$(trim "$timers_cal")" ]; then
      cal_spec=$(trim "$(printf '%s' "$timers_cal" | sed -n 's/.*OnCalendar=\([^;}]*\).*/\1/p' | head -1)")
      if [ -z "$cal_spec" ]; then
        record_problem "$unit:calendar-unreadable" "$tier" "$unit: TimersCalendar present but no OnCalendar expression could be read - expected interval unknown"
        continue
      fi
      if ! interval=$(calendar_interval "$cal_spec"); then
        record_problem "$unit:calendar-underivable" "$tier" "$unit: could not derive the expected interval from its own OnCalendar expression (systemd-analyze missing or unparseable)"
        continue
      fi
    else
      record_problem "$unit:no-schedule" "$tier" "$unit: has neither a monotonic nor a calendar schedule - expected interval unknown"
      continue
    fi

    # Last run. n/a, 0, epoch-like and unparseable are all failures.
    last_raw=$(prop "$show_out" LastTriggerUSec)
    if ! last_epoch=$(parse_timestamp "$last_raw"); then
      record_problem "$unit:never-triggered" "$tier" "$unit: has never recorded a run (LastTriggerUSec=$(sanitize_token "${last_raw:-absent}")) - cannot confirm it has ever fired"
      continue
    fi
    age=$((now - last_epoch))
    if [ "$age" -lt 0 ]; then
      record_problem "$unit:last-run-in-future" "$tier" "$unit: last run is in the future - host clock or systemd state is inconsistent, NOT assumed healthy"
      continue
    fi

    grace=$(( interval * pct / 100 ))
    [ "$grace" -ge "$floor" ] || grace=$floor
    if [ "$age" -gt $((interval + grace)) ]; then
      record_problem "$unit:overdue" "$tier" \
        "$unit: OVERDUE - last run $(human_duration "$age") ago, expected every $(human_duration "$interval") (+$(human_duration "$grace") grace)"
      continue
    fi

    # The triggered service's own outcome. A timer that fires perfectly into
    # a service that fails every time is not healthy.
    service=$(trim "$(prop "$show_out" Unit)")
    if [ -z "$service" ]; then
      record_problem "$unit:no-triggered-unit" "$tier" "$unit: systemd reports no unit for this timer to trigger"
      continue
    fi
    if ! svc_out=$("$SYSTEMCTL_BIN" show "$service" --no-pager \
      --property=LoadState --property=ActiveState --property=Result \
      --property=ExecMainStatus 2>/dev/null) || [ -z "$(trim "$svc_out")" ]; then
      record_problem "$unit:service-unreadable" "$tier" "$service: could not be read - outcome of the last run unknown, NOT assumed successful"
      continue
    fi
    svc_load=$(trim "$(prop "$svc_out" LoadState)")
    svc_result=$(trim "$(prop "$svc_out" Result)")
    svc_active=$(trim "$(prop "$svc_out" ActiveState)")
    svc_status=$(trim "$(prop "$svc_out" ExecMainStatus)")
    if [ "$svc_load" != loaded ]; then
      record_problem "$unit:service-not-loaded" "$tier" "$service: not installed/loaded (LoadState=$(sanitize_token "${svc_load:-unreadable}"))"
      continue
    fi
    if [ -z "$svc_result" ]; then
      record_problem "$unit:service-result-unreadable" "$tier" "$service: last result unreadable - NOT assumed successful"
      continue
    fi
    if [ "$svc_result" != success ]; then
      record_problem "$unit:service-failed" "$tier" "$service: last run did NOT succeed (Result=$(sanitize_token "$svc_result"))"
      continue
    fi
    if [ "$svc_active" = failed ]; then
      record_problem "$unit:service-active-failed" "$tier" "$service: unit is in the failed state"
      continue
    fi
    if [ -n "$svc_status" ] && [[ "$svc_status" =~ ^[0-9]+$ ]] && [ "$svc_status" -ne 0 ]; then
      record_problem "$unit:service-exit-nonzero" "$tier" "$service: last run exited non-zero (ExecMainStatus=$(sanitize_token "$svc_status"))"
      continue
    fi
  done <<<"$TIMER_POLICY"

  # -- 3. a short result set is a failure, not a pass --------------------
  if [ "$evaluated" -lt "$SCHEDULER_EXPECTED_COUNT" ]; then
    record_structural "short-result-set" \
      "only $evaluated of $SCHEDULER_EXPECTED_COUNT expected timers could be evaluated at all"
  fi
fi

# -- 4. one aggregated, sanitized message --------------------------------
count=${#problems[@]}
if [ "$count" -eq 0 ]; then
  status=ok
  message="CareerScope scheduler health: ok - all $SCHEDULER_EXPECTED_COUNT timers enabled, active, within their expected interval, last run successful"
else
  if [ "$structural" -eq 1 ]; then status=blind; else status=degraded; fi
  detail=""
  for p in "${problems[@]}"; do
    detail="${detail:+$detail; }$p"
  done
  message="CareerScope scheduler health: $status - $count problem(s) across $SCHEDULER_EXPECTED_COUNT timers - $detail"
  message=${message:0:$SCHEDULER_MAX_MESSAGE_CHARS}
fi

# -- 5. notify on change, or after the re-notify window -------------------
# The notify decision is made BEFORE the message is logged, so that the
# recovery line ("recovered - all six healthy again") reaches the journal and
# not only the webhook. Getting this the other way round meant the journal
# showed a plain "ok" for a recovery, which is exactly the kind of quiet
# reporting this ticket exists to remove.
signature=0
if [ "$count" -gt 0 ]; then
  signature=$(printf '%s\n' "${problem_keys[@]}" | sort | cksum | awk '{print $1}')
fi

previous_signature=""
previous_notified_at=0
if [ -f "$state_file" ]; then
  # shellcheck disable=SC1090
  . "$state_file"
  previous_signature=${SIGNATURE:-}
  previous_notified_at=${NOTIFIED_AT:-0}
fi

should_notify=false
if [ "$count" -gt 0 ] && { [ "$signature" != "$previous_signature" ] \
  || [ "$((now - previous_notified_at))" -ge "$SCHEDULER_RENOTIFY_SECONDS" ]; }; then
  should_notify=true
elif [ "$count" -eq 0 ] && [ -n "$previous_signature" ] && [ "$previous_signature" != 0 ]; then
  should_notify=true
  message="CareerScope scheduler health: recovered - all $SCHEDULER_EXPECTED_COUNT timers healthy again"
fi

echo "$message"

notified_at=$previous_notified_at
if [ "$should_notify" = true ]; then
  notified_at=$now
  send_alert "$message"
fi

cat >"$state_file" <<EOF
SIGNATURE=$signature
NOTIFIED_AT=$notified_at
EOF

if [ "$structural" -eq 1 ]; then exit 2; fi
if [ "$count" -gt 0 ]; then exit 1; fi
exit 0
