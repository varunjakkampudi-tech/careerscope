# Dependency advisory exceptions

Each exception is temporary, narrow and reviewed. Vulnerability scanning stays on: CI runs
`npm audit --omit=dev --audit-level=high` and `npm audit --audit-level=high` on every push, and Dependabot
is configured in `.github/dependabot.yml`. An exception never silences a scan. It documents why a finding
does not fail the gate.

## EX-2026-01: minimatch 3.x (GHSA-g3hv-75wg-m249)

- **Advisory:** `minimatch` below 11.0.1 has a denial-of-service issue from globparts amplification (ReDoS).
- **Affected package:** `minimatch@3.1.5`, reached through `eslint-plugin-jsx-a11y`, `eslint-plugin-import`,
  `eslint-plugin-react` and `@eslint/eslintrc` in the ESLint 9 toolchain. Severity: moderate.
- **Development-only (verified):** `npm ls minimatch --omit=dev` shows only `minimatch@11.0.3`, under
  `glob` in `@fastify/static` (patched version). `npm ls eslint --omit=dev` is empty. The vulnerable copy is
  not in the production install or the runtime image.
- **Exposure:** a ReDoS needs attacker-controlled glob patterns. ESLint reads only repository-controlled
  patterns during lint, and no request path, worker or user input reaches it.
- **No compatible fix (verified 2026-11-02):**
  - npm's suggested fixes are semver-major downgrades (`eslint@4.0.0`, `eslint-plugin-jsx-a11y@6.4.1`), not upgrades.
  - Forcing `minimatch` to 11 across the tree would change the API ESLint 9 calls.
  - `eslint@latest` (10.x) depends on `minimatch ^10.2.6`, which is patched, but `eslint-plugin-jsx-a11y@latest`
    still depends on `minimatch ^3.1.2`, so the plugin is the blocker.
  - No patched 3.x release exists.
- **Remediation trigger:** any of these, whichever comes first:
  1. `eslint-plugin-jsx-a11y` or `eslint-plugin-import` releases a version without minimatch 3, and
     `eslint-config-next` accepts it.
  2. The repository moves to ESLint 10 with compatible plugins.
  3. The advisory is reclassified, or a higher-severity advisory affects this chain.
- **Review criteria:** before each release gate, re-run `npm ls minimatch --omit=dev` (must stay empty of 3.x)
  and `npm view eslint-plugin-jsx-a11y@latest dependencies`. Close the exception as soon as the trigger is met.
- **Expiry:** reviewed at Stage 01 closure and at each stage gate. It must not carry into a release without a
  fresh review.
- **Authority:** owner decision for Stage 01, permitting a narrow exception only after the checks above were verified (2026-11-02).
