# Alerts domain and notification semantics (CS-43) — design

**Status: DESIGN ONLY. Nothing here is implemented.** No table, no repository,
no route, no delivery channel. This document is the CS-43 deliverable for
acceptance criterion 1 and the specification half of criterion 2; the executable
negative-case tests are **not** delivered.

**No email. No background delivery. No scheduling.** See
[Nothing is delivered anywhere](#nothing-is-delivered-anywhere-ac3).

Depends on [CS-42](SAVED-SEARCH-DOMAIN.md) for what an alert is _about_, and on
CS-27 for what the system is allowed to _claim_ about a posting.

---

## What an alert is, and what it is not

An alert is **a record that a posting matching one of this owner's saved
searches was seen**. It is not a message, not an email, and not a delivery
attempt. Whether anything is ever _sent_ is a separate, currently-unapproved
question.

That distinction is the whole design. If an alert were modelled as a
notification, its identity would be tied to a delivery, and re-delivery would
mean re-alerting. Modelled as a _sighting record_, delivery becomes an optional
projection over it, and the "did we already tell them?" problem is solved by
state on the record rather than by remembering what was sent.

---

## Identity: `(ownerId, fingerprint, savedSearchId)`

CareerScope already has the right key. `job_sightings` is keyed by
`(ownerId, fingerprint)` and carries `firstSeenAt`, `lastSeenAt` and a
`sightings` counter.

> **Read that counter carefully before relying on it.** The column is named
> `sightings`, but its schema comment says _"Distinct searches this posting has
> turned up in."_ Those are different quantities, and the name suggests the
> wrong one — in a domain whose entire subject is not conflating one occurrence
> with many. This document relies on the **documented** meaning; an implementer
> must confirm it at the increment site before treating the number as either,
> because a comment is an author's claim rather than proof of behaviour.

An alert's identity extends it by **which saved search matched**:

| Field            | Notes                                                       |
| ---------------- | ----------------------------------------------------------- |
| `ownerId`        | From the session. Never from the client.                    |
| `fingerprint`    | The posting, as already computed for deduplication.         |
| `savedSearchId`  | Which saved search matched (CS-42).                         |
| `firstAlertedAt` | When this posting first matched this saved search.          |
| `lastMatchedAt`  | Updated on every re-match. **Does not** create a new alert. |
| `readAt`         | Null until the owner has seen it.                           |
| `dismissedAt`    | Null unless explicitly dismissed.                           |

**`savedSearchId` is part of the identity deliberately.** The same posting
legitimately matching two different saved searches is two different pieces of
information — "this matches your React contract search" and "this matches your
Berlin search" are not duplicates, and collapsing them would hide one. Keyed
only by `(ownerId, fingerprint)`, the second match would be silently swallowed.

---

## Repeat sightings do not re-alert (AC1)

This is the central rule, and `job_sightings` already demonstrates the pattern:
a posting seen again updates `lastSeenAt`; it does not become a new row.

- **First match** of a posting against a saved search → create the alert.
- **Every subsequent match** → update `lastMatchedAt` only.
- Re-matching **must not** clear `readAt` or `dismissedAt`.

That last point is the one an implementation is most likely to get wrong. A
posting that reappears in tomorrow's run is _the same posting_; resurfacing a
dismissed alert because the job was seen again would make dismissal useless
exactly for the postings the owner sees most often. **Dismissal is about the
posting, not about the sighting.**

> A discovery run that returns the same 40 postings every day must produce zero
> new alerts. If it produces 40, the deduplication is not working, and the
> symptom will be an owner who stops reading alerts entirely.

---

## Freshness: three states, and `unknown` is never "closed" (AC1)

CS-27's liveness checker already defines the vocabulary, and the discipline to
copy is in its implementation rather than its docs:

```ts
export type CheckResult = 'live' | 'stale' | 'unknown';
```

It returns `'unknown'` for a blocked dispatcher, an unresolvable host, too many
redirects, and every other ambiguous outcome — reserving `'stale'` for an
unambiguous 404/410 and `'live'` for a clear 2xx.

**Alerts must carry that same three-state vocabulary through to the owner, and
must never collapse `unknown` into `stale`.** Two failure modes follow, and both
are explicitly forbidden by AC1:

1. **An uncertain posting is not a closed posting.** If the check could not
   determine the state, the alert says so. It does not say "this job is gone",
   and it does not silently hide the alert.
2. **An old posting is not a closed posting.** Age is not evidence. A posting
   last seen 30 days ago may be open, filled, or unreachable, and the system
   knows which only if it checked. Retention may remove an alert for being old
   (below); nothing may _reinterpret_ it as closed for being old.

The honest rendering is "last confirmed live N days ago" or "could not check".
Never a derived "closed".

---

## Read and dismiss

Two separate states, both owner-scoped timestamps, neither reversible by the
system:

- **Read** (`readAt`) — the owner has seen it. Set when displayed in a context
  that constitutes seeing it. Advisory: it affects ordering and unread counts.
- **Dismiss** (`dismissedAt`) — the owner does not want it. Excluded from
  default listings. Survives re-matching (above).

Timestamps rather than booleans, for the same reason as CS-42's `disabledAt`: a
boolean cannot answer _when_, and "when did they dismiss this" is the question
that tells you whether a dismissal predates a material change to the posting.

**Undismiss is an owner action, never a system one.** Nothing about a posting
changing may cause the system to resurrect a dismissed alert — that is the
re-alert defect wearing a different costume.

---

## Retention

Alerts are derived data. They can be reconstructed from sightings and saved
searches, so they may be pruned without loss of truth.

- Dismissed alerts: retained a bounded period, then removed.
- Unread, unmatched-for-a-long-time alerts: removed on the same schedule as the
  sightings they describe, so an alert never outlives its posting record and
  becomes an orphan pointing at nothing.
- **Retention removes the alert. It never rewrites its meaning.** Deleting an
  old alert is fine; converting it to "expired" or "closed" is not, because that
  is an inference the system has not earned.

Exact windows are an operational decision and are deliberately not fixed here.

---

## Negative cases the implementation must handle (AC2)

Specified now, before an implementation exists, so the contract is not shaped by
whatever the first attempt happens to do.

| Case                        | Required behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Replay**                  | The same match processed twice produces **one** alert and one `lastMatchedAt` update. Idempotent on `(ownerId, fingerprint, savedSearchId)`.                                                                                                                                                                                                                                                                                                                                         |
| **Duplicate**               | Two postings that dedupe to the same fingerprint are one alert — the existing CS-28 identity rules decide, alerts do not re-derive them.                                                                                                                                                                                                                                                                                                                                             |
| **Malformed**               | A sighting with a missing fingerprint, an unparseable posting or an unknown `savedSearchId` is **rejected and recorded as a failure**. Never silently skipped, never coerced into a partial alert. **"Recorded as a failure" means the run's existing outcome vocabulary** — CS-23's `empty` / `failed` / `completed` — **not a log line.** Named explicitly because an unnamed surface makes this row unfalsifiable: any implementation can claim it records the failure somewhere. |
| **Foreign-owner**           | A `savedSearchId` belonging to another owner produces **no alert and no error that confirms it exists** — 404-shaped, matching CS-42.                                                                                                                                                                                                                                                                                                                                                |
| **Deleted saved search**    | **Out of scope, and this row previously described an operation CS-42 declined to provide.** See the disabled case below — that is the state that actually exists.                                                                                                                                                                                                                                                                                                                    |
| **Disabled saved search**   | Setting `disabledAt` (CS-42) **stops production immediately**: no new alerts, and no `lastMatchedAt` updates. Existing alerts **remain and stay listed** — they are a record of postings the owner really was shown, and hiding them would destroy history rather than pause a subscription.                                                                                                                                                                                         |
| **Re-enabled saved search** | Production resumes. It **must not** alter the `readAt` or `dismissedAt` of any existing alert, and it **must not** resurface a dismissed one. This is the same rule as re-matching, and it is stated separately because re-enabling is the case an implementer is most likely to treat as "start fresh".                                                                                                                                                                             |

### Testing traps for this domain

The same discipline as CS-42, with one that is specific to alerts:

- **The dedup test must run the same match twice and assert the count is
  still 1.** Asserting "an alert exists" after one match passes against an
  implementation with no deduplication at all.
- **The re-match test must set `dismissedAt`, re-match, and assert it is still
  set.** This is the rule most likely to regress and the least likely to be
  noticed, because it only manifests for postings that recur.
- **Pair every negative with a positive on the same surface.** A foreign-owner
  test asserting "no alert was produced" passes trivially against a pipeline
  that produces no alerts for anybody. The owner's own match must succeed in the
  same test.
- **`unknown` must be asserted distinctly from `stale`.** A test that only
  checks "not live" would pass against an implementation that collapses the two
  — which is the exact defect AC1 forbids.

  **Name the producer, or this trap is unfalsifiable.** `check-lead-liveness.ts`
  reaches `unknown` from **six** distinct places, several of them awkward or
  slow to stage. Use a **5xx response**, or a **302 with no `Location`
  header** — both are fast, deterministic and stageable with a route stub.
  **Do not use a timeout**: it is slow and it is exactly the flakiness class
  CS-58 already records.

---

## Delivery budgets (AC2) — specified, not built

If delivery is ever approved, it is bounded from the start rather than bounded
after the first incident:

- **Per owner, per window**: a cap on notifications, with overflow **summarised
  rather than dropped** — "and 12 more" is information; silence is not.
- **Retry**: a small fixed number of attempts with backoff, reusing the existing
  outbox and idempotency contracts rather than a second delivery mechanism.
- **Failure is terminal and visible.** An exhausted retry budget marks the
  delivery failed and leaves the alert intact. It must never mark the alert read
  or dismissed as a side effect of a delivery problem.
- **No unbounded fan-out.** A saved search matching 500 postings is one
  summarised notification, never 500.

---

## Nothing is delivered anywhere (AC3)

- **No email provider.** None is configured, and none may be until the owner
  approves sender and domain. This is the same gate as CS-44.
- **No background delivery and no scheduling.** CS-26 is the activation gate for
  anything unattended.
- **Alerts are read, not pushed.** Until a channel is approved, an alert is
  something the owner sees when they open the application. That is a complete
  and useful feature on its own, and it needs no external approval.
- Any later scheduled integration must satisfy CS-26 **and** the existing
  outbox/idempotency contracts rather than introducing a parallel queue.

---

## What is not done

**AC2's executable tests are not written**, and no schema, repository or route
exists. AC1 and AC3 are satisfied by this document; AC2 is specified but
untested.

**This ticket stays in DISCOVERY.** The same reasoning as CS-42: a design that
specifies testable contracts and names their traps is useful to whoever
implements it; a partial implementation would look like more progress and be
worth less.

Ordered remaining work:

1. CS-42 first — alerts are keyed by `savedSearchId` and cannot be built before
   saved searches exist.
2. Schema and forward-only migration, tested on a disposable database.
3. The match → alert path, with the replay and re-match cases proven able to
   fail before they are trusted.
4. Read/dismiss and retention.
5. Delivery: **only** after explicit owner approval of a channel, sender and
   domain.
