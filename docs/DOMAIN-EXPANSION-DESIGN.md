# Job, Company and Skill Domain Expansion (CS-41)

## Current boundary

CareerScope currently stores owner-scoped observations, not a global job
catalog. `jobs` are identified by a source-derived fingerprint and are linked
to an owner's `job_sightings`; `leads` represent that owner's relationship to a
job. The existing `/api/market/postings` and `/api/market/companies` routes
therefore expose retained evidence for the authenticated owner only. They do
not establish public company identities, universal skills, or market-wide
coverage.

No migration or collection entitlement is approved by this ticket.

## Proposed identity model (design only)

If expansion is approved later, use immutable, opaque identifiers with explicit
provenance:

- `job_identity`: a canonical role identity only when source evidence proves
  that two observations are the same opening; otherwise retain separate
  observations. Keep source URL, source name, first/last observed timestamps,
  and a nullable confidence/reason field.
- `company_identity`: a normalized display name plus nullable legal/domain
  facts. Do not merge names solely by string similarity. Ambiguous and
  foreign-owner matches remain unmerged observations.
- `skill_identity`: a controlled alias map with the original source label and
  normalization provenance. Unknown labels remain nullable facts, never silently
  become a known skill.

Every proposed identity must be forward-only and migration-safe: add nullable
columns/tables, backfill only from recorded evidence, preserve the original
source value, and make rollback possible without rewriting owner history.

## Safety and query budgets

Collection remains disabled until legal, security and architecture approval.
Any future public or cross-owner corpus needs an explicit retention policy,
source terms review, per-source rate limits, bounded pagination, and a proof
that owner-scoped observations cannot be returned to another owner.

Required fixtures before implementation: two distinct openings with similar
titles, one posting observed by two owners, ambiguous company names, malformed
source identifiers, unknown skill labels, and a foreign-owner read. Positive
fixtures must accompany every negative isolation assertion so an empty result
cannot pass against a broken query.

## UI and API consequence

Existing owner-scoped market routes remain unchanged and are the only supported
surface. A future domain API must state whether each fact is an observation,
inference, or verified identity; expose nullable provenance; enforce bounded
`limit`/pagination; and return no aggregate that implies coverage the system
has not measured. CS-16/17/18 may continue using current supported facts
without waiting for this expansion.

This document completes the discovery decision for CS-41. Schema, collection,
backfill and public UI implementation require a new approved ticket after the
architecture/security review.
