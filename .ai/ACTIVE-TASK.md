# Active task

**Status: IN PROGRESS — QA completion and blocker reconciliation.**

Reconciled 2026-09-28 from starting `main` SHA
`3bf265b4fda5fa967146a78ce2910a7cd56f7b4b`. Current working SHA:
`680ba0cd5949dd0a3b271ec44a85990cef16e98f`. No production deployment or
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
  CS-57, CS-63, CS-65, CS-66, CS-67, CS-71, CS-74 and CS-78 to UAT. Historical
  checkpoint wording was retained but explicitly marked superseded; strict
  promotion evidence passes for the named batch.
- CS-61's deliberate two-owner cache-transition experiment is complete and is
  now UAT with exact green CI evidence.
- CS-58 still requires consecutive full-CI confirmation of older unexplained
  flakes.
- CS-82 deployment/Pages gate evidence is complete, has exact hosted-run
  locators, and is now UAT for release-manager acceptance.
- Recreate a coherent dependency update after baseline CI is green (CS-84).
- Review and integrate or intentionally retire the unique work on
  `feature/frontend-pages-admin-console`.
- CS-61's cache-disabled single-document transition harness and paired
  owner-agnostic-key positive control pass in hosted Chromium, Firefox and
  WebKit CI; CS-36's dependent AC2 is now evidenced and both are UAT.
- CS-67's mutation-proof severity rendering is complete and UAT-ready.
- CS-78's V1/V2 boundary is documented in the architecture record, and a Node
  24 mutation proves a fourth matcher-field read fails typecheck; hosted CI is
  green and the ticket is UAT-ready.
- CS-74's paired Node 24 positive/negative preflight controls are now recorded;
  the strict gate accepts its evidence.
- CS-55's fourteen authenticated-GET rate-limit matrix and ordering
  falsification are covered by consecutive Node 24 green CI runs; it is now
  UAT for release-manager acceptance.
- CS-77's canonicalisation test now exercises the required literal-versus-
  pre-parsed retry under one idempotency key, with a different-request conflict
  control retained; its isolated hosted mutation failed with the expected
  IDEMPOTENCY_KEY_REUSED conflict, and the restored exact-revision run is green.
- CS-76's worker test coverage gap is closed: the noEmit project includes
  collect.test.ts, its input-boundary and fixture errors are fixed, and a
  deliberate TS2322 mutation made the checker fail before restoration. Hosted
  Node 24 CI is green and the ticket is UAT.
- The promotion gate was re-run after the batch. CS-36, CS-61, CS-76 and CS-77
  were promoted to UAT with exact hosted-run and mutation locators. CS-14,
  CS-47 and CS-52 are explicitly BLOCKED on owner decisions/live-host
  authority; no ticket is being represented as complete while those inputs are
  missing.

## Remaining QA and blockers

- CS-13, CS-15, CS-72 and CS-79 completed QA and moved to UAT on 2026-09-28.
  CS-13 is covered by hosted browser/axe checks; CS-15 by the hosted public
  Pages accessibility/visual matrix; CS-72 by hosted promotion-evidence and
  consistency checks; and CS-79 by the dated programmatic append/parsed-rule
  demonstration plus hosted eol:check. CS-31 remains UAT after hosted run
  36398473010 attempt 2 proved the 1440px and 320px checks across Chromium,
  Firefox and WebKit.
- CS-15's public Pages audit is now wired into `.github/workflows/ci.yml` via
  `npm run pages:visual`; local Chromium, Firefox and WebKit execution passed
  192 cases. Hosted Node 24 confirmation is the remaining release gate.
- CS-75 is now UAT: non-OK API responses cancel unread bodies,
  the CS-51 browser harness workaround was removed, 400/404 cancellation is
  falsification-tested, and V2 typecheck passes. Hosted browser CI remains.
- CS-69 is now UAT: visual baselines are tracked under `scripts/pages-baseline`,
  missing baselines fail loudly, and 192 Chromium/Firefox/WebKit cases match
  locally. CS-32 now consumes that reproducible baseline and its threshold
  comment matches the actual pixelmatch configuration.
- CS-60 is now UAT with an explicit `v2/apps/api/TESTING.md` pointer to the
  unchanged HTTP integration suite. CS-68's root registration guard is wired
  and classified in CI. CS-73's ownership validator includes synthetic
  contradictory/consistent controls. CS-81's context-sensitive Devanagari
  joiner tests pass locally.
- Hosted CI run 36424073277 passed on commit `abdbd3e73998cd1519f665264ac17edf7a26c0ae`:
  recovery, integration, browser/axe, root checks, V2 unit/typecheck, and the
  strict platform-specific Pages visual matrix all passed. CS-13, CS-15, CS-32,
  CS-60, CS-68, CS-69, CS-72, CS-73, CS-75, CS-79 and CS-81 are promoted to
  UAT; the historical QA wording remains evidence context and is superseded by
  the dated hosted/reproduction records.
- CS-14, CS-47 and CS-52 are BLOCKED on explicit owner decisions or live-host
  authority; these are recorded as dependencies rather than silently waived.

## Current evidence and next action

- Local: V2 formatting passes; all 15 V2 test files type-check; root formatting
  passes; diff whitespace is clean.
- CI: run 36398473010 attempt 2 is complete green on commit
  46ba008fdd35c8bf3d99b52cfc8c40ea00b2ba70, including recovery, 48/48
  service-backed integration tests, backfill, all browser engines and axe.
  Isolated run 36397888648 records CS-77's deliberate normalization-reversion
  failure. Leave deployment/publication untouched.
- Local and hosted evidence agree: `npm run checks:registry`,
  `npm run ticket:consistency`, the focused 110-test V1 suite, V2 typecheck,
  and `npm run pages:visual` all pass. The hosted Node 24 gate is green on the
  exact synchronized SHA recorded above.
- Current hosted evidence is complete for the four QA tickets and the prior
  promoted batch. The next plan is owner-dependent blocker reconciliation; no
  deployment or publication was performed.

The authoritative ticket state is [backlog.json](backlog.json); the truthful
product/runtime map is [PROJECT-STATE.md](../docs/PROJECT-STATE.md).
