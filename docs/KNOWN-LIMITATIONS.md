# Known Limitations

Everything below is real, current and deliberately recorded. Nothing here is
closed by wishful wording. Status uses only the vocabulary in
[PROJECT-STATE](PROJECT-STATE.md).

---

## Restarting the proxy alone is an outage

**Status: DEFERRED — INTENTIONAL** (mitigated, not eliminated)

Every service uses `network_mode: service:proxy`. That is what keeps Postgres,
Redis, LocalStack and the API bound to loopback with no routable address.

The cost: restarting the proxy container gives it a **new** network namespace,
and Docker leaves every other container attached to the old, dead one. They
continue to pass their own healthchecks while the proxy answers every request
with 502. Docker neither detects nor repairs this.

Discovered by restarting the proxy to prove certificates survive a restart. They
did; the site went down.

**Mitigation:** [restart-stack.sh](../infra/v3/restart-stack.sh) is the only
supported way to restart the proxy. It reattaches dependents in order and
verifies both upstreams from inside the proxy namespace.

**Residual risk:** if Caddy crashes, `restart: unless-stopped` restarts it
automatically and produces the same outage **unattended**. CS-24's host
monitor (`infra/v3/monitor.sh`) now detects the resulting outage from outside
the stack — the health endpoint becomes unreachable or unhealthy through the
dead namespace — and alerts within its 5-minute check interval. It does not
diagnose _why_ (that still takes a human reading `restart-stack.sh`'s own
verification), but the outage is no longer silent.

**Proper fix, not yet done:** move namespace ownership to a dedicated do-nothing
container that the proxy also joins, so no internet-facing process owns the
namespace. This is the Kubernetes pause-container pattern. It requires an infra
change, a rebuild and full revalidation.

---

## Hostinger managed firewall is not configured

**Status: OPEN — HUMAN VALIDATION**

The intended policy is allow 22/80/443, deny everything else. It is configured
in hPanel, outside the host, and has not been set up.

The OS nftables ruleset and the loopback-only network namespace are currently
the only inbound layers. Both are verified. But this is a missing layer of
defence in depth, not a theoretical one.

---

## No transactional email

**Status: OPEN — EXTERNAL**

There is no approved sender or provider. Consequently these do **not exist**:

- email verification
- forgot password
- password reset

What does exist is an authenticated change-password endpoint, which requires
the current password.

**Consequence:** if the owner forgets the password, the only recovery is
`setup-owner` run on the host. There is no self-service path.

This cannot be closed from inside the repository. It needs a real provider and a
verified sending domain.

---

## No off-host backup

**Status: SKIPPED — OWNER DECISION**

The owner declined off-host backup on cost. The Docker volumes on the single VPS
are the only copy of the database and of stored resumes.

A `pg_dump` taken before a risky migration protects against a bad migration. It
does not protect against losing the machine. **Local snapshots are not disaster
recovery and must not be described as such.**

Do not reopen this automatically.

---

## Screen reader not validated

**Status: OPEN — HUMAN VALIDATION**

Automated coverage passes: axe with no WCAG 2.0/2.1 A+AA violations,
accessibility-tree assertions, keyboard-only traversal, and reflow at 320 / 390 /
1440 px across Chromium, Firefox and WebKit.

None of that is a screen reader. An accessibility tree describes what _should_ be
announced; it does not prove what NVDA, JAWS or VoiceOver actually announces.
Until a human runs that smoke test, this stays open.

---

## Frontend routing is real; the admin console is still absent

**Status: PARTIALLY RESOLVED (CS-6)** — corrected 2026-09-24

This section previously read "Frontend is a single page … `v2/apps/web/src/app`
contains exactly one route: `/`". That has been false since the CS-6 routing
migration and is corrected here rather than left to mislead.

`v2/apps/web/src/app` now contains nine real routes: `/` (sign-in) plus the
`(app)` route group — `/dashboard`, `/jobs`, `/applications`, `/saved`,
`/resume`, `/career-resources`, `/settings` and `/preparation`. Every
authenticated route renders through the single `AuthenticatedShell` auth
boundary, so deep linking and per-area routing both work.

