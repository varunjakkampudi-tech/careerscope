# Stage 01 file-level audit

Machine-readable record: [STAGE-01-FILE-AUDIT.json](STAGE-01-FILE-AUDIT.json). Validate it with
`npm run audit:stage01`. The validator checks that every tracked file is listed once, that each state is
valid, that every reviewed record has a reviewer, observations and a hash that still matches the file, and
that no critical or high finding is open. It cannot prove that a file was read. A `reviewed` state is an
attestation that the record backs with observations, a reviewer and the file hash at review time.

## Baseline

- Starting point: `dev` at `8008736`, 478 tracked files (matches the baseline recorded in BLOCKERS B-04).
- This change adds five tracked files (the validator, its test, the two audit records and a recovery-email integration test), so the count is 483.
- Local working tree was clean at the start.

## Coverage at this revision

| State                 | Files | Meaning                                                                                           |
| --------------------- | ----: | ------------------------------------------------------------------------------------------------- |
| reviewed              |    24 | Read in full. Observations, reviewer and hash are recorded.                                       |
| partially-reviewed    |     7 | Some ranges read. The rest is not yet reviewed and still counts as open.                          |
| not-reviewed          |   438 | Not read at content level. Still open.                                                            |
| not-applicable-source |    14 | Binary assets (6), generated lockfile and migration snapshots (6), and the two audit records (2). |

Review is not complete. B-04 stays open until every tracked file has a completed disposition.

## Findings

| ID      | Severity | Status        | File                                      | Summary                                                                                                                               |
| ------- | -------- | ------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| S1-F001 | low      | fixed         | packages/core/src/admin-second-factor.ts  | Authenticator enrolment read, then wrote, without checking the row count. Now one conditional write.                                  |
| S1-F002 | info     | fixed         | packages/core/src/database.ts             | A doc comment sat above the wrong function. Moved.                                                                                    |
| S1-F003 | info     | fixed         | packages/core/src/email-otp-delivery.ts   | A duplicated doc comment above a different type. Removed.                                                                             |
| S1-F004 | medium   | accepted-risk | package.json                              | Development-only minimatch 3.1.5 advisory (GHSA-g3hv-75wg-m249) in the ESLint 9 chain. No compatible fix; see below.                  |
| S1-F005 | medium   | fixed         | packages/core/src/support-cases.ts        | Core change-email did not lower-case the address, so a case variant of another account's address was accepted. Regression test added. |
| S1-F006 | low      | fixed         | apps/api/src/errors.ts                    | The default 409 message said "Idempotency conflict" for every unmapped conflict.                                                      |
| S1-F007 | low      | fixed         | apps/api/src/app.ts                       | A failed new-device check was dropped silently. Now logged. No test covers that branch yet.                                           |
| S1-F008 | info     | fixed         | packages/core/src/email-otp-challenges.ts | A doc comment sat above the wrong declaration. Moved.                                                                                 |
| S1-F009 | medium   | fixed         | packages/core/src/recovery-email.ts       | The core recovery-address guard compared addresses without lower-casing. Core now normalises; regression test added.                  |
| S1-F010 | low      | fixed         | packages/core/src/legal-acceptance.ts     | The acceptance ledger was read outside the locked transaction. Now read on the locked client.                                         |

Open critical or high findings: none.

## Dependency advisories

- `npm audit --omit=dev`: 0 advisories.
- `npm audit` (full tree): 15 moderate advisories, all in development tooling (ESLint, typescript-eslint,
  eslint-plugin-jsx-a11y, eslint-config-next and minimatch).
- `minimatch@3.1.5` is used by the ESLint 9 chain and is affected by GHSA-g3hv-75wg-m249 (ReDoS through
  globparts amplification; fixed in 11.0.1). npm's suggested fix is a semver-major change to ESLint. Forcing
  minimatch 11 across the tree would change the API that ESLint 9 calls, so no override was applied. Exposure
  is limited to lint-time globbing of repository-controlled patterns. Revisit when ESLint or
  eslint-config-next release a version that drops minimatch 3.
- A clean full-tree audit is not claimed. Only production dependencies have zero advisories.

## Repository scans

Recorded in the JSON `repositoryScans` field: unsafe type escapes, skipped or focused tests, console use in
product code, open TODO markers. Results: no unsafe casts in product code, three Windows-only skips that run
on Linux CI, one build-tool console use, no open markers.

## Verification of the changes in this revision

- `npm run check`: passed (formatting, lint, typecheck, 326 unit tests passing, 3 skipped, 0 failing).
- `npm run test:integration`: passed against the local PostgreSQL and Redis containers from `infra/docker/compose.canonical.yml`, 93 plus 2 tests, 0 failing. Ran
  before the final support-case and conflict-message edits.
- Targeted reruns after those edits: support-case integration (2 of 2), database integration (24 of 24),
  OTP challenge integration and clock tests (3 of 3).
- Later in this revision: legal-acceptance and recovery API integration tests (2 of 2) and the recovery-email
  integration test (1 of 1) passed against the same local services.
- Browser suites, Linux signal tests and soak tests were not rerun locally for this revision. Hosted CI is the
  source for them (see the Stage 01 completion report when it is written).

## What is still required for B-04

1. Read every `not-reviewed` and `partially-reviewed` file. Record observations, findings and the hash.
2. Resolve every finding that is critical, high, or medium and violates a Stage 01 acceptance criterion.
3. Re-run `npm run audit:stage01 -- --require-complete`, which fails while any file is unreviewed.
4. Only then write `docs/stage-closure/STAGE-01-CLOSURE.md`.
