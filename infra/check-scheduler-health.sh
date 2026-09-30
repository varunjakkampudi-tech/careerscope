#!/usr/bin/env bash
# Proves scheduler-health.sh (CS-47) actually looks, and actually fails.
#
# Runs entirely against stub `systemctl`, `systemd-analyze` and `curl`
# binaries driven by fixture files - it never touches a real host, a real
# systemd instance or a real webhook, so it runs on a laptop and in CI just
# like check-monitoring.sh (CS-24) and check-proxy-recovery.sh (CS-3).
#
# The point of this file is the negative cases. A scheduler-health check that
# has never been observed failing is not evidence of anything, and the
# specific way these checks have gone wrong in this repository before is
# "passed while unable to look": a parse failure, a missing unit or an empty
# read being treated as "nothing to report". Every one of those is asserted
# here to be a LOUD failure instead.
#
# Installing the unit on the real host and observing systemd's own behaviour
# is operator-only and is NOT covered here - see docs/OPERATIONS/MONITORING.md.
set -euo pipefail

dir="$(cd "$(dirname "$0")" && pwd)"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fixtures="$work/fixtures"
calls_file="$work/webhook-calls"
mkdir -p "$fixtures"
: >"$calls_file"

stamp() { date -u -d "@$1" '+%a %Y-%m-%d %H:%M:%S %Z'; }
# Ages are written relative to the clock AT FIXTURE-WRITE TIME, not to a
# timestamp captured once when the suite started: this suite spawns enough
# subprocesses to take minutes on some machines, and a frozen baseline would
# make the 5-minute monitor timer genuinely overdue halfway through the run.
ago() { stamp $(( $(date +%s) - $1 )); }
ahead() { stamp $(( $(date +%s) + $1 )); }

