# Operations — Monitoring

## Why this exists

`/api/health` has always existed, but nothing ever called it. If the workers
stopped, the way anyone found out was noticing that no new jobs appeared. This
is CS-24: a host-native monitor that watches the running system and says
something the moment it stops behaving, without anyone opening the app.

## What it checks, in priority order

| Status        | Meaning                                                                                                                                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unreachable` | `/api/health` could not be reached at all (DNS, connect, TLS, timeout)                                                                                                                                           |
| `unhealthy`   | it responded, but not `200` with `status: "ok"`                                                                                                                                                                  |
| `stopped`     | it is healthy, but a worker container (`search`/`files`/`publisher`) is not running                                                                                                                              |
| `stale`       | workers are running, but durable work is not draining — the same `expiredLeases` / `oldestUnpublishedSeconds` / `oldestRunningSeconds` signal the publisher already logs for itself, read directly from Postgres |
| `ok`          | none of the above                                                                                                                                                                                                |

Only the first failing check in that order is reported per run — there is no
need to also say "unhealthy" when the host is fully unreachable.

## How it runs

[monitor.sh](../../infra/v3/monitor.sh) runs **on the host**, not in a
container, via `careerscope-monitor.timer` (every 5 minutes — three chances to
notify inside the 15-minute detection window this ticket's acceptance
criterion asks for, even if one run is skipped). Running on the host, outside
every container it checks, means it keeps working when the entire stack —
API, workers, even Postgres — is down.

It adds no published port and opens no new inbound path: the worker check
uses `docker inspect` and the backlog check uses `docker exec ... psql`, both
already-available host-to-container operations, not a new network route.

## Install

```sh
bash infra/v3/setup-monitoring.sh
```

Idempotent — re-run after editing `monitor.sh` or after changing
`/etc/careerscope-monitor.env`. Before running it, or any time after, put your
webhook URL in `/etc/careerscope-monitor.env` (root-only, mode `600`):

```
MONITOR_WEBHOOK_URL=https://hooks.slack.com/services/...
```

One payload works for both a Slack incoming webhook (`text`) and a Discord
incoming webhook (`content`) without asking which one is configured — both
keys are sent, each side ignores the field it does not use. The URL must be
`https://`; a plain-`http` webhook is refused rather than sent over in
cleartext. Without a webhook configured, the monitor still runs and still logs
every classification to the journal — it just cannot notify anywhere else.

## Alerting behaviour

Edge-triggered, not periodic: an alert fires the moment the status changes
(including recovery, announced once), and while a failure continues, the
monitor re-notifies only after `MONITOR_RENOTIFY_SECONDS` (default one hour) —
so a real outage is never silent for good, but a flapping check does not spam
the channel every 5 minutes either.

## Verification

```sh
bash infra/v3/check-monitoring.sh
```

Runs entirely against stub `docker`/`curl` binaries — every classification,
the notify-once-per-transition behaviour, the re-notify window, and that an
insecure webhook URL is refused rather than used. It proves the logic without
touching a real host, container or webhook, so it also runs on a laptop or in
CI.

### The one thing that cannot be automated

CS-24's own acceptance criterion is explicit: "proven by stopping a container
and observing the alert, not by reading the config." That is a one-time manual
proof against the real deployment, after `setup-monitoring.sh`:

```sh
docker stop careerscope-search-1
# within 3 monitor runs (~15 minutes), or immediately with:
systemctl start careerscope-monitor.service
journalctl -u careerscope-monitor.service -n 5 --no-pager   # expect "stopped"
# confirm the alert actually arrived at the configured webhook, then:
docker start careerscope-search-1
systemctl start careerscope-monitor.service                 # expect "ok" / "recovered"
```

## Known limitation

