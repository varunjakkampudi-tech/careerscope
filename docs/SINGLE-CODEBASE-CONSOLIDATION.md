# Single-Codebase Consolidation (historical record)

Status: **complete on `main`** (reconciled 2026-10-01).

This file records the repository migration for auditability. It is not an
active architecture contract; [PROJECT-STATE](PROJECT-STATE.md) and
[ARCHITECTURE](ARCHITECTURE.md) are authoritative for the current product.

## Result

CareerScope now has one root npm workspace. The production implementation is
the root `apps/`, `packages/`, `migrations/`, `infra/` and `scripts/` tree:

- Next.js App Router and React web application
- Fastify API with PostgreSQL/Drizzle
- transactional outbox, publisher and workers
- deterministic matching and encrypted private resume storage
- root-level CI, deployment and release gates

No active build, runtime, deployment or agent workflow requires a second
application workspace. The root package names are the canonical
`@careerscope/*` packages and the database contract is PostgreSQL.

## Verification recorded at completion

- Root install/build/typecheck/lint/format commands are the supported developer
  entry points.
- Unit, domain, Pages, engineering-gate and ticket-consistency suites pass.
- Hosted CI run [#198](https://github.com/varunjakkampudi-tech/careerscope/actions/runs/36835371976)
  passed the exact consolidation commit, including service-backed, browser and
  recovery jobs. The container-image job was skipped by workflow policy.
- Historical audit files retain their original wording where needed to explain
  prior decisions; they are not current implementation instructions.

## Remaining historical references

Older release reviews, ticket evidence and append-only `.ai` event logs may
mention former directory names. They are retained as evidence and are not
active source, package, deployment or agent configuration. New documentation
must use the root workspace and current contracts only.
