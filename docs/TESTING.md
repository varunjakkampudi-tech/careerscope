# Testing

Use Node 24 and a sanitized `.env` for local checks.

## Fast checks

```powershell
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:domain
npm run privacy:test
npm run privacy:check
npm run build
```

## Service-backed checks

Start PostgreSQL and Redis with `npm run services`, then run
`npm run test:integration`, `npm run test:ui` and the recovery/queue checks
that match the change. These checks are environment-dependent; a command not
run because services or browsers are unavailable is not evidence of success.

`check-ui.ts` retains the existing workspace/session/password-account
compatibility regressions using synthetic account fixtures. The removed signup
form is no longer exercised; fixture sessions enter through the selector.
Private test-access integration checks independently use the real two-account
allowlist and reject missing/forged staging assertions, unknown identities,
cross-owner reads and registration/password mutations in test mode.

## Test layout and naming

- `*.test.ts` beside the source runs under `npm run test:unit` (node:test) or, for
  the shared, resume, matching and providers packages, `npm run test:domain` (Vitest).
- `*.integration.test.ts` needs PostgreSQL and Redis and runs only under
  `npm run test:integration`. These files sit beside the code they cover, except the
  system tests in `tests/integration/`.
- `tests/integration/database.integration.test.ts` is the shared database harness. It
  also holds the API's HTTP-level integration tests, driving the API app with
  `app.inject()`. Keep the API's test surface there instead of creating a duplicate
  suite. `tests/integration/test-users.integration.test.ts` covers private test access.
- Both `test:unit` and `test:integration` list their files explicitly in the root
  `package.json`; a new test file must be added to the matching list.
- `tsconfig.test.json` type-checks every test file (`npm run typecheck:tests`).

## Security and release evidence

`npm run security:check` includes the privacy scan and production dependency
audit. The CI-only workflow additionally runs the full dependency audit, which
currently reports known high-severity development dependency findings and must
remain a blocking result until fixed or owner-disposed. GitHub Actions is
disabled in repository settings; local tests cannot prove hosted CI. Manual
accessibility, hosted provider, backup/restore and live smoke evidence remain
separate acceptance gates.

The Playwright harness runs all three engines when invoked locally without a
browser selection and accepts
`CAREERSCOPE_UI_BROWSER=chromium|firefox|webkit|all`. Unsupported values fail
closed. The hosted workflow explicitly selects Chromium for manual browser runs
unless another engine is chosen, and runs all three engines nightly. Its axe,
keyboard, responsive and user-isolation checks are one browser acceptance
suite; screenshots are local test outputs and must not be published as artifacts
without a separate privacy review.
