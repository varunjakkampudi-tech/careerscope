# Stage 1 register

The owner list for Stage 1 has fifteen items, 1.01 to 1.15. This register gives each one a
status, the files and tests that prove it, the gate that runs it and the command that
verifies it. `npm run traceability:check` (`scripts/ci/check-traceability.mjs`, part of
`npm run check`) fails when:

- the register does not have exactly the items 1.01 to 1.15, once each and in order;
- an item has no Status (`Complete` or `Open`), no Evidence, no Gate or no Verify line;
- an item is `Open` without a Gap, or `Complete` with one;
- an item cites a file that does not exist;
- an item marked `Complete` cites no test, or cites a test that no CI script runs (the
  rule in [TRACEABILITY](TRACEABILITY.md): the path must be in `test:unit`,
  `test:integration`, `test:domain`, `test:ui`, `test:query-budget` or `gates:test`, or in the
  npm scripts they call);
- this file or the Stage 1.02 prose in [TRACEABILITY](TRACEABILITY.md) does not quote the
  current inventory counts.

`Complete` means the stated scope of the item is proven by the cited tests and gates. It does not
mean the product is launch-ready: the launch-blocking requirement gaps in 1.02 are open for
later stages. `Open` names the exact gap. Nothing here records a CI run or a host check that was
not performed; the Gap lines say what is unverified.

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
- **Note:** Reconciliation is complete: every clause of the pinned source has a status, and CI fails on NOT_ASSESSED, a stale digest, a clause text that is not equal to its source line, or IMPLEMENTED without a CI-run test. Current counts: 319 clauses (67 IMPLEMENTED, 75 PARTIAL, 119 NOT_IMPLEMENTED, 50 OWNER_EVIDENCE, 8 OUT_OF_SCOPE_POST_LAUNCH); 165 launch-blocking gaps. Those gaps are open for later stages; see [V12-RECONCILIATION](requirements/V12-RECONCILIATION.md).

## 1.03 Preserve dev and main branches

- **Status:** Open
- **Gap:** Branch protection on `main` and `dev` is an owner-controlled GitHub setting that this repository cannot change or read, and no protection setting has been verified. The repository only runs CI on both branches and gates production deploys.
- **Evidence:** `.github/workflows/ci.yml`, `docs/operations/CI-CD.md`, `scripts/ci/check-deploy-gate.mjs`, `scripts/ci/check-deploy-gate.test.mjs`
- **Gate:** CI triggers on pushes and pull requests to `main` and `dev` (the `on:` block of the workflow); `npm run deploy:gate:test` inside `npm run gates:test`
- **Verify:** `npm run deploy:gate:test`; the owner reads the protection rules in the GitHub repository settings

## 1.04 Enforce GitHub Actions quality gates

- **Status:** Open
- **Gap:** The workflow defines the gates, but making them blocking needs the owner to require the exact check names `Quality gates`, `Services, integration, and browser suites` and (pull requests only) `Production image build` on `main` and `dev`. That is not applied or verified from the repository.
- **Evidence:** `.github/workflows/ci.yml`, `docs/operations/CI-CD.md`, `scripts/ci/require-ci-success.mjs`, `scripts/ci/check-package-scripts.test.mjs`
- **Gate:** CI job `Quality gates` (including the shell syntax step over `infra/`) and `Services, integration, and browser suites`
- **Verify:** `npm run gates:test`

## 1.05 Resolve Chromium acceptance failures

- **Status:** Open
- **Gap:** Chromium passes the browser acceptance run on one Windows host, recorded in the 2026-10-28 sections of UI-VERIFICATION. The long-standing notification-panel settlement failure was resolved by a test-side allowance (`staleEarlierRouteRead`) for requests the app aborts, and Chromium has since shown timing-dependent failures under load. The `Services, integration, and browser suites` job is green on the hosted runner for commit eec8ec4. The remaining gap is flake measurement: the browser timing failure was observed once in four local runs, and it has not been measured on the hosted runner across repeated runs.
- **Evidence:** `docs/UI-VERIFICATION.md`, `scripts/tests/check-ui.ts`, `scripts/tests/ui-requests.test.ts`, `scripts/tests/ui-browsers.test.ts`
- **Gate:** CI job `Services, integration, and browser suites`, step `npm run test:ui`; the unit tests run in `Quality gates`
- **Verify:** `CAREERSCOPE_UI_BROWSER=chromium npm run test:ui` (needs the Docker services and a production build)

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
- **Note:** The queue-runtime crash checks (`npm run test:queue-runtime`) run only in the manual `recovery` suite.

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

## 1.12 Verify sensitive data separation and encryption

- **Status:** Open
- **Gap:** Code-level evidence exists: credentials are stored only as digests (database dump test) and resume objects are encrypted with a key held outside the object store. Verification on the running host is not done: key file mode and ownership in the live `private` volume, backup key custody separated from the ciphertext archive, and TLS and secret files as deployed. Those need the target environment and owner evidence.
- **Evidence:** `docs/security/DATA-CLASSIFICATION.md`, `packages/core/src/sensitive-data.integration.test.ts`, `packages/core/src/file-storage.test.ts`, `docs/operations/SECRETS.md`
- **Gate:** CI job `Services, integration, and browser suites`, step `npm run test:integration` (digests); job `Quality gates`, `test:unit` (file storage) and `npm run privacy:check`
- **Verify:** `npm run test:integration`; host checks are not available from the repository

## 1.13 Align design system and shared components

- **Status:** Complete
- **Evidence:** `docs/architecture/DESIGN-SYSTEM.md`, `scripts/tests/design-system-doc.test.ts`, `apps/web/src/components/ui-states.tsx`, `apps/web/src/app/globals.css`
- **Gate:** CI job `Quality gates`, step `npm run gates:test` (`test:unit`)
- **Verify:** `node --import tsx --test scripts/tests/design-system-doc.test.ts`
- **Note:** The test proves the documented tokens and shared components match the code. Visual regression has no committed baseline set.

## 1.14 Build requirement-to-code-to-test traceability

- **Status:** Complete
- **Evidence:** `docs/TRACEABILITY.md`, `scripts/ci/check-traceability.mjs`, `scripts/ci/check-traceability.test.mjs`, `docs/requirements/V12-REQUIREMENT-INVENTORY.json`
- **Gate:** CI job `Quality gates`, step `npm run gates:test` (`npm run traceability:check`)
- **Verify:** `npm run traceability:check`
- **Note:** The mechanism and register exist and fail closed. The requirement gaps they expose are the 1.02 gaps, open for later stages.

## 1.15 Preserve backups and recoverability

- **Status:** Open
- **Gap:** CI proves backup, encryption and restore of a fixture dump against a throwaway PostgreSQL container. There is no automated off-host copy, and no restore of a real host backup has been recorded. RTO and RPO at production size are assumed, not measured.
- **Evidence:** `infra/checks/check-backup.sh`, `infra/host/backup.sh`, `docs/operations/BACKUP.md`, `scripts/tests/check-database-recovery.ts` (manual)
- **Gate:** CI job `Services, integration, and browser suites`, step `bash infra/checks/check-backup.sh`; the `recovery` suite runs `npm run test:database-recovery` on manual dispatch only
- **Verify:** `bash infra/checks/check-backup.sh` (needs Docker)