What remains genuinely absent: there is no `/login` route (sign-in lives at `/`
and redirects an authenticated visitor to `/dashboard`), and there is **no admin
console** — no `/admin/*` view exists and none can be built from the current
schema without new tables. See
[FRONTEND-ADMIN-ROADMAP](FRONTEND-ADMIN-ROADMAP.md) for what the API can and
cannot support, and the next section for the schema limits.

---

## The data model does not support several planned pages

**Status: NOT IMPLEMENTED**

`CollectedJob` carries 11 fields. It has **no** salary, tech stack, employment
type, remote flag or required-years data. There is no company entity, no global
job corpus, no saved-search entity, and no admin role or audit table.

Pages that depend on those — market and skills aggregates, company profiles,
public job browsing, alerts, and every `/admin/*` view — cannot be built from
the current schema without new tables and new collection logic. Building the UI
first would mean inventing data, which is forbidden.

---

## Resume title derivation only recognises English role words

**Status: OPEN — NEEDS AN OWNER PRODUCT DECISION**

`deriveTitles` (`packages/resume/src/derive.ts`) gates every candidate line
through a single English-only word list:

```ts
const ROLE_WORDS =
  /\b(engineer|developer|architect|programmer|analyst|consultant|designer|
     scientist|administrator|specialist|manager|associate|principal|director|
     founder|president|lead|head|intern|sde|swe|cto|vp)\b/i;
```

A line that does not contain one of those words is never considered a title, in
either the experience block or the header headline. There is no fallback.

**Verified behaviour**, measured directly against `deriveTitles` rather than
inferred, with an English positive control in the same run:

| Input headline              | Titles derived                 |
| --------------------------- | ------------------------------ |
| `Senior Software Engineer`  | 1 — `Senior Software Engineer` |
| `Data Analyst`              | 1 — `Data Analyst`             |
| `Ingénieur logiciel senior` | **0**                          |
| `Softwareentwickler`        | **0**                          |
| `Desarrollador de software` | **0**                          |
| `Sviluppatore software`     | **0**                          |

**The character allowlist is not the cause.** CS-56's
`constrainTitleCharacters` is default-deny but explicitly permits `\p{M}` so
accents survive, and that was confirmed: `Ingénieur Software Engineer` derives
intact, accent preserved. `ROLE_WORDS` is the sole gate.

**Why this matters more than a missing feature.** The failure is **silent**. A
non-English resume parses successfully, reports no error, and simply contributes
no titles to the candidate context — so matching quietly runs on preferences
alone and the owner has no signal that half the intended input was discarded.
An empty title list is indistinguishable from a resume that genuinely had no
recognisable role.

**Not fixed here deliberately.** Which languages to support is a product
decision, and the plausible remedies differ sharply in cost and risk — extending
the word list per language, switching to a structural heuristic that does not
depend on vocabulary, or detecting the language and reporting an explicit
"titles could not be derived" state rather than an empty list. The last of those
is the smallest honest improvement and would remove the silence even with no new
language support.

## Resume-derived matching facts cannot be excluded individually

**Status: OPEN — AWAITING OWNER PRODUCT DECISION (CS-46)**

CS-22 wired the parsed resume into matching. That activated a pre-existing
design characteristic which is now documented here rather than left implicit.

Current, verified behaviour (`packages/matching/src/context.ts`,
`buildCandidateContext`): resume-derived skills and titles are **unioned into
the candidate context on every single search**, additively and permanently, for
as long as the resume is on file:

```ts
skills: normalizeSkillList([...preferences.techStack, ...resumeSkills]),
titles: dedupe([...preferences.titles, ...(derived?.titles ?? [])]),
```

Years of experience is treated differently and correctly: a typed non-zero value
always wins over the resume's guess (`resolveYears`), because the user edited the
form after seeing the parse.