# ---------------------------------------------------------------- stubs --
cat >"$work/systemctl" <<'EOF'
#!/usr/bin/env bash
mode=${FAKE_SYSTEMCTL_MODE:-ok}
cmd=${1:-}
shift || true
case "$cmd" in
  show)
    unit=${1:-}
    case "$mode" in
      show-garbage) printf 'this is not key=value output\n@@@ garbage @@@\n'; exit 0 ;;
      show-empty) exit 0 ;;
      show-error) exit 1 ;;
    esac
    if [ -f "$FAKE_FIXTURE_DIR/$unit" ]; then cat "$FAKE_FIXTURE_DIR/$unit"; exit 0; fi
    # Real systemd exits 0 for an unknown unit and reports LoadState=not-found.
    printf 'LoadState=not-found\nActiveState=inactive\nUnitFileState=\n'
    exit 0
    ;;
  list-timers)
    case "$mode" in
      list-empty) exit 0 ;;
      list-error) exit 1 ;;
    esac
    echo "NEXT LEFT LAST PASSED UNIT ACTIVATES"
    for f in "$FAKE_FIXTURE_DIR"/*.timer; do
      [ -e "$f" ] || continue
      b=$(basename "$f")
      echo "-  -  -  -  $b  ${b%.timer}.service"
    done
    exit 0
    ;;
esac
exit 1
EOF
chmod +x "$work/systemctl"

# Stands in for systemd expanding the unit's own OnCalendar expression.
cat >"$work/systemd-analyze" <<'EOF'
#!/usr/bin/env bash
spec=${!#}
case "$spec" in
  Sun*) interval=604800 ;;
  *06,18*) interval=43200 ;;
  *) interval=86400 ;;
esac
base=$(( $(date +%s) + 600 ))
printf '  Original form: %s\n' "$spec"
printf 'Normalized form: %s\n' "$spec"
printf '    Next elapse: %s\n' "$(date -u -d "@$base" '+%a %Y-%m-%d %H:%M:%S %Z')"
printf '       (in UTC): %s\n' "$(date -u -d "@$base" '+%a %Y-%m-%d %H:%M:%S %Z')"
printf '       From now: 10min left\n'
printf '   Iteration #2: %s\n' "$(date -u -d "@$((base + interval))" '+%a %Y-%m-%d %H:%M:%S %Z')"
EOF
chmod +x "$work/systemd-analyze"

cat >"$work/curl" <<'EOF'
#!/usr/bin/env bash
echo "post" >>"$FAKE_CALLS_FILE"
exit 0
EOF
chmod +x "$work/curl"

# ------------------------------------------------------------- fixtures --
write_monotonic_timer() { # <unit> <age-seconds> <on-unit-active>
  cat >"$fixtures/$1" <<EOF
LoadState=loaded
ActiveState=active
UnitFileState=enabled
LastTriggerUSec=$(ago "$2")
NextElapseUSecRealtime=0
NextElapseUSecMonotonic=$3
TimersMonotonic={ OnBootUSec=2min } { OnUnitActiveUSec=$3 }
TimersCalendar=
Unit=${1%.timer}.service
EOF
}

write_calendar_timer() { # <unit> <age-seconds> <oncalendar-spec>
  cat >"$fixtures/$1" <<EOF
LoadState=loaded
ActiveState=active
UnitFileState=enabled
LastTriggerUSec=$(ago "$2")
NextElapseUSecRealtime=$(ahead 600)
NextElapseUSecMonotonic=0
TimersMonotonic=
TimersCalendar={ OnCalendar=$3 ; next_elapse=$(ahead 600) }
Unit=${1%.timer}.service
EOF
}

write_service() { # <unit> [result] [activestate] [execmainstatus]
  cat >"$fixtures/$1" <<EOF
LoadState=loaded
ActiveState=${3:-inactive}
Result=${2:-success}
ExecMainStatus=${4:-0}
EOF
}

reset_fixtures() {
  rm -rf "$fixtures"; mkdir -p "$fixtures"
  write_monotonic_timer careerscope-monitor.timer 120 5min
  write_monotonic_timer careerscope-proxy-recovery.timer 60 2min
  write_calendar_timer careerscope-backup.timer 3600 '*-*-* 03:30:00'
  write_calendar_timer careerscope-discovery.timer 3600 '*-*-* 06,18:00:00'
  write_calendar_timer careerscope-liveness.timer 3600 '*-*-* 04:00:00'
  write_calendar_timer careerscope-retention.timer 3600 'Sun *-*-* 05:00:00'
  for svc in monitor proxy-recovery backup discovery liveness retention; do
    write_service "careerscope-$svc.service"
  done
  rm -rf "$work/state"
  : >"$calls_file"
}

# ---------------------------------------------------------------- runner --
failures=0
check() {
  if [ "$2" = "$3" ]; then
    echo "PASS $1"
  else
    echo "FAIL $1 :: expected '$3', got '$2'"
    failures=$((failures + 1))
  fi
}

exit_code=0
run_check() {
  set +e
  SCHEDULER_SYSTEMCTL_BIN="${SYSTEMCTL_OVERRIDE:-$work/systemctl}" \
  SCHEDULER_ANALYZE_BIN="${ANALYZE_OVERRIDE:-$work/systemd-analyze}" \
  MONITOR_CURL_BIN="$work/curl" \
  SCHEDULER_STATE_DIR="$work/state" \
  SCHEDULER_WEBHOOK_URL="${WEBHOOK_OVERRIDE:-https://hooks.example.test/alert}" \
  FAKE_FIXTURE_DIR="$fixtures" \
  FAKE_CALLS_FILE="$calls_file" \
  bash "$dir/scheduler-health.sh" >"$work/stdout" 2>"$work/stderr"
  exit_code=$?
  set -e
  cat "$work/stdout"
}

alerts() { wc -l <"$calls_file" | tr -d ' '; }
# The whole report is one line, so count occurrences, not matching lines.
names() { grep -o "$1" "$work/stdout" | wc -l | tr -d ' '; }
occurrences() { grep -o "$1" "$work/stdout" | wc -l | tr -d ' '; }

echo "== VALID INPUT: all six timers present, recent, successful"
reset_fixtures
run_check >/dev/null
check "exit 0 when every watched timer is healthy" "$exit_code" "0"
check "reports ok" "$(grep -c 'scheduler health: ok' "$work/stdout")" "1"
check "no alert sent when healthy" "$(alerts)" "0"
check "the healthy line states all six were checked" "$(grep -c 'all 6 timers' "$work/stdout")" "1"

echo "== INVALID INPUT: one timer overdue (backup, the strictest)"
reset_fixtures
write_calendar_timer careerscope-backup.timer $((36 * 3600)) '*-*-* 03:30:00'
run_check >/dev/null
check "overdue timer exits non-zero" "$exit_code" "1"
check "the alert names the overdue timer" "$(names 'careerscope-backup.timer: OVERDUE')" "1"
check "it is marked HIGH per the ticket ranking" "$(occurrences '\[HIGH\] careerscope-backup.timer')" "1"
check "no other timer is named" "$(names 'careerscope-monitor.timer')" "0"
check "exactly one aggregated alert is sent" "$(alerts)" "1"

echo "== INVALID INPUT: a service that ran but did NOT succeed"
reset_fixtures
write_service careerscope-monitor.service failed failed 1
run_check >/dev/null
check "Result=failed exits non-zero" "$exit_code" "1"
check "the alert names the failed service" "$(names 'careerscope-monitor.service: last run did NOT succeed')" "1"

echo "== INVALID INPUT: a timer that exists but is disabled"
reset_fixtures
sed -i 's/UnitFileState=enabled/UnitFileState=disabled/' "$fixtures/careerscope-proxy-recovery.timer"
run_check >/dev/null
check "a disabled timer exits non-zero" "$exit_code" "1"
check "the alert says it will not run again" "$(names 'careerscope-proxy-recovery.timer: not enabled')" "1"

echo "== INVALID INPUT: a timer that is loaded but not active"
reset_fixtures
sed -i 's/ActiveState=active/ActiveState=inactive/' "$fixtures/careerscope-liveness.timer"
run_check >/dev/null
check "an inactive timer exits non-zero" "$exit_code" "1"
check "the alert says nothing is scheduling it" "$(names 'careerscope-liveness.timer: timer is not active')" "1"

echo "== MALFORMED INPUT: LastTriggerUSec is n/a (never fired)"
reset_fixtures
sed -i 's/^LastTriggerUSec=.*/LastTriggerUSec=n\/a/' "$fixtures/careerscope-backup.timer"
run_check >/dev/null
check "n/a last-trigger exits non-zero" "$exit_code" "1"
check "it is reported as never having run, not as healthy" "$(names 'has never recorded a run')" "1"

