# Foundations register

The foundation items are thirteen, 1.01 to 1.13. This register gives each one a
status, the files and tests that prove it, the gate that runs it and the command that
verifies it. `npm run traceability:check` (`scripts/ci/check-traceability.mjs`, part of
`npm run check`) fails when:

- the register does not have exactly the items 1.01 to 1.13, once each and in order;
- an item has no Status (`Complete` or `Open`), no Evidence, no Gate or no Verify line;
- an item is `Open` without a Gap, or `Complete` with one;
- an item cites a file that does not exist;
- an item marked `Complete` cites no test, or cites a test that no CI script runs (the
  rule in [TRACEABILITY](TRACEABILITY.md): the path must be in `test:unit`,
  `test:integration`, `test:domain`, `test:ui`, `test:query-budget` or `gates:test`, or in the
  npm scripts they call);
- this file or the Item 1.02 prose in [TRACEABILITY](TRACEABILITY.md) does not quote the
  current inventory counts.

`Complete` means the stated scope of the item is proven by the cited tests and gates in the
repository. Evidence that lives outside the repository (GitHub rulesets, hosted CI run IDs) is
named in the Evidence line and is not counted by the gate. `Open` names the exact gap. The
launch-blocking requirement gaps in 1.02 are a separate list (see
[V12-RECONCILIATION](requirements/V12-RECONCILIATION.md)). Nothing here records a host check
that was not performed; the Gap lines say what is unverified.

## 1.01 Audit dev modules

- **Status:** Complete
- **Evidence:** `docs/TRACEABILITY.md`, `docs/architecture/BOUNDARIES.md`, `scripts/ci/check-traceability.mjs`, `scripts/ci/check-traceability.test.mjs`, `scripts/ci/check-architecture-boundaries.test.mjs`
- **Gate:** CI job `Quality gates`, step `npm run gates:test` (runs `npm run check`: traceability, architecture boundaries and unit tests)
- **Verify:** `npm run traceability:check`
- **Note:** The audit artefact is the requirement-to-code-to-test matrix over every workspace surface plus the enforced dependency graph. Rows whose tests are `(manual)` are not run by CI.

## 1.02 Reconcile v12

- **Status:** Complete
- **Evidence:** `docs/requirements/CareerScope-v12.md`, `docs/requirements/V12-REQUIREMENT-INVENTORY.json`, `docs/requirements/V12-RECONCILIATION.md`, `scripts/ci/check-requirements-inventory.mjs`, `scripts/ci/check-requirements-inventory.test.mjs`, `scripts/ci/check-traceability.test.mjs`
- **Gate:** CI job `Quality gates`, step `npm run gates:test` (`npm run traceability:check` runs the inventory check; the tests run in `test:unit`)
- **Verify:** `npm run requirements:check`
- **Note:** Reconciliation is complete: every clause of the pinned source has a status, and CI fails on NOT_ASSESSED, a stale digest, a clause text that is not equal to its source line, or IMPLEMENTED without a CI-run test. Current counts: 319 clauses (67 IMPLEMENTED, 72 PARTIAL, 125 NOT_IMPLEMENTED, 47 OWNER_EVIDENCE, 8 OUT_OF_SCOPE_POST_LAUNCH); 165 launch-blocking gaps. Those gaps are open for later stages; see [V12-RECONCILIATION](requirements/V12-RECONCILIATION.md).

## 1.03 Preserve dev and main branches

- **Status:** Complete
- **Evidence:** GitHub rulesets 26263919 (Protect Production Main, on main: pull request, required status checks, linear history, deletion and force-push blocked, repository-admin bypass) and 26263965 (Protect dev, on dev: deletion and force-push blocked), read back with the GitHub rulesets API on 2026-10-31. `.github/workflows/ci.yml`, `scripts/ci/check-deploy-gate.test.mjs`
- **Gate:** CI triggers on pushes and pull requests to main and dev; the deploy gate test runs inside gates:test
- **Verify:** npm run deploy:gate:test; read the rulesets with the GitHub rulesets API
- **Note:** dev has no required status check. A required check would block direct pushes, because the owner pushes to dev without a pull request and has no bypass on that ruleset.

## 1.04 Enforce GitHub Actions quality gates

- **Status:** Complete
- **Evidence:** Ruleset 26263919 requires the checks Quality gates and Services, integration, and browser suites on main. Production image build runs on pull requests only, so it is not a push check. `.github/workflows/ci.yml`, `scripts/ci/check-package-scripts.test.mjs`
- **Gate:** CI job Quality gates (including the shell syntax step over infra/) and Services, integration, and browser suites
- **Verify:** npm run gates:test; read ruleset 26263919 with the GitHub rulesets API
- **Note:** see 1.03 for why dev has no required check.

## 1.05 Resolve Chromium acceptance failures

