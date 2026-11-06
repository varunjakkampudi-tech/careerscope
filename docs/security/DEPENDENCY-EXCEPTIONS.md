# Dependency advisory exceptions

Each exception is temporary, narrow and reviewed. Vulnerability scanning stays on: CI runs
`npm audit --omit=dev --audit-level=high` and `npm audit --audit-level=high` on every push, and Dependabot
is configured in `.github/dependabot.yml`. An exception never silences a scan. It documents why a finding
does not fail the gate.

## EX-2026-01: minimatch 3.x (GHSA-g3hv-75wg-m249) — closed

- **Status:** Closed on 2026-11-06 after rechecking the publisher's current affected range and both npm audits.
- **Current advisory:** GitHub lists affected versions as `>=7.0.0, <11.0.1` and patched `11.0.1`. The
  installed `minimatch@3.1.5` copies are outside the affected range; `minimatch@11.0.3` is patched.
  The initial 2026-11-02 assessment incorrectly read the upper bound as applying to every earlier major.
- **Dependency tree:** `minimatch@3.1.5` is reached through the ESLint development toolchain. It is not
  affected by this advisory. Both `npm audit --omit=dev` and full `npm audit` reported zero vulnerabilities
  on 2026-11-06.
- **Exposure:** a ReDoS needs attacker-controlled glob patterns. ESLint reads only repository-controlled
  patterns during lint, and no request path, worker or user input reaches it.
- **Historical assessment from 2026-11-02 (superseded by the updated affected range):**
  - npm's suggested fixes are semver-major downgrades (`eslint@4.0.0`, `eslint-plugin-jsx-a11y@6.4.1`), not upgrades.
  - Forcing `minimatch` to 11 across the tree would change the API ESLint 9 calls.
  - `eslint@latest` (10.x) depends on `minimatch ^10.2.6`, which is patched, but `eslint-plugin-jsx-a11y@latest`
    still depends on `minimatch ^3.1.2`, so the plugin is the blocker.
  - No patched 3.x release exists.
- **Historical remediation triggers (no longer required for this advisory):**
  1. `eslint-plugin-jsx-a11y` or `eslint-plugin-import` releases a version without minimatch 3, and
     `eslint-config-next` accepts it.
  2. The repository moves to ESLint 10 with compatible plugins.
  3. The advisory is reclassified, or a higher-severity advisory affects this chain.
- **Review criteria:** keep both npm audits active. Reopen this record if the published affected range changes to include an installed version.
- **Expiry:** closed; reopen only if the affected range changes or a future audit reports an affected version.
- **Authority:** owner decision for Stage 01, permitting a narrow exception only after the checks above were verified (2026-11-02).
