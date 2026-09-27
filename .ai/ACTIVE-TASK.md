# Active task

**Status: IN PROGRESS — CS-85 integration and browser acceptance recovery.**

Reconciled 2026-09-28 from starting `main` SHA
`8adbe89c74d8a52c295f11638d937012cb5cc27f`. The current committed main SHA is
`0476f064a90fecea4a73560ca3bede5e38bb5e96`; work is isolated on
`fix/CS-85-browser-worker-runtime`. No production deployment or publication has
been run.

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

- Commit and push the CS-85 browser-worker environment repair.
- Require two consecutive complete integration workflow runs within budget,
  including Chromium, Firefox, WebKit, and axe acceptance.
- Promote CS-83 only after its successful recovery evidence is recorded on the
  board; promote CS-85 only after the two-run acceptance criterion is met.
- Recreate a coherent dependency update after baseline CI is green (CS-84).
- Review and integrate or intentionally retire the unique work on
  `feature/frontend-pages-admin-console`.

## Current evidence and next action

- Local: V2 formatting passes; all 15 V2 test files type-check; root formatting
  passes; diff whitespace is clean.
- CI: run 36355198109 is red only in the browser phase described above; recovery
  is green. Its root job was still running when this state was written.
- Next exact action: commit and push this branch, monitor the resulting CI run,
  fix any real failure, then dispatch one manual CI run for the required second
  consecutive result. Keep CS-85 in QA until both are green.

The authoritative ticket state is [backlog.json](backlog.json); the truthful
product/runtime map is [PROJECT-STATE.md](../docs/PROJECT-STATE.md).
