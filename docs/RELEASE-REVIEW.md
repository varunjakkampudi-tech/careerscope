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
