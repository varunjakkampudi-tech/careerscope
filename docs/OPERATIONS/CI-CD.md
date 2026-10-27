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

Hosted Actions is active. Run 40061071316 on `e4913be34f954e91cf35ea70478a6a84a5e5b9f3`
passed the selected Chromium browser job, but skipped integration, static/security,
recovery, performance and soak suites; it is not full CI acceptance. Run
40076912878 on `main` at `d1d13e83a0e154580aa0b8b8d084f9e007178a2d` failed the
service startup and full dependency audit steps. The exact current integrated
candidate must pass all required jobs; historical/selected runs are not substitutes.

Per OA-2026-10-25-01, `dev` is the development integration branch and `main` is
protected production-only. Direct pushes to `dev` are allowed only after required
local validation; no autonomous merge/push to `main`, protection change, or
deployment is permitted. This workflow never deploys.

## Checks and suite mapping

Pushes and scheduled runs run `npm run gates:test` (Node policy, approved source
integrity, local workflow policy, then `npm run check`: EOL, privacy, Prettier,
ESLint, type checks and unit tests), the domain suite, the production build, and a full
`npm audit --audit-level=high`. The manual `checks` suite runs gates,
build and the full audit; `domain` is a separate manual suite. An unaccepted
high/critical advisory is a real failure; do not skip or waive the audit. Main's
last recorded full audit failed; the isolated dependency candidate is not yet
integrated or fully validated.

The service job starts isolated PostgreSQL 17.6 and two Redis 7.4.5 containers.
All three container references are pinned to image digests, bound to loopback,
and discarded after the job. Redis runs with AOF enabled and `noeviction`
(required by the queue contract); the job verifies that policy before tests.
PostgreSQL is named explicitly for the recovery harness, uses a temporary
filesystem, and receives only synthetic credentials. The job writes only a
synthetic ephemeral `.env` in the runner. Suite mapping:

| Manual suite    | Commands                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `all`           | Static checks, integration, browser/axe/responsive, domain, security audit, performance, soak, recovery |
| `checks`        | Formatting, gates, build, full dependency audit                                                         |
| `integration`   | `npm run test:integration`                                                                              |
| `browser`       | `npm run test:ui` in the selected browser                                                               |
| `cross-browser` | Browser suite on Chromium, Firefox, and WebKit                                                          |
| `domain`        | `npm run test:domain`                                                                                   |
| `security`      | Full dependency audit and privacy scan                                                                  |
| `performance`   | `npm run test:performance` against ephemeral services                                                   |
| `soak`          | `npm run test:soak` against ephemeral services                                                          |
| `recovery`      | Queue runtime, database recovery, and crash-recovery commands                                           |

The browser command also runs axe, keyboard and responsive checks. It currently
creates screenshots under `test-results`; these are not uploaded because their
content has not been scrubbed for personal/sensitive data. The job summary
records event, ref, SHA, suite and browser; command output remains in individual
workflow logs. Skipped suites are not described as passed.

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
