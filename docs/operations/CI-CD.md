# CI and delivery automation

## Current state

`.github/workflows/ci.yml` is a CI-only workflow. It never publishes or deploys
to a host and has no repository or environment secrets. Its job permissions are
read-only, its third-party actions are pinned to full commit SHAs, and its
PostgreSQL/Redis credentials are synthetic values confined to ephemeral runner
services.

The workflow listens to pushes on `dev` and `main`, pull requests targeting
either branch, a nightly schedule, and an allowlisted `workflow_dispatch`.
Pushes to either branch, pull requests to either branch, and the nightly event also
run the PostgreSQL/Redis integration and browser suite; pull-request and nightly
browser runs select Chromium, Firefox, and WebKit. Manual runs use only CI-ephemeral
services; there is no staging or production target. Pull-request runs have
read-only permissions, use no repository secrets, and validate the proposed
merge revision.

Hosted Actions is enabled: the workflow runs on pushes to `dev` and `main`. This
section is the single statement of what has been verified; other documents link here
instead of repeating it.

- Verified on a hosted runner for the current commit: nothing. Status is **pending
  until the run on this commit**. Record the run URL and the full SHA here once that
  run exists and every required job is green.
- Earlier runs on earlier commits ended in failure and are not acceptance evidence,
  whatever they covered. No run ID is quoted here because it would go stale with the
  next push; read the run list on GitHub for the commit under review.
- A selected-suite or single-browser manual run does not substitute for a full run of
  all required jobs on the exact integrated candidate.

Per OA-2026-10-25-01, `dev` is the development integration branch and `main` is
protected production-only. Direct pushes to `dev` are allowed only after required
local validation; no autonomous merge/push to `main`, protection change, or
deployment is permitted. This workflow never deploys.

## Checks and suite mapping

Pushes and scheduled runs run `npm run gates:test` (Node policy, approved source
integrity, local workflow policy, then `npm run check`: EOL, privacy, architecture boundaries, traceability, Prettier,
ESLint, type checks and unit tests), the domain suite, the production build, the
toolchain check, `drizzle-kit check`, and two dependency audits:
`npm audit --omit=dev --audit-level=high` (shipped dependencies) and
`npm audit --audit-level=high` (full tree). `npm run security:check` runs the same two audits. The manual `checks` suite runs gates,
build and the full audit; `domain` is a separate manual suite. An unaccepted
high/critical advisory is a real failure; do not skip or waive the audit.

| Check                       | Command                                          | Job           | Fails when                                                                                                                                                              |
| --------------------------- | ------------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Policy gates and local gate | `npm run gates:test`                             | Quality gates | Node policy, privacy, deploy gate, EOL, boundaries, traceability, format, lint, types or unit tests fail                                                                |
| Toolchain                   | `npm run toolchain:check`                        | Quality gates | `.nvmrc`, `engines.node`, the workflow `NODE_VERSION` or the Dockerfile Node major disagree, or Next.js or Fastify majors drift from the lockfile                       |
| Migrations                  | `npm run migrations:check` (`drizzle-kit check`) | Quality gates | The journal, SQL and snapshots are inconsistent                                                                                                                         |
| Domain tests                | `npm run test:domain`                            | Quality gates | A matching, providers, resume or shared test fails                                                                                                                      |
| Production build            | `npm run build`                                  | Quality gates | Compilation or the web build fails                                                                                                                                      |
| Production audit            | `npm audit --omit=dev --audit-level=high`        | Quality gates | A shipped dependency has a high or critical advisory                                                                                                                    |
| Full-tree audit             | `npm audit --audit-level=high`                   | Quality gates | Any dependency has a high or critical advisory                                                                                                                          |
| Integration                 | `npm run test:integration` (serial)              | Services      | A PostgreSQL or Redis suite fails, under production database timeouts                                                                                                   |
| Query budget                | `npm run test:query-budget`                      | Services      | The pool is not on the 10 s statement and 5 s connect defaults, or a representative query (run on an empty, freshly migrated schema, so not a volume test) exceeds 10 s |
| Browser                     | `npm run test:ui`                                | Services      | A Chromium, Firefox or WebKit acceptance, axe or responsive check fails                                                                                                 |

`npm run test:ui` does not build or start the web app; the services job runs
`npm run build` and starts `next start` on port 5280 first.

### Integration timeouts

The integration suites run serially (`--test --test-concurrency=1`, asserted by
`scripts/ci/check-package-scripts.test.mjs`) with the production database timeouts. Only
`packages/core/src/bull-queue.integration.test.ts` gets raised values, from
`scripts/tests/bull-queue.integration.env`, through `npm run test:integration:bull-queue`.
Do not set these variables at job level; CI fails if `ci.yml` mentions them.

