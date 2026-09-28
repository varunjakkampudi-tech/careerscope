# Active task

**Status: IN PROGRESS — CS-61 owner-transition experiment planning.**

Reconciled 2026-09-28 from starting `main` SHA
`8adbe89c74d8a52c295f11638d937012cb5cc27f`. The current committed main SHA is
`157cbd8d7347b3a53c7c72c8d6b1463221fb7f3f`. No production deployment or
publication has been run.

## Delivered in this batch

- Deployment and GitHub Pages publication are manual-only and require explicit
  ref and environment inputs.
- The release workflows require successful CI for the resolved commit and
  expose no CI bypass.
- The malformed disposable recovery-database URL is fixed.
- The known V2 format drift is fixed.
- GitHub PR, branch, worktree, and Actions clutter was classified and reduced
  without deleting the unique admin-console branch.
- Backlog gaps CS-82 through CS-85 capture the release-trigger, recovery,
  dependency-refresh, and integration-timeout work.
- Recovery CI now passes crash recovery, database backup/restore, queue runtime,
  and genuine full-disk checks.
- Run 36355198109 passes the service-backed V2 suite 48/48 and the sightings
  backfill 7/7. Its browser phase exposed a missing loopback `APP_ORIGIN` for the
  spawned files worker; the current branch supplies it and preserves stderr.

## Still open

- CS-83 recovery evidence is complete and recorded; it is now UAT for release
  manager acceptance.
- CS-85 has two consecutive complete green integration runs, including
  Chromium, Firefox, WebKit, and axe; it is now UAT for release manager
  acceptance.
- Fully re-taken, Node 24 CI-backed QA evidence promoted CS-35, CS-48, CS-56,
  CS-57, CS-63, CS-65, CS-66, and CS-71 to UAT. No ticket was promoted from
  an open, partial, host-bound, or advisory-only criterion.
- CS-61 still requires its deliberate two-owner cache-transition experiment;
  CS-58 still requires consecutive full-CI confirmation of older unexplained
  flakes.
- CS-82 deployment/Pages gate evidence is complete and recorded; it is now UAT
  for release-manager acceptance.
- Recreate a coherent dependency update after baseline CI is green (CS-84).
- Review and integrate or intentionally retire the unique work on
  `feature/frontend-pages-admin-console`.
- CS-61's cache-disabled single-document transition harness and paired
  owner-agnostic-key positive control both pass locally across Chromium,
  Firefox, and WebKit; hosted CI verification remains open.

## Current evidence and next action

- Local: V2 formatting passes; all 15 V2 test files type-check; root formatting
  passes; diff whitespace is clean.
- CI: run 36385161068 is complete green; run 36385785464 is the required
  consecutive complete green integration workflow. Both include recovery,
  48/48 service-backed integration tests, 7/7 backfill tests, and all browser
  and axe engines.
- Next exact action: require the hosted CI result for the CS-61 experiment
  revision, then promote only if every required job is green. Leave
  deployment/publication untouched.

The authoritative ticket state is [backlog.json](backlog.json); the truthful
product/runtime map is [PROJECT-STATE.md](../docs/PROJECT-STATE.md).
