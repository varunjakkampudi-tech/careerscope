# Active task

**Status: IN PROGRESS — repository takeover and release-safety repair.**

Reconciled 2026-09-27 from `main` at
`8adbe89c74d8a52c295f11638d937012cb5cc27f`. Work is isolated on
`chore/repository-hygiene`; no production deployment or publication has been
run.

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

## Still open

- Obtain green CI evidence for the committed workflow changes.
- Root-cause the database recovery termination (CS-83).
- Root-cause the V2 integration timeout without weakening coverage (CS-85).
- Recreate a coherent dependency update after baseline CI is green (CS-84).
- Review and integrate or intentionally retire the unique work on
  `feature/frontend-pages-admin-console`.

The authoritative ticket state is [backlog.json](backlog.json); the truthful
product/runtime map is [PROJECT-STATE.md](../docs/PROJECT-STATE.md).
