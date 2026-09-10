# Repository And Release Review

Review date: 2026-09-10. Release scope: reviewed local changes and GitHub Pages
only. The owner explicitly deferred Docker and EC2 execution because no container
runtime is installed. No successful real application submission is claimed.

## Scope And Structure

The inventory covered all 322 previously tracked paths plus pending additions.
Automated type, lint, formatting and test checks cover the configured repository
surfaces. Manual review focused on changed code and high-risk boundaries: the
publisher, snapshots, API authentication, application approvals, browser controls,
Gmail verification, CI and deployment. This is not an exhaustive line-by-line
security audit of every unchanged file, dependency or captured third-party fixture.

Retain the existing npm-workspaces structure:

| Area                 | Ownership                                                       |
| -------------------- | --------------------------------------------------------------- |
| `apps/api`           | HTTP and MCP boundaries, injected services, SQLite repositories |
| `apps/web`           | Authenticated React workspace and server-hosted public view     |
| `packages/shared`    | Shared schemas, types and format helpers                        |
| `packages/matching`  | Deterministic scoring and separate optional reranking           |
| `packages/providers` | External data adapters and transport behavior                   |
| `packages/resume`    | Resume extraction and profile derivation                        |
| `mobile-site`        | Separate static Pages site and encrypted admin                  |
| `scripts`            | Export, publication and browser acceptance tools                |
| `infra`              | Deployment assets and runtime startup tests                     |
| `docs`, `seed`       | Documentation and versioned seed inputs                         |

Tests remain beside their owning modules. Generated declarations, builds,
databases, resumes, browser profiles and Repomix output remain excluded from Git.
There is no demonstrated benefit to moving working packages or splitting services
into independently deployed systems for this single-owner application.

## Findings Addressed

- MCP `list_leads` discarded singular source/status filters when passing them
  to a schema expecting plural names. Explicit mapping and a protocol-level
  regression test now cover both filters and defaults.
- The lead drawer lacked a visible application entry point beside Open posting.
  Apply with Copilot now focuses the guarded application options; it does not
  itself authorize a submission.
- Publication allowed uncommitted non-version source files. It now requires a
  clean worktree, including untracked files, before generating release artifacts.
- `mobile-export/` was an unused legacy copy. Removed it and stale lint/format
  exclusions. `mobile-site/` remains the sole static-site source.
- The public exporter copied four static source files onto themselves. Removed
  that redundant step; URL sanitization and explicit snapshot field lists remain.
- CI did not exercise the available browser acceptance scripts or new runtime
  startup tests. They are now release gates with explicit browser installation.
- EC2 could be triggered by successful main-branch CI. It is now manual-only and
  requires an explicit enable flag, preventing an unintended cloud deployment.
- Architecture and hosting documentation overstated browser ownership, scoring
  purity and deployment verification. Updated those claims and the folder map.

## Verification Matrix

Run on the final release revision:

| Command                                          | Coverage                                                                  |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| `npm run format:check`                           | Source/config formatting, excluding generated/captured data               |
| `npm run typecheck`                              | Workspace projects plus test and fixture types                            |
| `npm run lint`                                   | JavaScript/TypeScript, React hooks and accessibility rules                |
| `npm test`                                       | Domain, provider, resume, API, persistence, UI and worker regressions     |
| `npm run pages:test`                             | Snapshot allowlists, encryption, release and browser-state logic          |
| `node --test infra/application-runtime.test.mjs` | Startup password/display guards                                           |
| `npm run build`                                  | All packages, API and production React bundle                             |
| `node --import tsx scripts/check-ui.mjs`         | Built API/UI, login and responsive routes in three engines                |
| `npm run pages:workspace:test`                   | Public filters, saved jobs, refresh and storage failures in three engines |
| `node scripts/check-admin-ui.mjs`                | Synthetic encrypted-admin unlock, lock, safe DOM and responsive UI        |

Live Pages acceptance additionally requires successful CI/deployment, matching
release assets and the expected version at both public and admin URLs. Production
credentials are never test fixtures. Do not mistake mocked provider tests or a
green health endpoint for evidence that an external portal will accept applications.

