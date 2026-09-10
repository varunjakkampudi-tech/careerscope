---
name: CareerScope Testing And Completion
description: 'Use when writing tests, fixing regressions, validating UI or preparing a release: focused checks, realistic fixtures and evidence-based completion.'
applyTo: '**/*.test.ts,**/*.test.tsx,**/*.test.mjs,**/*.fixtures.ts,apps/web/src/test/**,scripts/check-*.mjs,vitest.config.ts,tsconfig.test*.json,.github/workflows/**'
---

# Testing And Completion Rules

- Use existing Vitest/Testing Library helpers and colocated tests; use Node's test
  runner for the established Pages/runtime tests and Playwright for browser behavior.
- Write a regression that exercises the owning behavior and can fail for the bug.
  Include relevant invalid input, auth denial, cancellation, retries, partial
  failures, duplicate/uncertain submissions and persistence checks.
- Keep fixtures synthetic and isolated. Never use real credentials, owner databases,
  resumes or external job submissions as automated test fixtures.
- Run the cheapest relevant executable check immediately after an edit. Do not use
  a diff-only review in place of an available behavior test, compile or lint check.
- Broaden checks when changes affect shared contracts, public exports, authentication
  or releases. Required general gates are `npm run typecheck`, `npm run lint`,
  `npm test`, `npm run build` and `npm run format:check`.
- Pages changes need `npm run pages:test`; public workflow changes also need
  `npm run pages:workspace:test`. Admin behavior uses `node scripts/check-admin-ui.mjs`.
- Built-app behavior uses `npm run test:ui`. Infrastructure startup guards use
  `node --test infra/application-runtime.test.mjs`; these do not replace Docker tests.
- Check responsive UI in Chromium, Firefox and WebKit, including 320px width,
  keyboard/focus, themes, storage failure, loading and error states. Linux font
  metrics can differ from macOS; keep remote browser gates enabled.
- Inspect screenshots when visuals change. Update visual baselines only after
  reviewing the intended differences, never simply to silence a failure.
- Verify the final versioned release, successful CI/deployment and expected live
  assets/workflows when publication is authorized. Report passed, failed, skipped
  and unrun checks separately, with concrete blockers and remaining manual gates.
