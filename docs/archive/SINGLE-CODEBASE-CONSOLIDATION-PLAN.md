# Single-Codebase Consolidation

Status: execution in progress (2026-10-01)

This record is the dependency map and migration contract for replacing the
repository's historical root/V2 split with one canonical CareerScope workspace.
It is intentionally evidence-based; historical references remain in release
records until the consolidation is complete.

## Baseline dependency map

The repository currently contains two executable workspaces:

- The root workspace is the former Vite/SQLite application. Its active package
  identities are `@job-radar/*`, and its root `apps/`, `packages/`, `infra/`,
  and tests are still used by root CI and Pages tooling.
- `v2/` is the deployed Next.js/Fastify/PostgreSQL application. Its API and
  workers import the root `@job-radar/shared`, `@job-radar/matching`,
  `@job-radar/providers`, and `@job-radar/resume` packages through file
  dependencies. This is the most important cross-version dependency and must
  be migrated before the old tree can be removed.

Additional dependencies found by repository-wide inspection:

| Area                   | Current dependency                              | Consolidation action                                                                  |
| ---------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------- |
| V2 core                | root `packages/shared`, `resume`                | move to canonical `packages/`; rename to `@careerscope/*`; update imports             |
| Search worker          | root `packages/matching`, `providers`, `shared` | move to canonical `packages/`; update file references and project references          |
| V2 scripts             | `v2/scripts/*`                                  | merge into root `scripts/`, preserving existing Pages/engineering scripts             |
| V2 migrations          | `v2/migrations`                                 | promote to root `migrations/` and update runtime paths                                |
| V2 infrastructure      | `v2/compose.yml`, `v2/infra/*`                  | promote/merge into canonical `infra/` without changing topology                       |
| CI                     | explicit `v2/` paths and V1/V2 job names        | rewrite after root promotion, then run reachability checks                            |
| deployment             | explicit `v2/` checkout/build paths             | rewrite after root promotion and validate exact-ref deploy gate                       |
| Pages/mobile           | root `mobile-site/` and root export tooling     | retain as a separate static artifact, not as a second application stack               |
| documentation/AI state | current V1/V2 terminology and paths             | rewrite active docs/state after source paths are stable; preserve historical evidence |

## Safe execution order

1. Baseline commit and dependency inventory (complete).
2. Promote V2 applications, core, scripts, migrations, and runtime config to
   canonical root locations while preserving the old files temporarily.
3. Rename active package identities and repair imports/project references.
4. Run root install, typecheck, lint, unit/build and service-backed checks.
5. Migrate CI, deployment, Docker/Compose, and operational scripts.
6. Port or retain only tests that exercise the canonical implementation.
7. Prove Pages/mobile capabilities remain independent static artifacts.
8. Remove the obsolete Vite/SQLite application and the `v2/` wrapper only
   after clean-checkout parity and exact-revision validation.
9. Rewrite active documentation, agent instructions, and `.ai` state; classify
   remaining historical references explicitly.

No source is deleted by the inventory step. A deletion is allowed only after a
canonical replacement, import search, test coverage, and clean-install check
prove the old implementation is unused.
