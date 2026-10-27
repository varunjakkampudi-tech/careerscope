# Provider inventory

This inventory distinguishes provider code, request-schema identifiers, the
approved launch allowlist, and current owner-recorded rights. A provider being
implemented or accepted by a storage schema does not mean it is permitted for
production discovery.

## Candidate discovery and permission boundary

The v12 D14 launch candidates are Greenhouse, Lever, Ashby, and Workable. The
shared permission policy recognizes only these four candidates. A source is
eligible only when its current source-specific profile permits collection,
storage, transformation, and candidate display. The committed profile list is
empty, so no source is currently enabled for production discovery.

The search request schema also accepts `remoteok` and `himalayas` identifiers
for existing records and controlled tests. They are not D14 launch candidates
and the production permission policy always denies them. This compatibility
does not authorize collection. The API denies any request containing an
unpermitted source before creating a search or publishing work; the worker
rechecks permission before provider execution. Scheduled discovery skips when
no permitted source exists. The UI displays only the four D14 candidates and
their current availability state.

| Source     | D14 candidate | Search schema            | Current production permission  |
| ---------- | ------------- | ------------------------ | ------------------------------ |
| Greenhouse | Yes           | Accepted                 | Disabled: no approved profile  |
| Lever      | Yes           | Accepted                 | Disabled: no approved profile  |
| Ashby      | Yes           | Accepted                 | Disabled: no approved profile  |
| Workable   | Yes           | Accepted                 | Disabled: no approved profile  |
| RemoteOK   | No            | Compatibility identifier | Always denied by launch policy |
| Himalayas  | No            | Compatibility identifier | Always denied by launch policy |

The provider factory map contains adapters for these identifiers. Its presence
does not override the permission gate. No real job-source calls or rights
verification are claimed by this inventory.

## Implemented but not selectable for launch discovery

These adapters are maintained in `packages/providers` for isolated tests,
controlled future expansion, or import/enrichment work. They are not in the D14
candidate allowlist and cannot be made eligible by the current permission
profile schema:

- SmartRecruiters and Recruitee: ATS adapters.
- Adzuna, Jooble, and JSearch: credentialed aggregator adapters.
- LinkedIn, Naukri, Indeed, Foundit, and Cutshort: browser-backed or
  source-specific adapters; no unauthorized scraping, cookie/session use, or
  access-control bypass is permitted. LinkedIn remains excluded; portal
  sources remain gated unless a legitimate contract is approved.
- Gmail: separate read-only job-alert processing, not a discovery source.

`foundit` and `cutshort` also remain in the shared provenance vocabulary for
historical or imported records; this does not enable their adapters.

## Evidence and release boundary

The fail-closed behavior is covered by `packages/shared/src/job-source-policy.test.ts`,
`tests/integration/database.integration.test.ts`, `apps/workers/search/src/collect.test.ts`,
`scripts/run-scheduled-discovery.integration.test.ts`, and the browser assertions in
`scripts/check-ui.ts`. Synthetic policy fixtures prove behavior only. Before a
source can be enabled, the owner must supply current, source-specific permitted-
use evidence and approve measured coverage thresholds. Public availability
alone does not establish collection, retention, transformation, display,
redistribution, or AI-processing rights.
