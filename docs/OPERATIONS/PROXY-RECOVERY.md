# Operations — Proxy Recovery

## Why this exists

The dedicated `network-anchor` owns the single network namespace and the edge
ports. The proxy and application services join it. If Caddy crashes and Docker
restarts it alone, the namespace remains stable and dependents stay reachable;
the split-brain failure this runbook was created for is eliminated. Replacing
the anchor still requires an intentional full-stack recreation.

`restart-stack.sh` (see [FIREWALL](FIREWALL.md) and its own header comment)
was already the one supported _manual_ fix. This adds detection and
automatic recovery on top of it.

## Design

A System Designer review (recorded in `.ai/backlog.json`, CS-3's own
`completedSteps`) evaluated five options before any code was written, given
this ticket's own `reviewAgents` require System Designer first and a naive
approach — a Docker-socket-mounted watchdog _inside_ a container — would
introduce a new root-equivalent privilege class this single-host deployment
does not have today. Rejected for exactly that reason. The recommended path,
implemented here:

- **Detect** by symptom, not by event: [recover-proxy.sh](../../infra/recover-proxy.sh)
  checks whether the real public origin actually answers — the exact thing
  the split-brain failure breaks — the same way `careerscope-monitor.timer`
  (CS-24) already does, not by watching for a specific restart/deploy event
  that might not be the only cause.
- **Confirm before acting**: a single bad check is not enough — it could be
  a deploy in progress or a momentary blip. Only `PROXY_CONFIRM_THRESHOLD`
  (default 2) consecutive bad checks trigger recovery.
- **Recover automatically**: once confirmed, it runs `restart-stack.sh`
  itself — the same, already-tested recovery a human would run — satisfying
  AC1's "recovers without operator action" branch, not only "is detected".
- **Circuit breaker**: never auto-restarts more than once inside
  `PROXY_COOLDOWN_SECONDS` (default 1 hour), regardless of how many more bad
  checks follow. A failure `restart-stack.sh` cannot fix (e.g. Postgres
  itself is down) must not thrash the stack with repeated restarts — it
  escalates to an alert asking for a human instead.
- **Alerts on every meaningful transition**: a confirmed outage, a
  completed auto-restart, a _failed_ auto-restart, a "still down but
  already tried, not retrying automatically" escalation, and a recovery —
  each exactly once, via the same webhook `careerscope-monitor.timer`
  already uses.

## Install

```sh
bash infra/setup-proxy-recovery.sh
```

Idempotent. Shares `/etc/careerscope-monitor.env` (`MONITOR_URL`,
`MONITOR_WEBHOOK_URL`) with CS-24's monitor — one webhook, configured once.

## Verification

```sh
bash infra/check-proxy-recovery.sh
```

Runs entirely against stub `curl`/`restart-stack.sh` binaries — proves the
confirm-then-act-then-cooldown state machine, that recovery is announced
exactly once, and that a failed `restart-stack.sh` invocation is still
alerted rather than silently absorbed. No real host, proxy or webhook
needed, so it runs in CI.

### The literal proof this ticket's own AC2 asks for

```sh
docker kill careerscope-proxy-1
journalctl -u careerscope-proxy-recovery.service -f
```

Watch the site actually come back within a couple of confirm-then-restart
cycles (roughly 4-6 minutes at the default cadence), with an alert at each
step, without anyone running `restart-stack.sh` by hand. This is a one-time
manual proof against a real deployment — the same category of step CS-24/25's
own "stop a container and observe" and "restore a real dump" proofs are.

## Known limitations

- Same "nothing watches the watcher" gap as CS-24/25/26/27 — if
  `careerscope-proxy-recovery.timer` itself stops firing, nothing alerts on
  that absence. See [MONITORING.md](MONITORING.md#known-limitation).
- The circuit breaker's cooldown is a single, fixed window per confirmed
  outage type, not per distinct root cause — if the proxy fails for two
  genuinely different reasons within the same hour, the second failure only
  gets an escalation alert, not a second automatic restart attempt. This is
  the intentional trade-off recover-proxy.sh's own design makes (thrash
  prevention over always retrying), not an oversight.