- **Status:** Complete
- **Evidence:** `docs/UI-VERIFICATION.md`, `scripts/tests/check-ui.ts`, `scripts/tests/ui-requests.test.ts`, `scripts/tests/ui-browsers.test.ts`. Root cause of the settlement failure: a stranded GET /_next/image request from the shell logo after navigation, which Chromium never reports as finished or failed. Fixed by a Chromium-only allowance in the ui-requests helper (commit 91bdb45), and a tolerance for response bodies that Chromium evicts before they are read (commit da62f86). Hosted Services, integration, and browser suites ran three times on commit a300856 with the browser suite only (dispatched runs 41185733604, 41186037765 and 41186340898, all success) and the push run for a300856 also passed.
- **Gate:** CI job Services, integration, and browser suites (step npm run test:ui); the unit tests run in `Quality gates`
- **Verify:** CAREERSCOPE_UI_BROWSER=chromium npm run test:ui (needs the Docker services and a production build)
- **Note:** three consecutive hosted passes show the fix works on the hosted runner, but they are a small sample, not a measured flake rate. An earlier hosted failure on 82eba82 was the evicted-body race that da62f86 fixed.

## 1.06 Validate Node, Next.js, Fastify and dependencies

- **Status:** Complete
- **Evidence:** `scripts/ci/check-toolchain.mjs`, `scripts/ci/check-toolchain.test.mjs`, `scripts/ci/check-node-version.mjs`, `scripts/ci/check-node-version.test.mjs`, `scripts/ci/dependency-remediation.test.mjs`, `docs/operations/TOOLCHAIN.md`
- **Gate:** CI job `Quality gates`, steps `Check toolchain consistency`, `npm audit --omit=dev --audit-level=high` and `npm audit --audit-level=high`; the unit tests run in `npm run gates:test`
- **Verify:** `npm run toolchain:check`

## 1.07 Validate PostgreSQL and Drizzle migration integrity

- **Status:** Complete
- **Evidence:** `tests/integration/migrations.integration.test.ts`, `migrations`, `drizzle.config.ts`, `packages/core/src/schema.ts`, `docs/DATA-MODEL.md`
- **Gate:** CI job `Quality gates`, step `npm run migrations:check` (drizzle-kit check); job `Services, integration, and browser suites`, steps `npm run db:migrate` and `npm run test:integration`
- **Verify:** `npm run migrations:check`, then `npm run test:integration` against a throwaway PostgreSQL

## 1.08 Verify Redis and the transactional outbox

- **Status:** Complete
- **Evidence:** `packages/core/src/outbox.integration.test.ts`, `packages/core/src/queue.integration.test.ts`, `packages/core/src/bull-queue.integration.test.ts`, `packages/core/src/runtime.integration.test.ts`, `docs/architecture/OUTBOX.md`
- **Gate:** CI job `Services, integration, and browser suites`: Redis readiness, append-only and `noeviction` checks, then `npm run test:integration`
- **Verify:** `npm run test:integration` (needs PostgreSQL and both Redis services from `npm run services` and `npm run services:queue`)
- **Note:** The queue-runtime crash checks (`npm run test:queue-runtime`) run only in the manual `recovery` suite. Known limitation: no test sends SIGTERM or SIGINT to the worker `main.ts` entry points, so their shutdown on a signal is not covered by a test.

## 1.09 Standardise typed API responses and errors

- **Status:** Complete
- **Evidence:** `apps/api/src/errors.ts`, `apps/api/src/openapi.ts`, `apps/api/src/error-handler.test.ts`, `docs/API-SURFACE.md`
- **Gate:** CI job `Quality gates`, step `npm run gates:test` (`test:unit`)
- **Verify:** `node --import tsx --test apps/api/src/error-handler.test.ts`

## 1.10 Document domain event contracts

- **Status:** Complete
- **Evidence:** `docs/architecture/DOMAIN-EVENTS.md`, `scripts/tests/domain-events-doc.test.ts`, `packages/core/src/commands.test.ts`
- **Gate:** CI job `Quality gates`, step `npm run gates:test` (`test:unit`)
- **Verify:** `node --import tsx --test scripts/tests/domain-events-doc.test.ts`

## 1.11 Establish architecture boundaries for job, matching and resume

- **Status:** Complete
- **Evidence:** `docs/architecture/BOUNDARIES.md`, `scripts/ci/check-architecture-boundaries.mjs`, `scripts/ci/check-architecture-boundaries.test.mjs`
- **Gate:** CI job `Quality gates`, step `npm run gates:test` (`npm run architecture:check` and `test:unit`)
- **Verify:** `npm run architecture:check`
- **Note:** The checker reads source imports only; it does not compare `package.json` dependency declarations.

## 1.12 Align design system and shared components

- **Status:** Complete
- **Evidence:** `docs/architecture/DESIGN-SYSTEM.md`, `scripts/tests/design-system-doc.test.ts`, `apps/web/src/components/ui-states.tsx`, `apps/web/src/app/globals.css`
- **Gate:** CI job `Quality gates`, step `npm run gates:test` (`test:unit`)
- **Verify:** `node --import tsx --test scripts/tests/design-system-doc.test.ts`
- **Note:** The test proves the documented tokens and shared components match the code. Visual regression has no committed baseline set.

## 1.13 Build requirement-to-code-to-test traceability

- **Status:** Complete
- **Evidence:** `docs/TRACEABILITY.md`, `scripts/ci/check-traceability.mjs`, `scripts/ci/check-traceability.test.mjs`, `docs/requirements/V12-REQUIREMENT-INVENTORY.json`
- **Gate:** CI job `Quality gates`, step `npm run gates:test` (`npm run traceability:check`)
- **Verify:** `npm run traceability:check`
- **Note:** The mechanism and register exist and fail closed. The requirement gaps they expose are the 1.02 gaps, open for later stages.