The consequence: `profile-editor.tsx` lets a user review and decline a
resume-derived proposal before it is saved to `preferences.techStack`, but
`buildCandidateContext()` separately re-reads the raw, unreviewed
`resume_results.parsed.derived` on every search and unions it in regardless of
that review. **A declined skill or title therefore reappears in every future
match, and the only way to remove it is to delete the entire resume.** There is
no per-skill exclusion mechanism.

This is not a data-exposure issue — CS-22's security review confirmed no
cross-owner or public-export leakage, and `resumeSkills`/`resumeConsidered` are
carried on `CandidateContext` specifically so the contribution is visible in
match evidence rather than silently folded in as if the user had typed it. It is
a product-trust issue: the product silently reintroduces data the user declined.

**The decision is the owner's and has not been made.** The two options recorded
on CS-46 are:

1. **Always-on supplementary evidence** — keep current behaviour, now accurately
   documented (this section, the `buildCandidateContext` docstring, and
   `v2/ARCHITECTURE.md`'s resume-integration row are all already consistent with
   it). Zero code change.
2. **Explicit per-fact exclusion gate** — add a per-skill/title exclude list that
   survives across searches until the resume is re-parsed, distinct from the
   profile-editor proposal-review flow, composing with the always-on union in
   `context.ts`. Requires a `MatchingProfile` change in
   `v2/packages/core/src/profile.ts`.

No exclusion mechanism has been invented in the absence of that decision, and
option 1 has **not** been recorded as accepted — the ticket requires owner
confirmation, which is a person, not an inference.

---

## Cross-process storage reservation

**Status: DEFERRED — INTENTIONAL**

Resume storage capacity reservation is correct for a **single writer**. The
`statfs`-based reservation is process-local. Two independent writer processes
could each believe they have capacity.

The deployed architecture runs one files worker, so this is not currently
reachable. It becomes real the moment that worker is scaled out.

---

## Scanner discrepancy, unresolved

**Status: OPEN — EXTERNAL**

Trivy reports `ip-address 10.2.0` and `brace-expansion 5.0.7` in the runtime
image. The files actually present are `10.7.0` and `1.1.18+`, confirmed three
ways: `package.json`, `.package-lock.json`, and grepping the installed files.

The reported vulnerable versions are **not in the image**. The cause of the
discrepancy is not understood. It is recorded rather than "fixed", because
inventing a fix for a finding that does not correspond to a real file would be
worse than leaving it visible.

---

## Runtime image is not byte-reproducible

**Status: DEFERRED — INTENTIONAL**

The runtime image runs `apt-get upgrade` at build time. Without it, the
digest-pinned base image never receives Debian security fixes — and it was
shipping known CVEs in `libpcre2-8-0`.

The trade-off: **the same source commit does not produce identical Debian
package bytes** across two builds. The OCI revision label identifies the source,
not the full dependency closure. Do not claim reproducibility.

---

## Two rate limiters are global rather than per-client

**Status: OPEN — VERIFIED 2026-09-25 (CS-59)**

`request.ip` is `127.0.0.1` for **every** request in the deployed topology, for
three independent and mutually confirming reasons:

- `infra/v3/compose.production.yml:72` sets `CAREERSCOPE_UPSTREAM` to
  `127.0.0.1:5280`, so Caddy proxies over loopback.
- The `api` service runs `network_mode: service:proxy`, sharing the proxy's
  network namespace — there is no separate peer address to observe.
- `infra/v3/Caddyfile.production` lines 57 and 78 carry
  `header_up -X-Forwarded-For`, which **deletes** the header. That is the
  correct hardening choice given `trustProxy: false`, but it means no client
  address reaches the API by any route.

**Scope is narrow, and this is the important part.** Of the nineteen
`rateLimit` call sites in `v2/apps/api/src/app.ts`, only **two** are IP-keyed:

