---
description: 'Use when changing database schema, migrations, SQL, repositories, query performance or transactional data invariants in CareerScope.'
applyTo: 'apps/api/src/db/**,packages/core/src/**,migrations/**,drizzle.config.*'
---

# Database Engineering

- Establish the stack first: CareerScope uses PostgreSQL/Drizzle under
  `packages/core/src` and the canonical API repositories. Do not introduce
  SQLite runtime assumptions into production code.
- Backend owns database implementation. Consult the existing Drizzle and
  Postgres skills for CareerScope, and the architecture, outbox and security skills when
  their invariants apply. QA independently executes checks; no extra DB agent
  or server is required. See [role mapping](../../docs/ai/agent-matrix.md).
- Read the schema, affected query, callers and nearest tests before editing.
  Preserve owner scoping, uniqueness, revision checks, idempotency, transaction
  boundaries, fenced executions, leases and atomic outbox publication.
- Parameterize values; validate identifiers and inputs. Do not infer owner
  authorization from a caller-supplied ID. Keep private data and credentials
  out of logs, fixtures and reports. Never read real environment files.
- Use append-only migrations and review generated SQL. Serialize schema,
  migration metadata, manifests and lockfile writers. Do not rewrite applied
  history or issue destructive DDL against owner data. Describe recovery and
  compatibility before proposing a risky migration; production execution needs
  separate explicit authorization.
- Bound result sets and time/resource use. Add indexes from measured query
  patterns, with isolated query-plan evidence where relevant, not speculation.
  Preserve stable pagination and cross-owner denial.
- Verify on isolated synthetic data: accepted, violating and malformed inputs,
  concurrent updates, rollback/partial failure and migration/recovery behavior
  as applicable. A mocked query or typecheck alone does not prove database
  semantics. Missing services mean BLOCKED, not an install or a fake pass.

Report exact changed files, commands/results, data risks and unverified cases
under the [evidence contract](../../docs/ai/quality-gates.md).
