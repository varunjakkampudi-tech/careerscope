# Stage 01 file-level audit

The machine-readable record at [STAGE-01-FILE-AUDIT.json](STAGE-01-FILE-AUDIT.json) is the source of truth. Validate it with `npm run audit:stage01`; require full coverage with `npm run audit:stage01 -- --require-complete`. The validator checks that every tracked file is listed once, every disposition is valid, reviewed records have observations/reviewer/hash evidence, and no critical or high finding remains open. It cannot prove a file was read; a `reviewed` record is an evidence-backed attestation.

## Baseline and current coverage

- Audit baseline: `dev` at `8008736`, with 478 tracked files.
- Current checkpoint: 502 tracked files, all accounted for.
- 435 files are reviewed; 67 are classified not applicable as source. There are no partially reviewed or unreviewed files.
- Finding disposition: 69 fixed, one accepted low-severity risk (S1-F014), zero open findings.

The full prompt-scoped audit was completed and independently approved at PR #18, exact commit `5fa4776b7fe4ddd9c604c0d7d7fcec596d3d8964`. The current manifest was revalidated after later checklist documentation was added. B-04 is resolved. Stage 01 overall remains partial because other roadmap items and final cross-browser acceptance are still outstanding.

## Accepted risk

S1-F014 records that PostgreSQL does not enforce lowercase storage for `users.email`. Application write paths normalize the value. A database check should be added through a future migration after existing data is checked; Stage 01 did not rewrite applied schema.

## Verification evidence and limits

- `npm run audit:stage01 -- --require-complete` passed on 2026-11-06: 501 tracked files, 434 reviewed, 67 not-applicable-source, no open findings.
- The item 1.01 approval is tied to PR #18 and its exact approved SHA. Later item-specific architecture reviews and exact-SHA CI results are recorded in their respective documents and PRs.
- The file audit is not a substitute for Stage 01 feature checks, cross-browser acceptance, production load validation, or the owner’s later-stage release gates.
- Hostinger, server backups, and production deployment are excluded from the owner-approved roadmap scope.
