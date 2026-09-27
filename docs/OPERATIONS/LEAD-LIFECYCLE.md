# Operations — Lead Lifecycle (Liveness and Retention)

## Why this exists

A saved lead keeps a frozen copy of the posting and was never re-verified,
and search results had no retention — a role that closed months ago still
looked open, and the tables grew forever. This is CS-27: two independent,
host-native jobs that make age and liveness two different, honest facts, and
that actually enforce a retention policy instead of only documenting one.

## Liveness: a checked fact, never a guess

[check-lead-liveness.ts](../../v2/scripts/check-lead-liveness.ts) periodically
re-verifies a saved lead's `applyUrl` against the real world. A lead is
marked:

| Result    | Meaning                                                                                                                |
| --------- | ---------------------------------------------------------------------------------------------------------------------- |
| `live`    | an unambiguous 2xx response                                                                                            |
| `stale`   | an unambiguous 404 or 410                                                                                              |
| `unknown` | everything else — timeout, 5xx, DNS failure, a 403, an unresolved redirect. The default before any check has ever run. |

`unknown` is not a weaker `live` — it means exactly what it says: this system
does not actually know. Age (`createdAt`) and liveness (`livenessStatus`,
`livenessCheckedAt`) are two separate columns on `saved_leads`, both returned
by every lead read endpoint, so neither is ever inferred from the other: a
lead saved yesterday is not assumed live, and one saved months ago is not
assumed dead, until an actual check says so.

A lead is due for a re-check when it was never checked, or was last checked
more than `LIVENESS_RECHECK_HOURS` (default 24) ago — a URL confirmed live
yesterday is not re-fetched again today for no new information. Archived and
rejected leads are excluded entirely: re-verifying a listing the owner has
already moved past wastes the same outbound requests this ticket exists to
make useful.

**A disclosed product judgment call, not just an implementation detail:**
excluding `rejected` leads assumes a rejection means the role itself is no
longer relevant to check — but a lead can be rejected for salary, fit, or
any reason unrelated to whether the posting is still live, and this design
does not distinguish those cases. Moving a lead back to `saved` is the only
way to make it due for re-verification again. Product Architect review
flagged this as worth stating explicitly rather than leaving it only in a
code comment.

### SSRF hardening

`applyUrl` is provider-sourced data — HTTPS-only and credential-free per
`collectedJobSchema`, but not restricted to public hosts. This makes CS-27
the first place CareerScope's own server issues unattended outbound HTTP
requests to arbitrary third-party URLs — a real, new attack surface, not the
`securityImpact: none` the ticket originally carried (corrected as part of
this review).

Before making any request, the checker resolves the hostname and refuses to
proceed if the address is loopback, RFC1918, link-local, or otherwise
reserved (including the `169.254.169.254` cloud metadata endpoint) - covering
IPv4-mapped IPv6 forms of the same ranges too (`::ffff:172.16.x` and similar
are unwrapped to their embedded IPv4 address and checked by the identical
rule, not a separate, easier-to-under-cover one). A hostname that fails to
resolve, or resolves to a disallowed address, is recorded as `unknown`,
never `stale`.

Critically, the address used for that check is the **same address the
request actually connects to** — the resolved, validated IP is pinned into a
dedicated `undici` dispatcher for that request, rather than handing the
hostname to `fetch()` and letting it re-resolve independently. Resolving and
connecting separately is a classic DNS-rebinding TOCTOU: an attacker
controlling the `applyUrl`'s domain could otherwise answer the validation
lookup with a public address and the real connection's lookup, moments
later, with a private one. Redirects are followed by hand, one hop at a
time (bounded to 5 hops), so a second hostname reached via redirect gets its
own independent resolve-validate-pin cycle rather than inheriting the first
hop's already-spent trust.

## Retention: enforced, not just documented

[enforce-search-retention.ts](../../v2/scripts/enforce-search-retention.ts)
deletes `search_jobs` rows (and their parent `search_runs`, once
out of the outbox/execution pipeline entirely) older than
`SEARCH_RETENTION_DAYS` (default 30). `search_jobs` itself carries no
timestamp (a separately-recorded limitation), so age is judged by the parent
run's `created_at`.

**`saved_leads` is never touched.** A lead stores its own independent data
snapshot — it is not a foreign key to `search_jobs` — so retiring old search
results never removes anything the owner explicitly kept.

**A still-in-flight run is never deleted, no matter how old.** The exact same
eligibility rule (old enough, settled, no unpublished or still-running
outbox command referencing it) is applied identically everywhere a row is
removed — computed once as a shared subquery, not defined separately for
`search_jobs` and `search_runs`, specifically because those two definitions
drifting apart is how a still-running run's own jobs could be deleted out
from under it.

## Install

```sh
bash infra/v3/setup-lead-lifecycle.sh
```

Idempotent. Installs both timers: liveness daily at 04:00, retention weekly
(Sunday 05:00 — a cleanup task, not a time-sensitive one).

## Verification

```sh
node --env-file=.env --import tsx --test v2/scripts/check-lead-liveness.test.ts
node --env-file=.env --import tsx --test v2/scripts/enforce-search-retention.test.ts
```

Both need a real Postgres (same disposable-per-test-database pattern as
`packages/core/src/database.test.ts`) and are wired into `test:integration`.
The liveness suite also unit-tests the SSRF address classifier and the
HEAD→GET fallback/network-error handling with a fake `fetch`, with no network
access needed for those cases. The retention suite proves, against real rows,
that an old-but-still-running run's jobs survive, a saved lead born from a
deleted job's row is completely unaffected, and a nonsense retention window
(zero, negative, `NaN`) is refused outright rather than silently deleting
nothing or everything.

## Known limitations

- Same "nothing watches the watcher" gap as CS-24/25/26 — see
  [MONITORING.md](MONITORING.md#known-limitation).
- `search_jobs`/`search_runs` retention judges age by the parent run's
  `created_at`, the same limitation CS-28 already documents for
  `job_sightings` replay — see `docs/KNOWN-LIMITATIONS.md`.
