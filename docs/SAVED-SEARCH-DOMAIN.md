# Saved search domain (CS-42) — design

**Status: DESIGN ONLY. Nothing here is implemented.** No table, no repository,
no route and no page exists for any of this. This document is the CS-42
deliverable for acceptance criterion 1 and the specification half of criterion
2; the executable contract tests are **not** delivered (see
[What is not done](#what-is-not-done)).

**Scheduling stays off.** Saving criteria grants no execution authority of any
kind. See [Execution is not implied](#execution-is-not-implied-ac3).

---

## The problem this separates

CareerScope already stores search _runs_. `search_runs`
(`CareerScope/packages/core/src/`) holds `request: jsonb` — the exact `CreateSearch` that
produced that run — alongside `matchingProfile`, `profileRevision`,
`sourceOutcomes`, `requestHash`, `idempotencyKey` and `status`.

That row is an **immutable historical record**. It answers _"what did this run
actually do, against which profile, and what came back?"_ It must never change
after the fact, because match evidence, idempotency and the audit trail all
depend on it staying exactly as it was.

A **saved search** is the opposite kind of object. It answers _"what do I keep
looking for?"_ It is expected to be edited, renamed, disabled and re-run. If the
two were the same record, editing your criteria would silently rewrite the
history of every run that used them — and every stored match score would then be
evidence for a query that no longer exists.

So: **one mutable, versioned definition; many immutable snapshots taken from
it.** A run copies the criteria it was given. It never references them live.

> This is the same shape as the existing `profileRevision` column on
> `search_runs`: the profile is mutable, and each run records which revision it
> used. Saved searches follow that precedent rather than inventing a second one.

---

## Entity

A saved search is owner-scoped, named, versioned, and carries exactly the
criteria the existing search pipeline already accepts.

| Field        | Type                | Notes                                                                          |
| ------------ | ------------------- | ------------------------------------------------------------------------------ |
| `id`         | uuid                | Primary key.                                                                   |
| `ownerId`    | uuid                | `references(users.id)`, `notNull`. Every read and write is scoped by it.       |
| `name`       | text                | Owner-supplied label. Trimmed, 1–80 chars. Not unique — see [Naming](#naming). |
| `criteria`   | jsonb               | A `CreateSearch` **minus** `origin` — see below.                               |
| `revision`   | integer             | Starts at 0. Increments on every accepted mutation.                            |
| `disabledAt` | timestamptz \| null | Null means active. See [Disable is not delete](#disable-is-not-delete).        |
| `createdAt`  | timestamptz         | Set once.                                                                      |
| `updatedAt`  | timestamptz         | Set on every accepted mutation.                                                |

### `criteria` is `CreateSearch` minus `origin`

The current schema (`CareerScope/packages/core/src/commands.ts`) is:

```ts
const createSearchSchema = z
  .object({
    query: z.string().trim().min(2).max(160),
    useProfileTitles: z.boolean().optional(),
    origin: z.enum(['manual', 'scheduled']).optional().default('manual'),
    sources: z
      .array(searchSourceSchema)
      .min(1)
      .max(5)
      // A real rejection path, not decoration: the malformed fixture must
      // exercise it.
      .refine((sources) => new Set(sources).size === sources.length, 'Duplicate sources'),
  })
  // `.strict()` is the ONLY reason the "extra keys" malformed fixture below
  // rejects. Quoting the object without it would make that fixture look like
  // it tests something the schema does not do.
  .strict();
```

`origin` is **excluded from stored criteria, deliberately.** It describes _how a
particular run was triggered_, not _what the owner is looking for_. Storing it
would mean a saved search could assert that its future runs are `scheduled`,
which is precisely the execution authority CS-42 must not grant. `origin` stays
a property of the run, supplied at execution time.

Everything else is stored verbatim and validated with **the same schema the
pipeline uses**. Not a copy of it — a reuse. A second definition would drift,
and the first time it drifted a saved search would become un-runnable while
still passing its own validation.

#### The exclusion needs a mechanism, because reuse alone defeats it

**This is the correction to an earlier version of this document, and it is the
most important paragraph here.** "Exclude `origin`" and "reuse the pipeline
schema" were both stated, with no mechanism connecting them — and as written
they cannot both hold. `origin` is `.optional().default('manual')`, and a Zod
`.default()` **fires on `undefined`**, so parsing criteria that omit `origin`
does not leave it absent: it **adds** it.

Measured against the real schema, not argued:

```
input keys : query, sources
parsed keys: origin, query, sources
origin injected: true -> "manual"
```

An implementer following the document literally — reuse the schema, store the
parsed result — would therefore have stored `origin` on **every** saved search,
which the paragraph above forbids. The design stated the property and the
schema underneath silently reintroduced it.

**The mechanism is one clause, and it must be written down rather than left to
the reader:**

```ts
export const savedSearchCriteriaSchema = createSearchSchema.omit({ origin: true });
```

A **derivation, not a copy** — so the no-drift argument above survives intact: a
change to `query`, `sources` or `.strict()` still propagates automatically, and
only `origin` is removed.

Verified that the derivation does not quietly weaken anything else, which is the
obvious way this fix could go wrong:

```
with .omit({ origin: true }) -> origin present: false
derived schema still rejects extra keys (.strict): true
derived schema still rejects duplicate sources    : true
```

That pairing matters. "It omits `origin`" would be satisfied by a schema that
validates nothing at all, so the negative is only meaningful beside the positives.

### Naming

Names are **not** unique per owner. Two saved searches may share a name.

Uniqueness sounds tidy and costs more than it gives: it forces a conflict path
on rename, makes "duplicate this search" awkward, and produces a second class of
error the UI must explain. The `id` is the identity; the name is a label. If
duplicate names prove confusing in use, that is a UI affordance problem, not a
constraint problem.

---

## Versioning and revision conflicts

`revision` starts at 0 and increments by 1 on every accepted mutation.

**"Accepted" means the stored value actually changed.** That sentence is
load-bearing because `sources` is sorted on parse, so an edit that only
reorders them parses byte-identical to what is already stored. Two rules that
look compatible pull apart exactly there — "increments on every accepted
mutation" against "the valid fixture must assert the revision advanced". The
settlement, stated once so an implementer does not have to choose:

> A mutation that produces criteria identical to the stored criteria is a
> **no-op**: it does not advance `revision`, and it is not an error. The valid
> fixture must therefore use an edit that genuinely changes the stored value —
> a different `query`, or a different **set** of sources — never a reordering.

A fixture that reorders `sources` and then asserts the revision advanced would
fail against a correct implementation, and "fix" it by making every request
bump the revision.

Every mutating call **must** supply the revision it believes it is editing. If
that does not match the stored value, the write is rejected and nothing changes.

This follows the existing profile pattern exactly. `ProfileRevisionConflict`
(`CareerScope/packages/core/src/profile.ts`) extends `Conflict` with the stable code
`PROFILE_REVISION_CONFLICT`. Saved searches add:

```ts
export class SavedSearchRevisionConflict extends Conflict {
  constructor(message: string) {
    super(message, 'SAVED_SEARCH_REVISION_CONFLICT');
  }
}
```

A distinct code, not a reused one — CS-35 established that route-reachable
conflicts carry distinct, stable, client-actionable codes, and the client's
allowlist in `CareerScope/apps/web/src/lib/api.ts` maps each to its own message and
decides whether to offer "discard and reload". A saved-search conflict and a
profile conflict need different offers.

### The SERVER table must be updated too, or this recreates CS-35

A new code has to be registered in **two** places, and an earlier version of
this document named only the client one. That omission is enough for a reader
to recreate the exact defect CS-35 was opened to fix, while believing they were
following its precedent.

The server holds its own map (`CareerScope/apps/api/src/app.ts:168`):

```ts
const conflictMessages: Record<string, string> = {
  PROFILE_REVISION_CONFLICT: 'Record changed; reload before saving',
  LEAD_REVISION_CONFLICT: 'Record changed; reload before saving',
  PROFILE_NOT_SAVED: 'Save your profile before enabling this option',
};
```

and falls back at `~:200` with `conflictMessages[error.code] ?? 'Idempotency
conflict'`. An **unmapped** code therefore does not fail loudly — it renders a
stale-revision edit to the owner as **"Idempotency conflict"**, which is both
wrong and unactionable, and is precisely the mislabelling CS-35 exists to
prevent.

So the requirement is:

1. **Server**: add `SAVED_SEARCH_REVISION_CONFLICT` to `conflictMessages` with
   its own message. Without this the fallback silently mislabels it.
2. **Client**: add it to the allowlist in `CareerScope/apps/web/src/lib/api.ts` so the
   recovery offer is chosen per code.

**A design that cites CS-35 as its precedent must not leave the reader able to
recreate CS-35.** The test for this is not "a distinct code exists" — it is that
a stale-revision edit reaches the owner carrying the saved-search message rather
than the generic fallback, asserted on the message actually rendered.

**Why optimistic and not a lock:** the conflicting case is a single owner with
two tabs, which is rare and cheap to retry. A lock would add a held-resource
failure mode to a single-owner application that has none today.

---

## Disable is not delete

`disabledAt` is a timestamp, not a boolean, and disabling is **not** deleting.

- **Disable** sets `disabledAt`. The row stays. It is excluded from default
  listings and may not be executed.
- **Enable** clears it. Both are ordinary mutations: they bump `revision` and
  are subject to the same conflict check.
- **Delete** is a separate operation and is **out of scope for this ticket**.

The reason to keep disabled rows is that runs reference the criteria they were
created from. Hard-deleting a saved search would leave historical runs pointing
at something that no longer exists — and the run snapshot is what match evidence
is built on. A timestamp also answers _when_ it was disabled, which a boolean
cannot.

---

## Contracts

Four operations. All owner-scoped: `ownerId` comes from the session, **never
from the client**, matching the invariant already enforced in
`CareerScope/apps/api/src/app.ts` where `request.ownerId` is assigned in exactly one
place, the `onRequest` hook.

| Operation            | Input                                  | Success                 | Failure modes                                                                  |
| -------------------- | -------------------------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| **create**           | `name`, `criteria`                     | The row, `revision: 0`  | `400` malformed name or criteria                                               |
| **read**             | `id`                                   | The row                 | `404` unknown **or foreign-owner**                                             |
| **edit**             | `id`, `revision`, `name?`, `criteria?` | The row, `revision + 1` | `400` malformed · `404` unknown/foreign · `409 SAVED_SEARCH_REVISION_CONFLICT` |
| **disable / enable** | `id`, `revision`                       | The row, `revision + 1` | `404` unknown/foreign · `409` stale revision                                   |

**A foreign-owner id returns 404, never 403.** A 403 would confirm the id
exists, which is an enumeration oracle. This matches the existing behaviour for
leads and runs.

### Running a saved search supplies a FRESH idempotency key

AC3 keeps execution out of scope, but the one sentence about manual reuse —
that it "retains normal run limits and idempotency" — is ambiguous in a way
that would produce a real bug. It reads as _"derive the key the same way"_, and
CS-26's scheduled key is deterministic (`scheduled-<UTC day>`). Deriving a
manual re-run's key from the saved search would therefore collapse **two
legitimate re-runs on the same day into a 409.**

> A manual run of a saved search is a **new run** and supplies a **fresh**
> idempotency key, exactly as a manual run started from the search form does.
> "The same idempotency rules" means the same guarantees — one run per key,
> replay-safe — not the same key.

The saved search contributes the criteria and nothing else.

### The fixture classes AC2 requires

Each contract is to be tested against all four:

1. **Valid** — the happy path, and the assertion that `revision` actually
   advanced. A create that returns `revision: 0` and an edit that returns
   `revision: 1` is the minimum; asserting only "no error" would pass against a
   no-op write.
2. **Malformed** — an empty `query`, a `query` over 160 chars, `sources: []`,
   six sources, an unknown source id, a name of only whitespace, and a
   `criteria` carrying extra keys. Each must be **rejected**, and — per the
   standing rule in `.ai/AGENT-SETUP.md` — **malformed input must fail, never be
   silently coerced or treated as empty.**
3. **Foreign-owner** — a second real owner's saved search, by its real id. Not a
   random uuid: a random id only proves unknown ids 404, which is a weaker
   claim than proving a _real but foreign_ id is indistinguishable from unknown.
   This is the lesson from CS-51, where the fixture was strengthened for exactly
   this reason.
4. **Stale revision** — edit with `revision - 1` and with `revision + 1`. Both
   must conflict. Testing only the low side would pass against an
   implementation that compared `<` rather than `!==`.

**Each test must be shown to fail before it is trusted.** The specific trap here
is the read contract: an assertion that a foreign-owner read returns no data
passes trivially against a broken query that returns nothing to anybody. Pair
every negative with a positive on the same surface — the owner's _own_ read
must succeed in the same test — or the negative proves nothing.

---

## Execution is not implied (AC3)

Saving criteria grants **no** execution authority.

- No scheduler integration. CS-26 is the gate for anything unattended, and it
  requires separate activation approval.
- A manual re-run from a saved search creates an ordinary run through the
  existing pipeline, and is subject to **the same rate limits and the same
  idempotency rules as any other run**. It is a convenience for filling in the
  form, not a new execution path.
- A disabled saved search may not be executed at all.
- Storing `origin` in `criteria` is forbidden (above), so a saved search cannot
  assert that its runs are scheduled.

---

## What is not done

**Acceptance criterion 2 is only half satisfied.** The contracts are specified
above; the **executable tests are not written**, and no schema, migration,
repository or route exists.

Delivering the design without the tests is a deliberate choice under time
pressure, recorded rather than disguised: a design document that specifies
testable contracts is genuinely useful to whoever implements this, whereas a
half-written schema plus a few passing tests would look like more progress and
be worth less. **This ticket should stay in DISCOVERY until the tests exist.**

The remaining work, in order:

1. Drizzle schema + forward-only migration, tested on a disposable database.
2. `SavedSearchRepository` with the four operations and the conflict class.
3. Contract tests across all four fixture classes, each proven able to fail.
4. Only then the API routes, and only after that any UI page.