| Limiter     | Line | Key                  | Effect     |
| ----------- | ---- | -------------------- | ---------- |
| `register:` | 238  | `sha256(request.ip)` | **global** |
| `login:`    | 247  | `sha256(request.ip)` | **global** |

The other seventeen are keyed on `request.ownerId` or on the account, and are
**unaffected**.

**No documented control is overstated.** `docs/SECURITY.md` states password
change is rate limited to 5/hour; that limiter (`app.ts:300`) is keyed
`password:${ownerId}` — per owner, exactly as documented. The same holds for
session revocation, uploads, resume operations, preparation, AI elaboration,
profile, leads, search, cancel, export and events. Login also carries a
**second**, per-account limiter (`login-account:`, 20/60, `app.ts:249`), which
is the real control against credential stuffing and is intact.

**Actual impact:**

- **Register** — global 5/hour, but `REGISTRATION_ENABLED` defaults to `false`
  in `compose.production.yml:30`, so the route is disabled in the deployed
  configuration. Negligible.
- **Login** — global 10/minute means any third party that can reach the origin
  can exhaust the bucket and **lock the legitimate owner out of signing in**,
  repeatedly. A real availability defect, cheap to trigger. Not a
  confidentiality defect: the per-account limiter and Argon2id are untouched.

**The fix is not `trustProxy: true`.** That would let any client forge
`X-Forwarded-For` and choose its own bucket, defeating the limiter entirely —
strictly worse than global. Caddy currently strips the header, so it would also
have to be changed to set a trustworthy one. That is a change to the security
boundary and needs its own review.

---

## One intermittent test failure is unexplained

**Status: PARTIALLY ADDRESSED 2026-09-27 — consecutive green runs still required**

A reproduced intermittent failure implicated two test files. One was diagnosed:
tests performing 14 and 8 password-hashing operations were running against a 5 s
default timeout, and now carry explicit 30 s timeouts.

The second file was never identified. This section previously said "It has not
recurred, but 'has not recurred' is not 'fixed'." **It has now recurred**, and
the evidence points at a specific file.

Observed on 2026-09-24 across several `npm --prefix v2 run test:integration`
runs:

- Multiple runs failed with `failureType: 'uncaughtException'` and
  `error: 'terminating connection due to administrator command'` raised inside
  `pg-protocol` — a PostgreSQL backend termination, not an assertion failure.
- The named test on two separate occasions was in
  `v2/packages/core/src/market.test.ts` — "the pipeline distinguishes neglected
  work from finished work" and "posting evidence accumulates…" — with
  `scripts/enforce-search-retention.test.ts` also failing once.
- A **different** test failed on each run, which is the signature of an
  environmental cause rather than a bad assertion.

Most occurrences were explained: concurrent agents were creating and dropping
`test_<uuid>` databases on the same PostgreSQL instance, and a `DROP DATABASE`
terminates other backends. That is genuine cross-talk and not a product defect.
GitHub Actions run `36339115982` reproduced that signature inside the single
integration job: the BullMQ file and password-change database test failed
together, with the latter receiving `terminating connection due to
administrator command`. The integration script now runs its nine
service-backed files serially. No file, engine or assertion was removed.

**But it also failed once (41/42) on a demonstrably quiet database with no
concurrent agent running**, and passed 42/42 on the immediately following run.
The failing test's identity was not captured on that specific run — an evidence
gap, recorded rather than glossed over. So the environmental explanation covers
most but **not all** observed occurrences, and this stays OPEN.

Do not treat this as closed, and do not treat a single green
`test:integration` run as proof. `market.test.ts` is the strongest candidate
for the never-identified second file and is where a fix attempt should start.

The browser suite remains only partially addressed. Run `36339477079` captured
a deterministic Chromium-only header overlap at 320 px; the wordmark now hides
below 360 px while its labelled icon link and the 40 px theme and profile controls
remain. The older WebKit click-stability timeout and Firefox network-idle case
have not been root-caused. A single green browser run must still not be treated
as stability evidence.

---

## AI and auto-apply