## Deployed Release Evidence

CareerScope v1.3.1 is deployed from commit `0904377`; CI run `34470638235`
succeeded, including Pages deployment. All 26 live assets matched the local
release byte-for-byte. The public snapshot contains 2,183 jobs and the encrypted
admin contains 2,510 leads; its passphrase is unchanged. Live public save/filter/
reload and admin unlock/reload/lock passed at 320, 390 and 1440 pixels without
horizontal overflow or JavaScript errors.

The v1.3.0 Linux Firefox/WebKit header overlap was fixed with responsive brand
typography. The first v1.3.1 CI attempt exposed interrupted shortlist requests in
WebKit during test navigation. Waiting for network idle before reload and before
leaving the reloaded shortlist resolved it; local three-engine checks and remote
CI passed without suppressing errors or weakening application security.

## Local Follow-Up Evidence

These follow-ups are separate from the deployed v1.3.1 artifact:

- Corrected obsolete browser comments in CI; parsed YAML is identical to the
  committed workflow, so no execution behavior changed.
- Allowed intentional console.log output only in migration and seed CLI files.
  Repository lint now has no warnings; service console restrictions remain.
  Disposable-data CLI checks passed for migration/repeat, seed/skip/force and
  missing-file error exit/stderr. No owner database was used for these checks.
- Production dependency audit reports two moderate entries and no high/critical
  findings: ExcelJS 4.4.0 depends on uuid 8.3.2, affected by
  [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq).
  Installed ExcelJS source uses UUID v4, not the advisory's v3/v5/v6 buffer APIs.
  This limits the identified exposure but does not clear the advisory. No major
  downgrade/override was applied; synthetic XLSX round-trip and CSV checks passed.
- Reviewed available Node 24 Action releases, including the nested uploader.
  Upgrade remains separate, pending runner compatibility and remote acceptance.
- Thirteen focused MCP/scheduler tests passed. After reopening the renamed workspace,
  the attached MCP process now reports 247 LinkedIn/New matches and returns only
  matching leads; LinkedIn/Saved returns zero. The prior stale-process failure cleared.
- Authenticated scheduler diagnostics now return 200: daily 07:00 Asia/Kolkata and
  a persisted queued attempt on 2026-09-10 at 02:10:53 UTC. This verifies scheduling
  diagnostics, not provider success or a future run. No schedule was changed.
- Recurring session-fetch errors coincided with separately launched API/frontend
  processes stopping. Root `npm run dev` now starts both with sibling shutdown when
  either command exits. Synthetic lifecycle checks passed for zero/nonzero child
  exits. This does not provide automatic restarts or survive closing the terminal.
- The follow-up rerun passed all 998 tests, 21 Pages checks, three infrastructure
  checks, typecheck, build, clean lint, formatting and three-engine browser acceptance.

## Deferred Risks

The local release run on 2026-09-10 passed 998 Vitest tests, 21 Pages tests,
three infrastructure tests, typecheck, formatting and the production build.
Lint had no errors and three existing console warnings in migration/seed scripts.
Built-app and public-workspace checks passed in Chromium, Firefox and WebKit;
the synthetic encrypted-admin browser checks also passed. These results do not
clear the infrastructure and real-application gates below.

- Docker images, persistent Copilot sign-in, VNC access, restart/restore behavior,
  TLS and EC2 capacity need actual infrastructure acceptance testing.
- The dormant EC2 deploy script still resets to the latest remote main and checks
  HTTP health. Before enabling it, pin the exact validated revision, support the
  chosen application Compose override, and test the TLS/proxy readiness path.
- Remote-browser egress isolation, browser sandbox behavior on the target kernel
  and VNC/CLI process failure recovery require container-level verification.
- Real job applications require portal availability, truthful qualifications,
  any required account/terms approvals and a confirmed result. The previous
  Indeed application form did not open, including on a manual click.
- Shared VS Code browser handoffs are not automatically tracked worker runs and
  do not migrate to EC2. The remote worker requires its own authenticated sessions.

Do not enable EC2 deployment or describe unattended applications as universally
working until these gates are satisfied. Keep final-submission approval enabled.
