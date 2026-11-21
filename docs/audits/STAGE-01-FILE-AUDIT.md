# Stage 01 file-level audit

The machine-readable record at [STAGE-01-FILE-AUDIT.json](STAGE-01-FILE-AUDIT.json) is the source of truth. `npm run audit:stage01` requires complete coverage and is part of `npm run check` and the Quality gates CI job. The validator checks that every tracked file is listed once, every disposition is valid, reviewed records have observations/reviewer/hash evidence, and no critical or high finding remains open. It cannot prove a file was read; a `reviewed` record is an evidence-backed attestation.

## Baseline and current coverage

- Audit baseline: `dev` at `8008736`, with 478 tracked files.
- Current candidate checkpoint: 520 tracked files, all accounted for.
- 451 files are reviewed; 69 are classified not applicable as source. There are no partially reviewed or unreviewed files.
- Finding disposition: 71 fixed, one accepted low-severity risk (S1-F014), zero open findings.
- The 2026-11-08 refresh re-reviewed 25 stale or new records after the profile-picture merge. It is based on `origin/dev` SHA `2d468d7c23b1784fe42ca3d04b1488a9a69389d2`; candidate PR approval and exact-head CI are recorded in [PROGRESS](../PROGRESS.md).

The full prompt-scoped audit was completed and independently approved at PR #18, exact commit `5fa4776b7fe4ddd9c604c0d7d7fcec596d3d8964`. The current manifest is refreshed against the latest `dev` source and strict complete-coverage CI gate. B-04 is resolved. All 15 owner Stage 01 checklist items are verified with no recorded gaps. Final cross-browser acceptance and the required engineering gates passed on closing merge commit `397025bdd43ae293a081e2728fadc67dafb62df1` in hosted run `42310969989`; Stage 01 is complete. The accepted low-severity S1-F014 risk remains recorded below.

## Accepted risk

S1-F014 records that PostgreSQL does not enforce lowercase storage for `users.email`. Application write paths normalize the value. A database check should be added through a future migration after existing data is checked; Stage 01 did not rewrite applied schema.

## Verification evidence and limits

- `npm run audit:stage01 -- --require-complete` passed on 2026-11-06 before the current documentation edits: 502 tracked files, 435 reviewed, 67 not-applicable-source, no open critical/high findings. Item 1.12 updates the reviewed records and hashes for `FOUNDATIONS.md`, `PROGRESS.md`, and `TEST-MATRIX.md`; the current candidate is revalidated by the audit gate.
- Revalidated on 2026-11-07 after roadmap traceability work: 505 tracked files, 438 reviewed, 67 not-applicable-source, no open critical/high findings. Updated hashes cover the roadmap inventory, checker, tests, manifest, package script and related documentation.
- Revalidated during Stage 05 item 5.07: 520 tracked files, 451 reviewed, 69 not-applicable-source, no partially reviewed or unreviewed records, and no open critical/high findings. The new offline career markup reader and tests are included in the manifest; exact-head CI and independent review remain separate gates.
- The initial item 1.01 approval is tied to PR #18 and exact SHA `5fa4776b7fe4ddd9c604c0d7d7fcec596d3d8964`. The 2026-11-08 refresh pins all current review bytes and extends the complete-coverage check into the CI command; the new candidate still requires exact-head CI and independent review. Later item-specific architecture reviews and CI evidence remain recorded in their respective documents and PRs.
- The file audit is not a substitute for Stage 01 feature checks, cross-browser acceptance, production load validation, or the owner’s later-stage release gates.
- Hostinger, server backups, and production deployment are excluded from the owner-approved roadmap scope.

## Stage 07.04 source review

Item 7.04 adds explicit education demand parsing and an explainable 5% soft-fit score. Candidate-entered and parsed resume education are bounded to 40 strings of 200 characters in the in-memory matching context; the existing profile schema limits candidate entries to 20 strings of 200 characters, and resume claims remain labeled unverified. Unknown education is neutral, and education mismatch is not an exclusion gate. Local focused matching tests passed 146/146, core profile tests passed 15/15, the full TypeScript check passed including 98 canonical test files, roadmap/document traceability passed, and targeted Prettier checks passed on Node 22.23.2 (below repository requirement Node 24). The browser fixture now asserts the education fit reason for a synthetic scored job; hosted browser execution remains pending. This review does not establish extraction accuracy, international qualification equivalence, calibration, browser acceptance, exact-head CI, independent review, or credential authenticity. The Stage 01 audit hashes are refreshed for changed files; current exact-head CI and review remain separate gates.

Independent exact-SHA review found a substring degree-classification false positive, an unscoped browser assertion, and an incompatible historical breakdown schema. Follow-up changes use explicit qualification tokens, scope the browser check to the scored job's Match evidence education row, and accept historical seven-dimension records while preserving stored scores and labeling education as unrecorded at zero weight. The correction tests passed locally as part of 975 domain tests across 34 files; full typecheck passed including 98 canonical test files. Local Node 22.23.2 is below repository Node 24. The previous implementation SHA passed all three CI jobs; exact-head CI and independent review of this correction SHA remain pending. International equivalence, calibration and credential authenticity remain unverified, so item 7.04 remains partial.