`monitor.sh` itself is not currently monitored by anything else — a systemd
timer that silently stops (a corrupted unit file, `systemctl disable` run by
mistake) has no independent watcher. `systemctl list-timers` shows whether it
last ran; there is no second-order alert for "the alerter stopped alerting."
Recorded in [KNOWN-LIMITATIONS](../KNOWN-LIMITATIONS.md) rather than solved
here — a true "watch the watcher" needs an external, off-host service (e.g. a
dead-man's-switch ping service), which is new infrastructure and outside this
ticket's scope.

**Partly addressed since, by CS-47** — see below. The scheduler-health check
now watches whether this timer (and the other five) is still firing. It does
**not** close the off-host half of the gap.

---

# Scheduler health — watching the six timers themselves (CS-47)

## Why this exists

Six systemd timers now run unattended: `careerscope-monitor.timer`,
`careerscope-backup.timer`, `careerscope-discovery.timer`,
`careerscope-liveness.timer`, `careerscope-retention.timer` and
`careerscope-proxy-recovery.timer`. If any one of them silently stops firing,
nothing alerted on that absence. The worst case is the backup timer: the
owner would believe recoverability exists when it does not.

`infra/v3/scheduler-health.sh` is **one** checker for all six, not six
watchdogs.

## What it checks, per timer

| Signal read                                         | Failure reported when                                                      |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| `LoadState`                                         | the timer (or its service) is not installed/loaded                         |
| `UnitFileState`                                     | the timer is not enabled — it will not run again                           |
| `ActiveState`                                       | the timer is not active — nothing is scheduling it                         |
| `NextElapseUSecRealtime` / `...Monotonic`           | an active timer has no next elapse at all                                  |
| `TimersMonotonic` / `TimersCalendar`                | the expected interval cannot be derived from the unit itself               |
| `LastTriggerUSec`                                   | `n/a`, `0`, epoch-like, absent, unparseable, in the future, or **overdue** |
| service `Result` / `ActiveState` / `ExecMainStatus` | the last run did not succeed                                               |

The expected interval is taken from the unit, not restated here: monotonic
timers from their own `OnUnitActiveUSec`/`OnBootUSec`, calendar timers by
asking `systemd-analyze calendar --iterations=2` to expand the unit's own
`OnCalendar` expression and taking the difference. A schedule change in a
unit file therefore cannot silently drift away from what this checker
expects.

## Overdue thresholds — strictest first

A timer is overdue when its last run is older than `interval + grace`. The
grace follows the ticket's HIGH/MEDIUM/LOWER ranking, and the floors are all
larger than the corresponding unit's `RandomizedDelaySec`, so a randomized
start is never mistaken for a missed run.

| Timer                              | Rank   | Grace                     |
| ---------------------------------- | ------ | ------------------------- |
| `careerscope-backup.timer`         | HIGH   | 10% of interval, min 10m  |
| `careerscope-monitor.timer`        | HIGH   | 50% of interval, min 10m  |
| `careerscope-proxy-recovery.timer` | HIGH   | 50% of interval, min 10m  |
| `careerscope-discovery.timer`      | MEDIUM | 100% of interval, min 30m |
| `careerscope-liveness.timer`       | MEDIUM | 100% of interval, min 30m |
| `careerscope-retention.timer`      | LOWER  | 200% of interval, min 1h  |

Backup is deliberately the strictest of the six.

## "I could not look" is never "everything is fine"

This is the design rule of the script. A missing `systemctl`, an erroring or
empty `systemctl show`, output that does not parse, a unit that is absent, or
any run in which **fewer than six** timers could be evaluated, are all
reported loudly and exit non-zero. There is no code path in which an
unreadable state produces a healthy report.

Exit codes:

| Code | Meaning                                                                   |
| ---- | ------------------------------------------------------------------------- |
| `0`  | all six evaluated and healthy                                             |
| `1`  | evaluated, and at least one timer is overdue/failed/disabled              |
| `2`  | structurally unable to verify (no `systemctl`, missing units, short read) |

A non-zero exit is the intended way this unit reports a finding, so systemd
marking `careerscope-scheduler-health.service` failed is correct — the
condition shows up in `systemctl list-units --failed` as well as in the alert.

## Alerting

One aggregated alert per run, naming every affected unit, through the same
webhook pattern the other host scripts use: `SCHEDULER_WEBHOOK_URL` if set,
otherwise `MONITOR_WEBHOOK_URL` from `/etc/careerscope-monitor.env`. The URL
must be `https://`; a plain-`http` webhook is refused rather than sent over in
cleartext, and the URL is never printed in full. Edge-triggered: an unchanged
finding does not re-alert until `SCHEDULER_RENOTIFY_SECONDS` (default 6h), and
recovery is announced once.

The message contains only unit names, systemd state tokens (character-filtered
and capped at 64 characters), and staleness in coarse units. No URL, no token,
no environment value, no command output body and no host path ever reaches it.

## Install (operator-only — not yet performed)

```sh
bash infra/v3/setup-scheduler-health.sh
```

Requires root, `systemctl` and `systemd-analyze`. Install the six watched
timers first: until a watched timer has actually fired once, this checker
reports it as "has never recorded a run" — deliberately, because it genuinely
cannot confirm that timer has ever fired.

## Verification

```sh
bash infra/v3/check-scheduler-health.sh
```

Runs entirely against stub `systemctl`, `systemd-analyze` and `curl` binaries:
a healthy six-timer host passes, and every failure mode above is asserted to
fail loudly — an overdue timer, a failed service, a disabled timer, an
inactive timer, an `n/a`/`0`/epoch/garbage last-trigger, an underivable
interval, a missing unit, garbage/empty/erroring/absent `systemctl`, an empty
`list-timers`, and a short result set. It needs no real host, so it runs on a
laptop and in CI.

### What this cannot prove, and has not been done

Installing the unit on the real VPS and observing systemd's own behaviour is
operator-only and **has not been performed**. After installing, prove it can
fail on the host itself:

```sh
systemctl stop careerscope-retention.timer
/usr/local/bin/careerscope-scheduler-health.sh; echo "exit=$?"   # expect 1, naming that timer
systemctl start careerscope-retention.timer
/usr/local/bin/careerscope-scheduler-health.sh; echo "exit=$?"   # expect 0 / "recovered"
```

## Known limitation — this is NOT a dead-man's-switch

`scheduler-health.sh` runs on the host it watches, so it dies with that host.
It detects a timer that stopped; it cannot detect a host that stopped, and it
cannot watch its own timer. The eventual architecture is
`host timers -> local scheduler-health checker -> external/off-host
dead-man's-switch -> alert`; the third stage is **not built**. Recorded and
explicitly accepted in [KNOWN-LIMITATIONS](../KNOWN-LIMITATIONS.md), "Nothing
watches the watcher."
