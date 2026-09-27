# Operations — Scheduled Discovery

## Why this exists

Every search used to happen because someone clicked. Market evidence (is a
role persistent? was it reposted?) only accumulates by seeing the same
posting repeatedly over time, which never happened unless a person remembered
to look. This is CS-26: a host-native timer that runs discovery on a
schedule — but only for an owner who has explicitly turned it on.

## Defaults off, on purpose

Unattended, unsupervised execution against third-party sources is a
different trust decision than a human clicking "search" right now, and
CareerScope's own standing rule for exactly that category of decision — an
autonomous, third-party-facing action with no one present at the moment it
runs — is to default it off: AI assistance is off by default, auto-apply is
on hold, scrapers are opt-in behind `enableScrapers`, and Naukri specifically
requires authorized, user-initiated access rather than unattended access.
Scheduled discovery is the same shape of decision, so it defaults to
**disabled** per owner (`candidate_profiles.scheduled_discovery_enabled`,
`false` by default) and stays that way until explicitly enabled.

There is no UI toggle for this yet — frontend work is paused pending design.
Enable it directly:

```sh
curl -X PUT https://careerscope.tech/api/profile/scheduled-discovery \
  -H 'content-type: application/json' -H 'x-csrf-token: <from /api/session>' \
  --cookie 'careerscope_v2_session=<session>' \
  -d '{"enabled": true}'
```

## What runs, and how

[run-scheduled-discovery.ts](../../v2/scripts/run-scheduled-discovery.ts),
invoked by `careerscope-discovery.timer` via `docker exec` into the `api`
container, twice a day. For every owner with the flag enabled:

1. Reads that owner's saved profile. No usable saved title (the same
   2–160-character check `createSearch` already applies) → skip, log, no
   alert — this is expected, not a failure.
2. Calls the **existing, unchanged** `Database.createSearch()` with
   `useProfileTitles: true`, all five wired sources, and
   `origin: 'scheduled'` — the same `search.collect` pipeline a manual click
   already goes through, with the exact same per-source budgets, retries,
   dedup rules and legitimate-access constraints documented in
   [careerscope-job-discovery](../../.github/skills/careerscope-job-discovery/SKILL.md).
   No new source, no new command type, no new queue.
3. The idempotency key is `scheduled-<UTC calendar day>`, so a restart or an
   extra tick on the same day cannot double-enqueue — relies on
   `createSearch`'s own existing idempotency handling.
4. Polls the resulting `search_runs` row to a terminal status (bounded, ~65s).
   `completed`/`partial` → done. `failed`, or the poll timing out without
   reaching a terminal status → alerts the same webhook CS-24/CS-25 use
   (`MONITOR_WEBHOOK_URL`), so a failed scheduled run is visible, not silently
   skipped (AC2).

`origin: 'manual' | 'scheduled'` is persisted on every `search_runs.request`
(defaulted to `'manual'` for every existing caller) specifically so "was this
run automated" is a real, queryable fact — not something recoverable only by
reverse-engineering the idempotency-key string format.

## Install

```sh
bash infra/v3/setup-discovery.sh
```

Idempotent. Installing the timer does **not** turn discovery on for anyone —
that still needs the per-owner flag above. This mirrors CS-24/CS-25's own
install scripts.

## Verification

```sh
node --env-file=.env --import tsx --test v2/scripts/run-scheduled-discovery.test.ts
```

Runs against a real disposable Postgres database (same per-test-database
pattern as `packages/core/src/database.test.ts`), covering: disabled → no
run, no alert; a saved-but-unusable title → skip, no alert (a real
Conflict, not a placeholder); a usable title → real enqueue, and the poll is
proven against the real `search_runs` row, not a mock; the same calendar day
called twice → no duplicate row; a failed run → alerted exactly once.

## Known, accepted gap

This design assumes one owner (or a small number) enabling this at a time.
There is no cross-owner rate limiter — if CareerScope ever became multi-owner
with many people enabling scheduled discovery simultaneously, many owners'
scheduled runs firing in the same window would multiply outbound request
volume against the same handful of third-party sources well beyond what any
single owner's manual search budget assumes. Not a problem today (this
deployment is single-owner - see `docs/PROJECT-STATE.md`), and not fixed
here — recorded as an explicit, accepted design boundary rather than
something CS-26 silently doesn't handle. Revisit if the deployment model
ever changes.

Same "nothing watches the watcher" limitation as CS-24/CS-25 applies to
`careerscope-discovery.timer` too — see
[MONITORING.md](MONITORING.md#known-limitation).