**Status: PARTIALLY IMPLEMENTED (CS-48) — auto-apply remains deferred**

Matching, scoring, exclusions, deduplication and job identity remain fully
deterministic and make no external model calls. As of CS-48, one narrow,
off-by-default AI use case exists: preparation-coaching elaboration, which
calls the external OpenRouter API using an explicitly configured free model,
gated by `AI_ENABLED` (default `false`, requires `OPENROUTER_API_KEY` and
`OPENROUTER_MODEL` when enabled). It only ever reads already-computed
`PreparationReport` fields (checklist/question text and evidence values) —
never resume text, contact details or compensation — and is structurally
isolated from the deterministic pipeline (enforced by a test, not just
convention). The other five use cases originally scoped for CS-48 (lead
assistance, lead-note summarization, follow-up suggestions, job/match
explanation, interview-prep suggestions beyond the one shipped) are not
implemented; only preparation-coaching elaboration is real.

Auto-apply is on hold. Naukri is deferred to a later release and, if ever
built, must use legitimate access only — never cookie or session scraping.

These are product decisions, not missing work.

---

## Job identity disambiguation only fires when one source proves multiplicity

**Status: DEFERRED — INTENTIONAL (CS-28)**

Two genuinely different reqs at the same company, in the same city, with the
same title are only kept apart when the _same source_ reports two distinct
`sourceJobId` values under that fingerprint (`resolveFingerprintGroup` in
`packages/providers/src/normalize.ts`). If role A is only ever seen via one
board and role B — a different, real opening — is only ever seen via a
_different_ single board, no source demonstrates multiplicity and the two
still merge into one lead: the exact false merge CS-28 exists to stop, silent
in that specific configuration.

In the sources actually wired in v2 (Greenhouse/Lever/Workable/RemoteOK/
Himalayas) a company's own ATS is usually the source that would reveal both
ids, so this is a narrow, not a common, failure mode. It is not a hypothetical
edge case to be reasoned away, though — it is a real boundary of the fix, and
adding a second data source could make it common for a specific employer at
any time. Product Architect review flagged this (finding F1); recorded here
rather than only in the function's docstring.

---

## A pre-CS-28 false merge cannot be un-merged, and its inflated evidence is permanent

**Status: OPEN — ACCEPTED FOR NOW (CS-28)**

`search_jobs.data` never retained the board's own per-posting id
(`sourceJobId`) until CS-28 added it. A role that was silently merged with a
different, same-title/company/city req _before_ this fix shipped cannot be
split apart retroactively — the losing duplicate was dropped by the old
in-memory dedup pass before it was ever written to `search_jobs`, so there is
nothing left to replay it from.

`v2/scripts/backfill-job-sightings.ts` (`npm run db:backfill-job-sightings`)
recomputes `job_sightings` from `search_jobs` as currently stored, which stops
any _future_ drift and correctly separates every _new_ split going forward.
But a fingerprint that was already falsely merged keeps whatever
`sightings`/`repostCount` it had accumulated, frozen, since collection now
writes disambiguated identities for new sightings of the real underlying
postings instead of continuing to add to the old merged row. That frozen row
keeps asserting `persistent`/`reposted` signals in `/api/market/postings`
indefinitely, indistinguishable from a legitimately-observed one.

Product Architect review (finding F2) proposed a cheap mitigation — a cutover
marker so `classify()` suppresses `persistent`/`reposted` for a row that
predates the fix and has not been freshly re-observed since. Not implemented
yet; recorded here as an accepted, disclosed limitation rather than silently
left unaddressed. Revisit if a stale, over-confident market signal is ever
reported as misleading in practice.

---

## `db:backfill-job-sightings` is not wired into the deploy runbook

**Status: OPEN — HUMAN VALIDATION (CS-28)**