echo "== MALFORMED INPUT: LastTriggerUSec is 0 / epoch-like"
reset_fixtures
sed -i 's/^LastTriggerUSec=.*/LastTriggerUSec=0/' "$fixtures/careerscope-backup.timer"
run_check >/dev/null
check "zero last-trigger exits non-zero" "$exit_code" "1"
reset_fixtures
sed -i 's/^LastTriggerUSec=.*/LastTriggerUSec=Thu 1970-01-01 00:00:00 UTC/' "$fixtures/careerscope-backup.timer"
run_check >/dev/null
check "epoch last-trigger exits non-zero" "$exit_code" "1"

echo "== MALFORMED INPUT: LastTriggerUSec is unparseable garbage"
reset_fixtures
sed -i 's/^LastTriggerUSec=.*/LastTriggerUSec=!!!not-a-time!!!/' "$fixtures/careerscope-monitor.timer"
run_check >/dev/null
check "unparseable last-trigger exits non-zero" "$exit_code" "1"
check "it names the timer it could not read" "$(names 'careerscope-monitor.timer')" "1"

echo "== MALFORMED INPUT: the expected interval cannot be derived"
reset_fixtures
sed -i 's/^TimersMonotonic=.*/TimersMonotonic={ OnUnitActiveUSec=wat }/' "$fixtures/careerscope-monitor.timer"
run_check >/dev/null
check "an underivable interval exits non-zero" "$exit_code" "1"
check "it says the expected interval is unknown" "$(names 'expected interval unknown')" "1"

