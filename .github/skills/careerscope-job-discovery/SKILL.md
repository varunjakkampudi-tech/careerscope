---
name: careerscope-job-discovery
description: 'The bounded discovery pipeline: source adapters, per-source deadlines, failure isolation, normalization and fingerprint deduplication. Use when adding or changing a job source, touching normalization, or altering how duplicate postings are collapsed.'
---

# CareerScope Job Discovery

## Purpose

Discovery fans out to several third-party sources that are slow, inconsistent
and occasionally hostile. The pipeline is built so that one bad source degrades
a run rather than breaking it, and so that the same role posted to three boards
collapses into one result. Both properties are easy to destroy accidentally.

Ingestion, normalization and deduplication are documented together because they
are a single ordered pipeline; splitting them invites changes that satisfy one
stage and break the next.

## When to use

- Adding, removing or reconfiguring a job source
- Changing timeouts, retries or result limits
- Touching `normalizeJob`, `jobFingerprint` or `dedupeJobs`
- Investigating duplicate or missing results in a run

## Where the code lives

| Concern                               | Path                                                      |
| ------------------------------------- | --------------------------------------------------------- |
| Collection orchestration              | `v2/apps/workers/search/src/collect.ts`                   |
| Source adapters                       | `packages/providers/src/{ats,remote,keyed,email,scrape}/` |
| Normalization and fingerprinting      | `packages/providers/src/normalize.ts`                     |
| HTTP client, retries, in-flight dedup | `packages/providers/src/http.ts`                          |
| Collected job schema                  | `v2/packages/core/src/jobs.ts`                            |

## Bounds that are load-bearing

These are not arbitrary. Removing one turns a slow third party into an outage.

| Bound                         | Value                                            |
| ----------------------------- | ------------------------------------------------ |
| Per-request HTTP timeout      | 20 000 ms                                        |
| HTTP retries                  | 1 (2 attempts total)                             |
| Retryable statuses            | 408, 425, 429, 500, 502, 503, 504                |
| Backoff                       | exponential from 500 ms, capped at 15 000 ms     |
| Max response body             | 2 000 000 bytes                                  |
| Whole-collection deadline     | 60 000 ms                                        |
| Per-source deadline           | `min(25_000, floor(55_000 / sources.length))` ms |
| Max results per source        | 100                                              |
| Max detail fetches per source | 20                                               |
| Max jobs returned per run     | 100                                              |

Each source gets its **own** abort signal derived from the combined deadline. A
source that hangs must not consume another source's budget.

## Failure isolation

Every source produces a `SourceOutcome` of
`{source, status, accepted, limited, errorCode}` with `errorCode` in
`{null, 'source_failed', 'source_timeout', 'invalid_response'}`, persisted to
`search_runs.source_outcomes`. A run where some sources failed settles as
`partial`, not `failed`, and `partial` requires outcomes to be present.

A provider must never be able to attribute jobs to a different provider.
`collect.ts` enforces this explicitly:

```ts
if (raw.source !== provider.id) throw new Error('Source attribution mismatch');
```

## Normalization: nulls are honest

`normalizeJob()` must never invent data. An absent salary stays `null` rather
than becoming `0`. An unparseable date stays `null` rather than becoming "now".
An empty description sets `hasFullDescription = false`, which later caps the
match score. Inventing a value here silently corrupts matching downstream.

Output is validated by `collectedJobSchema` (strict Zod). URLs must be HTTPS
without credentials and at most 4096 characters. Description text is capped at
100 000 characters.

## Deduplication

Canonical identity is a fingerprint, not a source id:

```
fingerprint = sha1(canonicalTitle | canonicalCompany | (isRemote ? 'remote' : canonicalLocation))
              .slice(0, 16)
```

Canonicalisation lowercases, strips gender suffixes such as `(m/f/d)`, removes
bracketed requisition ids, strips legal suffixes (`Ltd`, `Pvt`, `Inc`, `GmbH`),
reduces a location to its leading city token and applies city aliases
(`bengaluru` ↔ `bangalore`, `bombay` ↔ `mumbai`).

Two database constraints depend on it:

- `search_jobs`: unique on `(run_id, fingerprint)` — one copy per run
- `saved_leads`: unique on `(owner_id, fingerprint)`, saved with
  `ON CONFLICT DO NOTHING` — one lead per role per owner, across runs

On collision `mergeDuplicates()` keeps the richer copy, ranked by full
description, then disclosed salary, then description length, then source rank
(ATS 5 > remote feeds 3 > aggregators 2 > scrapers 1), and backfills missing
fields from the loser.

## Ordering invariant

**Deduplicate before scoring.** `collect.ts` iterates `dedupeJobs(normalized)`
and scores inside that loop. Scoring first would pay skill-extraction cost per
duplicate and could emit differing scores for the same fingerprint.

## Forbidden shortcuts

- Adding an unauthorized source. Scrapers are opt-in behind `enableScrapers` and
  Naukri specifically requires an authorized contract or a user-initiated import
  — never authenticated cookie or session scraping.
- Sharing one global timeout across sources
- Removing the per-source result cap "to get more results"
- Filling a missing field with a plausible default
- Weakening the fingerprint to make two postings look distinct

## Failure modes to test

Source returns HTTP 500; source hangs past its deadline; source returns
malformed JSON; source returns 100+ results; the same role arrives from three
sources with different titles; a source claims another source's id.

## Verification

```sh
npm test -- packages/providers
npm --prefix v2 test
```

Live discovery through the deployed queue and workers is exercised by
`infra/v3/check-live-flow.mjs`, which asserts a run settles to `completed`.