CS-28 introduced `npm run db:backfill-job-sightings`, a one-time, idempotent
recompute of `job_sightings` from `search_jobs`. It is not referenced in
`docs/OPERATIONS/DEPLOYMENT.md`'s deploy sequence and is not run automatically
by `apply-migrations.sh`. An identity-changing fix whose corrective step is
left to institutional memory risks nobody ever running it. Product Architect
review (finding F3) flagged this; add an explicit, named step to the deploy
runbook the next time this release is actually shipped.

---

## A genuine three-way cross-source duplicate can show one extra lead

**Status: DEFERRED — INTENTIONAL (CS-28)**

When one source reports two distinct postings under a shared fingerprint and
an unrelated second source _also_ reports a posting under that same
fingerprint, `resolveFingerprintGroup` deliberately does not guess which of
the two same-source postings the second source's copy belongs to. All three
stay separate, which can show one extra lead for what may really be two
openings. This is a controlled, narrow violation of CS-28's "genuine
duplicates across sources still collapse to one" criterion, chosen because
guessing wrong (a false merge) is the worse failure this ticket exists to
prevent. Product Architect review (finding F4) asked that this trade-off be
recorded here, not only in the function's docstring.

---

## `job_sightings` backfill orders by run creation time, not actual commit order

**Status: OPEN — LOW RISK (CS-28)**

`v2/scripts/backfill-job-sightings.ts` replays `search_jobs` ordered by the
parent search run's `created_at`, because `search_jobs` itself carries no
per-row insertion timestamp. Under redelivery/retry, a run created earlier
can have its `Database.settle()` write commit later than a run created after
it — the accumulation `replay()` performs (sightings/repost_count/last_seen)
is an order-sensitive fold, so a fingerprint whose runs were reordered by a
retry could replay to slightly different final counts than the live
incremental upsert actually produced. Independent Reviewer finding CS28-2.

This does not affect CS-28's actual point: which postings are recognized as
distinct is unaffected, only the exact evidence numbers for the rare
fingerprint whose runs were reordered by a retry. Not fixed now because doing
so correctly needs a real per-row insertion timestamp on `search_jobs`, which
is a schema migration, not a script change - deferred rather than rushed
under time pressure. Add a `created_at` column to `search_jobs` and order by
that instead if this is ever observed to matter in practice.

---

## Nothing watches the watcher

**Status: PARTIALLY ADDRESSED (CS-47) — the off-host leg is still OPEN and
NOT built**

### What CS-47 added (built, tested locally, NOT yet installed on the host)

`infra/v3/scheduler-health.sh`, run hourly by
`careerscope-scheduler-health.timer`, is one host-native checker for all six
existing timers — `careerscope-monitor.timer` (CS-24),
`careerscope-backup.timer` (CS-25), `careerscope-discovery.timer` (CS-26),
`careerscope-liveness.timer` and `careerscope-retention.timer` (CS-27), and
`careerscope-proxy-recovery.timer` (CS-3). It reads real systemd state
(`systemctl show` / `systemctl list-timers`), derives each timer's expected
interval from the unit itself (`TimersMonotonic`, or the unit's own
`OnCalendar` expression expanded by `systemd-analyze`) rather than restating
the schedule where it could drift, and emits **one** aggregated, sanitized
webhook alert — the same alerting pattern `monitor.sh`, `backup.sh` and
`recover-proxy.sh` already use — naming every timer that is overdue, failed,
disabled, missing or unreadable.

Every "I could not look" case is a loud failure, never a silent pass: a unit
that is not installed, a disabled or inactive timer, a missing/erroring/empty
/unparseable `systemctl`, a `LastTriggerUSec` of `n/a`/`0`/epoch/absent, an
underivable interval, a triggered service whose `Result` is not `success`,
and any run in which fewer than six timers could be evaluated. Exit `1` means
a watched timer is unhealthy; exit `2` means the checker could not verify at
all. Strictness follows the second-opinion ranking below: backup gets the
smallest grace of any timer (10% of its own derived interval), monitor and
proxy-recovery 50%, discovery and liveness 100%, retention 200%.