| Variable                        | Production default | Bull-queue suite | Valid range            | Effect                                                                                                 |
| ------------------------------- | ------------------ | ---------------- | ---------------------- | ------------------------------------------------------------------------------------------------------ |
| `DATABASE_STATEMENT_TIMEOUT_MS` | 10000              | 60000            | integer 1000 to 600000 | PostgreSQL statement timeout of the pool. In production anything above 10000 is capped, with a warning |
| `DATABASE_CONNECT_TIMEOUT_MS`   | 5000               | 30000            | integer 1000 to 120000 | Pool connect timeout. In production anything above 5000 is capped, with a warning                      |
| `INTEGRATION_JOB_WAIT_MS`       | 10000              | 60000            | integer 1000 to 600000 | How long the bull-queue test waits for a job to finish. An invalid value throws                        |

An invalid statement or connect value makes the process fail at startup naming the variable.

The service job starts isolated PostgreSQL 17.6 and two Redis 7.4.5 containers.
All three container references are pinned to image digests, bound to loopback,
and discarded after the job. Redis runs with AOF enabled and `noeviction`
(required by the queue contract); the job verifies that policy before tests.
PostgreSQL is named explicitly for the recovery harness, uses a temporary
filesystem, and receives only synthetic credentials. The job writes only a
synthetic ephemeral `.env` in the runner. Suite mapping:

| Manual suite    | Commands                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| `all`           | Static checks, integration, browser/axe/responsive, domain, security audit, performance, soak, recovery  |
| `checks`        | Formatting, gates, build, full dependency audit                                                          |
| `integration`   | `npm run test:integration`, `npm run test:query-budget`, `node infra/checks/check-production-config.mjs` |
| `browser`       | `npm run test:ui` in the selected browser                                                                |
| `cross-browser` | Browser suite on Chromium, Firefox, and WebKit                                                           |
| `domain`        | `npm run test:domain`                                                                                    |
| `security`      | Full dependency audit and privacy scan                                                                   |
| `performance`   | `npm run test:performance` against ephemeral services                                                    |
| `soak`          | `npm run test:soak` against ephemeral services                                                           |
| `recovery`      | Queue runtime, database recovery, crash-recovery and full-disk commands                                  |

The browser command also runs axe, keyboard and responsive checks. It currently
creates screenshots under `test-results`; these are not uploaded because their
content has not been scrubbed for personal/sensitive data. The job summary
records event, ref, SHA, suite and browser; command output remains in individual
workflow logs. Skipped suites are not described as passed.

## Required status checks

Branch protection is owner-controlled; this repository and its agents cannot
change it, and no protection setting has been changed. To make the gates
blocking, the owner must require these exact check names on `main` and `dev`
(GitHub shows them as the job `name`, under the workflow `CareerScope CI`):

| Required check name                         | Runs on            | What it proves                                                                                                                                                                    |
| ------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Quality gates`                             | push, PR, nightly  | `npm run gates:test` (`npm run check` with unit tests, EOL, privacy, boundaries, traceability), toolchain check, `drizzle-kit check`, domain tests, build, both dependency audits |
| `Services, integration, and browser suites` | push, PR, nightly  | Fresh-database migration apply (`npm run db:migrate`), integration tests on PostgreSQL and two Redis service containers, browser/axe/responsive checks                            |
| `Production image build`                    | pull requests only | `runtime` and `proxy` targets of `infra/docker/Dockerfile` build; nothing is pushed                                                                                               |

`Production image build` is skipped on pushes and nightly runs. GitHub counts a
skipped required check as passing, so require it only on pull requests (the
default for a required check) and do not read a skipped result as a build.
Require pull requests to be up to date with the base branch so the checks run
against the merge result.

Workflow properties: every action is pinned to a full commit SHA; the workflow and
each job declare `permissions: contents: read`; there are no repository secrets;
`concurrency` cancels a superseded pull-request run and never cancels branch or
scheduled runs. The services job uses Docker containers started with `docker run`
rather than GitHub `services:` blocks, so Redis AOF and `noeviction` can be set
and verified; they are digest-pinned and loopback-only.

## Local validation

Use Node 24 and a sanitized `.env`. Run `npm run gates:test`, `npm run
test:domain`, `npm run build`, and applicable service-backed tests. For Playwright
selection, set `CAREERSCOPE_UI_BROWSER` to `chromium`, `firefox`, `webkit`, or
`all`; the default is `all` for direct local invocation. Build the web app and
start it with `npm run start --workspace @careerscope/web` before running
`npm run test:ui` in another terminal. Use isolated PostgreSQL/Redis with the
queue instance configured for AOF and `noeviction`. Do not put secrets, owner
data or private resumes in CI fixtures.

## Staging and release boundary

There is no isolated staging host, GitHub staging environment, staging
deployment workflow, or validated staging rollback. Production deployment
remains owner-only and is not automated here. See
[`STAGING.md`](STAGING.md) for the blocker and owner
prerequisites. Do not repurpose production infrastructure as staging.
