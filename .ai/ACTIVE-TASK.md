# Active task

**Status: IN PROGRESS — release evidence reconciliation after CS-85 acceptance.**

Reconciled 2026-09-28 from starting `main` SHA
`8adbe89c74d8a52c295f11638d937012cb5cc27f`. The current committed main SHA is
`4cb574086df4e0e4a8e80defc2cdc35a3d384a79`. No production deployment or
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
- CS-61 still requires its deliberate two-owner cache-transition experiment;
  CS-58 still requires consecutive full-CI confirmation of older unexplained
  flakes.
- Recreate a coherent dependency update after baseline CI is green (CS-84).
- Review and integrate or intentionally retire the unique work on
  `feature/frontend-pages-admin-console`.

## Current evidence and next action

- Local: V2 formatting passes; all 15 V2 test files type-check; root formatting
  passes; diff whitespace is clean.
- CI: run 36385161068 is complete green; run 36385785464 is the required
  consecutive complete green integration workflow. Both include recovery,
  48/48 service-backed integration tests, 7/7 backfill tests, and all browser
  and axe engines.
- Next exact action: reconcile this state and the external report, then leave
  deployment/publication untouched. Release Manager owns UAT acceptance.

The authoritative ticket state is [backlog.json](backlog.json); the truthful
product/runtime map is [PROJECT-STATE.md](../docs/PROJECT-STATE.md).