Verified locally by `infra/v3/check-scheduler-health.sh` against stub
`systemctl`/`systemd-analyze`/`curl` binaries, which asserts both that a
healthy six-timer host passes and that each failure mode above fails loudly.

### What is still missing, and is explicitly accepted

**A local checker is not a dead-man's-switch.** `scheduler-health.sh` runs on
the same VPS it watches, so it dies with that VPS. If the host is powered off,
loses its network, or fills its disk badly enough that systemd cannot spawn
anything, the checker is as silent as the six timers it watches — and silence
is indistinguishable from health to anyone downstream. It detects a _timer_
that stopped; it cannot detect a _host_ that stopped.

The eventual four-stage architecture is:

```
host timers -> local scheduler-health checker -> external/off-host dead-man's-switch -> alert
```

Stages one and two exist. **Stage three — the external, off-host
ping-and-alert service — is NOT built, and nothing in CS-47 substitutes for
it.** It is new infrastructure outside this repository (an off-host endpoint
that alerts when it stops hearing from the host on schedule), and it was
deliberately left out of scope for this ticket rather than half-built. Until
it exists, total host death is still detected only by a human noticing.

Also still uncovered: `careerscope-scheduler-health.timer` cannot watch
itself. If _it_ is the timer that silently stops, nothing on the host notices
— which is the same gap, one level up, and another reason stage three is the
real fix.

### The original gap, as first recorded

`careerscope-monitor.timer` runs `monitor.sh` every 5 minutes and alerts on a
transition to unreachable/unhealthy/stopped/stale. But if the timer itself
stops — a corrupted unit file, an accidental `systemctl disable`, the host
running out of disk so systemd cannot spawn the service — there was no
independent watcher for the watcher. `systemctl list-timers` shows whether it
last ran, but nothing alerted on its own if it silently stopped running.
The same gap applied to `careerscope-backup.timer` (CS-25),
`careerscope-discovery.timer` (CS-26), `careerscope-liveness.timer`/
`careerscope-retention.timer` (CS-27), and `careerscope-proxy-recovery.timer`
(CS-3) for exactly the same reason - CS-3 in particular is the one where this
gap matters most, since it is the timer specifically responsible for
recovering from an outage.

**Second opinion sought (owner's ChatGPT thread, after all six timers
existed):** acceptable as a short-term disclosed gap, but the six-timer count
raises the priority above "low risk carried indefinitely." Recommendation
received:

- Don't build six separate watchdogs. Build **one host-native
  scheduler-health checker** that verifies the expected last-run
  time/status of all six jobs (monitor, backup, discovery, liveness,
  retention, proxy-recovery) and emits a single sanitized alert when any one
  becomes overdue - this collapses six failure modes into one and is a small
  addition to the existing pattern.
- That checker still cannot provide a true dead-man's-switch: if the VPS
  itself dies, the local checker dies with it. Genuine absence detection
  needs the external/off-host ping-and-alert service described above,
  layered on top: `host timers -> local scheduler-health checker ->
external/off-host dead-man's-switch -> alert`.
- Relative priority if/when this is picked up: **HIGH** - backup, monitor,
  proxy-recovery (silent failure here is the most costly: undetected loss of
  recoverability, undetected outage-detection failure, undetected inability
  to self-heal an outage); **MEDIUM** - scheduled discovery, liveness
  re-check; **LOWER** - retention.
- Explicit recommendation: carry this as an accepted operational limitation
  for now rather than block on it, but treat "watch the watchers" as the
  next infrastructure follow-up before leaning on unattended
  discovery/backups for anything that matters - and do **not** fold it into
  the currently-held frontend ticket work just to chase completeness.