echo "== MALFORMED INPUT: systemd-analyze missing (calendar intervals underivable)"
reset_fixtures
ANALYZE_OVERRIDE="$work/no-such-systemd-analyze" run_check >/dev/null
check "missing systemd-analyze exits non-zero" "$exit_code" "1"
check "all four calendar timers are named, not skipped" "$(occurrences 'could not derive the expected interval')" "4"
check "backup is among them" "$(names 'careerscope-backup.timer: could not derive')" "1"

echo "== MISSING UNIT: one timer is not installed at all"
reset_fixtures
rm -f "$fixtures/careerscope-backup.timer"
run_check >/dev/null
check "a missing timer unit exits 2 (structurally unverifiable)" "$exit_code" "2"
check "it names the missing unit" "$(names 'careerscope-backup.timer: not installed')" "1"
check "it refuses to call 5 of 6 a pass" "$(occurrences 'only 5 of 6 expected timers could be evaluated')" "1"
check "systemctl list-timers shortfall is reported too" "$(occurrences 'appear in systemctl list-timers')" "1"
check "the run is never described as ok" "$(grep -c 'scheduler health: ok' "$work/stdout")" "0"

echo "== MALFORMED INPUT: systemctl returns garbage"
reset_fixtures
FAKE_SYSTEMCTL_MODE=show-garbage run_check >/dev/null
check "garbage systemctl output exits 2" "$exit_code" "2"
check "it says the output could not be parsed, once per timer" "$(occurrences 'could not be parsed')" "6"
check "it never reports healthy" "$(grep -c 'scheduler health: ok' "$work/stdout")" "0"

echo "== MALFORMED INPUT: systemctl returns nothing"
reset_fixtures
FAKE_SYSTEMCTL_MODE=show-empty run_check >/dev/null
check "empty systemctl output exits 2" "$exit_code" "2"
check "an empty read is reported, not swallowed" "$(occurrences 'returned no output')" "6"

echo "== MALFORMED INPUT: systemctl itself errors"
reset_fixtures
FAKE_SYSTEMCTL_MODE=show-error run_check >/dev/null
check "a failing systemctl exits 2" "$exit_code" "2"
check "the failure is named per timer" "$(occurrences 'systemctl show failed')" "6"

echo "== MALFORMED INPUT: systemctl list-timers is empty"
reset_fixtures
FAKE_SYSTEMCTL_MODE=list-empty run_check >/dev/null
check "an empty list-timers exits 2" "$exit_code" "2"
check "it refuses to read an empty result as healthy" "$(grep -c 'refusing to read an empty result as healthy' "$work/stdout")" "1"

echo "== MISSING TOOL: systemctl is not on the host at all"
reset_fixtures
SYSTEMCTL_OVERRIDE="$work/no-such-systemctl" run_check >/dev/null
check "no systemctl exits 2" "$exit_code" "2"
check "it says it could not verify anything" "$(grep -c 'could NOT be verified for any timer' "$work/stdout")" "1"
check "it still alerts rather than dying quietly" "$(alerts)" "1"

echo "== AC3 ranking: the same relative overrun alerts on HIGH but not on LOWER"
reset_fixtures
# backup runs daily, 36h since its last run = 1.5x its interval -> overdue
# retention runs weekly, 10.5d since its last run = 1.5x its interval -> inside
# the lower-priority grace. Same relative lateness, different severity.
write_calendar_timer careerscope-backup.timer $((36 * 3600)) '*-*-* 03:30:00'
write_calendar_timer careerscope-retention.timer $((252 * 3600)) 'Sun *-*-* 05:00:00'
run_check >/dev/null
check "HIGH backup is overdue at 1.5x its interval" "$(names 'careerscope-backup.timer: OVERDUE')" "1"
check "LOWER retention is not, at the same 1.5x" "$(names 'careerscope-retention.timer: OVERDUE')" "0"

