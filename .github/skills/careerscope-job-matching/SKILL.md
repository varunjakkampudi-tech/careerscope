---
name: careerscope-job-matching
description: 'Deterministic scoring: dimension weights, hard exclusion gates, the low-confidence ceiling and the frozen profile snapshot. Use when changing scoring, weights, thresholds, exclusions, or the candidate profile shape.'
---

# CareerScope Job Matching

## Purpose

Matching decides what the owner spends time on, so it must be explainable and
reproducible. It is a pure function of a job and a frozen profile snapshot. No
network, no clock beyond an injected `now`, no model. Every change here is a
change to the product's credibility.

## When to use

- Changing `scoreJob`, any dimension scorer, or `MATCH_WEIGHTS`
- Adjusting the match threshold or the confidence ceiling
- Adding or removing a hard exclusion
- Changing `WritableProfile` or `matchingProfile`
- Investigating "why did this job score this way"

## Where the code lives

| Concern                     | Path                               |
| --------------------------- | ---------------------------------- |
| Scoring                     | `packages/matching/src/score.ts`   |
| Weights and thresholds      | `packages/shared/src/constants.ts` |
| Profile schema and snapshot | `v2/packages/core/src/profile.ts`  |
| Snapshot persistence        | `v2/packages/core/src/database.ts` |

## Weights

`MATCH_WEIGHTS` sums to 1.0. The final score is the weighted mean, rounded to
four decimal places.

| Dimension    | Weight |
| ------------ | ------ |
| skills       | 0.40   |
| title        | 0.15   |
| seniority    | 0.12   |
| experience   | 0.10   |
| location     | 0.10   |
| compensation | 0.08   |
| recency      | 0.05   |

If you change a weight you must change the others so the sum stays 1.0, and you
must update any test asserting a specific score.

## Hard exclusions return 0

Gates are final and are not softened by any later blend:

1. An excluded keyword appears in title, company or description
   (case-insensitive, word-boundary) → `Mentions an excluded keyword: "<kw>"`
2. `remoteOnly` is set and the job is not remote → `You asked for remote roles only`
3. The job's employment type is not among the selected types →
   `Employment type "<type>" is not one you selected`

Each exclusion carries a human-readable reason. A score of 0 without a reason is
a bug.

## The low-confidence ceiling

```
confidence = 'high' when hasFullDescription && descriptionText.length >= 400
confidence = 'low'  otherwise
if (confidence === 'low') score = min(score, 0.8)
```

`MIN_FULL_DESCRIPTION_CHARS = 400`, `LOW_CONFIDENCE_SCORE_CEILING = 0.8`,
`DEFAULT_MATCH_THRESHOLD = 0.85`.

The ceiling sits below the threshold on purpose: a job can only cross the
owner's threshold if its full description was actually read. Raising the ceiling
to or above the threshold breaks that guarantee and must not be done to "surface
more results".

## The profile snapshot is frozen

`matchingProfile()` extracts a deliberately narrow subset and it is written once
into `search_runs.matching_profile` when the run is created:

- `candidate.location` only — never name, email or phone
- all of `preferences`
- `application.{expectedCtc, yearsOfExperience, willingToRelocate}` only — never
  `currentCtc` or `noticePeriodDays`

Two reasons this is immutable: scores stay reproducible when the lead is opened
weeks later, and editing the profile must not retroactively rewrite history.
Never re-derive a historical score from the live profile.

Note what is excluded. Personal identifiers are not part of matching and must
not be added to the snapshot.

## Determinism

`scoreJob` is pure. Do not introduce I/O, `Date.now()`, randomness or caching
keyed on mutable state. The optional rerank path blends
`0.6 * heuristic + 0.4 * llm` but is **not active** in the v2 runtime, and even
when active it cannot resurrect an excluded job.

## Forbidden shortcuts

- Inventing a qualification the candidate did not state
- Adding personal identifiers to the matching snapshot
- Making a dimension scorer depend on the wall clock
- Letting a model override a gate
- Changing a weight without rebalancing the rest

## Verification

```sh
npm test -- packages/matching
npm test -- packages/shared
npm --prefix v2 test
```

Preparation output is separately asserted never to echo the candidate email —
see `v2/packages/core/src/profile.test.ts` and the live check in
`infra/v3/check-live-flow.mjs`.