Tracked as CS-47. The first two bullets are now implemented (see "What CS-47
added" above); the third — the off-host dead-man's-switch — is not, and is
carried here as an accepted, disclosed limitation.

**Not verified on the host.** Everything above is built and tested locally
only. `setup-scheduler-health.sh` has not been run against the production
VPS, no unit has been installed there, and no live systemd behaviour has been
observed. That step is operator-only and still outstanding — see
`docs/OPERATIONS/MONITORING.md`.

---

## Scheduled discovery has no cross-owner rate limiter

**Status: DEFERRED — INTENTIONAL (CS-26)**

`run-scheduled-discovery.ts` reuses the existing `search.collect` pipeline
unchanged, so every per-source/per-request budget in
`.github/skills/careerscope-job-discovery/SKILL.md` already applies to a
scheduled run exactly as it does to a manual one. What does not exist is any
limiter across _multiple owners_' scheduled runs landing in the same window -
this deployment is single-owner (`v2/scripts/setup-owner.ts` refuses to
create a second one), so the realistic worst case today is one owner's
handful of GETs against up to five saved titles, twice a day. If CareerScope
ever became genuinely multi-owner with many people enabling scheduled
discovery, many owners' runs firing in the same window would multiply
outbound request volume against the same few third-party sources beyond what
any single owner's own manual-search budget assumes.

Not fixed here - a real fix (a global, cross-owner token bucket per source)
is only worth building once there is more than one owner to protect against.
Recorded as an explicit, accepted design boundary. Revisit if the deployment
model ever changes.

---

## Liveness re-checks cannot distinguish a slow ATS from a dead one

**Status: OPEN — LOW RISK (CS-27)**

`check-lead-liveness.ts` classifies a request timeout, a 5xx, a 403, or any
other ambiguous response as `unknown` rather than `stale` - correct per this
ticket's own AC2 ("an old posting is not assumed dead"), but it means a lead
behind an ATS that is merely slow, rate-limiting HEAD requests, or
temporarily down looks identical to one whose real signal is genuinely
ambiguous. There is no retry-with-backoff for a single check; a lead in that
state simply becomes due again after `LIVENESS_RECHECK_HOURS` (default 24)
and gets a fresh, independent attempt then. Not fixed now - the daily cadence
already provides a form of retry, and adding same-run retry logic for a
one-off ambiguous result was judged not worth the added complexity. Revisit
if a specific ATS is ever observed to consistently produce `unknown` for
reasons a short retry would resolve.

---

## `search_jobs`/`search_runs` retention judges age by the parent run, same as CS-28

**Status: OPEN — LOW RISK (CS-27)**

`enforce-search-retention.ts` deletes based on `search_runs.created_at`
because `search_jobs` itself carries no timestamp - the identical limitation
already recorded for CS-28's `job_sightings` replay. This is accurate for the
actual retention question ("is this run old enough to remove") and does not
share CS28-2's ordering concern (retention does not need commit-order,
only age), but is recorded here too for the same reason: a future
`search_jobs.created_at` column would remove the indirection entirely if it
is ever added for another reason.

---

## `careerscope-monitor.service`/`careerscope-backup.service` have no explicit `TimeoutStartSec`

**Status: OPEN — LOW RISK (CS-3)**

CS-3's security review found that `careerscope-proxy-recovery.service` needed
an explicit `TimeoutStartSec` (now `600`) because being killed by systemd's
default 90-second `Type=oneshot` timeout mid-run would silently disable its
own circuit breaker. `careerscope-monitor.service` (CS-24) and
`careerscope-backup.service` (CS-25) have the identical missing setting, but
neither depends on completing within the default window the way the proxy
recovery's circuit breaker does - `monitor.sh` is a handful of quick
checks, and while `backup.sh`'s dump-and-restore-verify cycle is plausibly
slow enough to exceed 90 seconds on a large database, a killed backup run
simply leaves the last good dump untouched (its own explicitly-designed
failure mode) rather than defeating a safety mechanism the way the proxy
recovery case did. Not fixed as part of CS-3 (out of scope for this
ticket's own review). Worth an explicit `TimeoutStartSec` on both anyway as
a follow-up, for the same reason CS-3's own fix exists: an implicit systemd
default should never be the thing standing between "this failed safely" and
"this failed silently."