echo "== aggregation: several broken timers produce ONE alert naming each"
reset_fixtures
write_calendar_timer careerscope-backup.timer $((96 * 3600)) '*-*-* 03:30:00'
write_service careerscope-monitor.service failed failed 1
sed -i 's/UnitFileState=enabled/UnitFileState=disabled/' "$fixtures/careerscope-retention.timer"
run_check >/dev/null
check "exit is non-zero" "$exit_code" "1"
check "exactly one webhook POST for all three findings" "$(alerts)" "1"
check "backup named" "$(names 'careerscope-backup.timer')" "1"
check "monitor named" "$(names 'careerscope-monitor.service')" "1"
check "retention named" "$(names 'careerscope-retention.timer')" "1"
check "the count is stated" "$(grep -c '3 problem(s) across 6 timers' "$work/stdout")" "1"

echo "== alerting: edge-triggered, then recovery announced once"
reset_fixtures
write_calendar_timer careerscope-backup.timer $((96 * 3600)) '*-*-* 03:30:00'
run_check >/dev/null
check "first failing run alerts" "$(alerts)" "1"
run_check >/dev/null
check "the identical unchanged failure does not re-alert" "$(alerts)" "1"
check "but it still exits non-zero every time" "$exit_code" "1"
# Deliberately not reset_fixtures here: the state file must survive so the
# recovery transition is the thing being tested.
write_calendar_timer careerscope-backup.timer 3600 '*-*-* 03:30:00'
run_check >/dev/null
check "recovery exits 0" "$exit_code" "0"
check "recovery is announced once" "$(alerts)" "2"
check "the recovery message says so" "$(grep -c 'recovered' "$work/stdout")" "1"
run_check >/dev/null
check "staying healthy does not re-alert" "$(alerts)" "2"

echo "== security: the webhook URL is never printed in full"
reset_fixtures
write_calendar_timer careerscope-backup.timer $((96 * 3600)) '*-*-* 03:30:00'
run_check >/dev/null
check "full webhook URL absent from stdout" "$(grep -c '/alert' "$work/stdout")" "0"
check "full webhook URL absent from stderr" "$(grep -c '/alert' "$work/stderr")" "0"

echo "== security: a plain-http webhook URL is refused, not silently sent over"
reset_fixtures
write_calendar_timer careerscope-backup.timer $((96 * 3600)) '*-*-* 03:30:00'
WEBHOOK_OVERRIDE="http://hooks.example.test/alert" run_check >/dev/null
check "insecure webhook is not posted to" "$(alerts)" "0"
check "insecure webhook is refused, logged" "$(grep -c 'refusing to send' "$work/stderr")" "1"
check "the finding is still reported and still fails" "$exit_code" "1"

echo "== sanitization: an unexpected systemd value is stripped and capped"
reset_fixtures
long_value="exit-code\"?&\$(id)<script>$(printf 'A%.0s' $(seq 1 200))"
write_service careerscope-backup.service "$long_value" failed 1
run_check >/dev/null
check "the run fails" "$exit_code" "1"
check "the finding is still reported" "$(names 'careerscope-backup.service: last run did NOT succeed')" "1"
check "no double quote from the value reaches the message" "$(occurrences '\"')" "0"
check "no shell/HTML metacharacters reach the message" "$(occurrences '[<>&$]')" "0"
check "the value is capped at 64 characters" "$(occurrences 'A\{65,\}')" "0"
check "but is still shown, truncated" "$(occurrences 'A\{40,64\}')" "1"

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all scheduler-health checks passed"
