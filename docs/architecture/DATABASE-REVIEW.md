# PostgreSQL and Drizzle architecture review

Review date: 2026-11-06
Scope: owner roadmap Stage 01 item 1.04, "Review PostgreSQL/Drizzle architecture"
Repository baseline: `dev` merge `3aabf663ed92100641df00608154a489c667bc82`

## Result

The current PostgreSQL and Drizzle architecture is coherent for the reviewed application scope. The typed schema, migration journal, snapshots, and SQL migration files are checked together. No structural schema change is indicated by this review. The review found and corrected stale migration-history text in `docs/DATA-MODEL.md`, the migration-test checklist reference, and the stale owner-checklist disposition for approved item 1.01.

## Verified design

- PostgreSQL is the system of record. `packages/core/src/schema.ts` declares the Drizzle tables and database constraints; `drizzle.config.ts` points Drizzle at that schema and the committed migration directory.
- The active journal contains `0000_initial_schema.sql` through `0003_support_cases.sql`. The baseline contains the current initial product schema; later migrations add recovery email/OTP intents, admin/TOTP fields, and support cases. Historical `0020`–`0026` filenames are not present in the active journal.
- The schema uses primary and unique keys, foreign keys, check constraints, and query indexes. Owner-bearing child relationships use composite `(owner_id, id)` foreign keys where needed, so records cannot point to another owner's parent row even if application validation is bypassed.
- `tests/integration/migrations.integration.test.ts` uses a random UUID-derived database name, requires a loopback PostgreSQL URL, and creates the test database from `template0`. It applies journal entries in order and compares the resulting tables, columns, types, nullability, indexes, foreign keys, and check constraints with Drizzle. It also verifies repeatable `migrate()`, snapshot/journal consistency, schema diff generation, and preservation of a seeded row through later migrations. Cleanup drops the isolated database in `finally`.
- `npm run migrations:check` passed in the pinned Node 24 Docker environment. GitHub Actions run [42234042673](https://github.com/varunjakkampudi-tech/careerscope/actions/runs/42234042673), on the same source tree as the `dev` baseline, passed `drizzle-kit check`, fresh database migration, and the PostgreSQL/Redis integration suite.

## Follow-up boundaries

The integration test proves migration/schema consistency and selected persistence behavior; it is not a substitute for reviewing every application query for tenant scoping or measuring production query plans at scale. The accepted low-severity risk S1-F014 remains: `users.email` is unique but has no database check requiring lowercase storage; reviewed write paths normalize it, and a future constraint needs a migration after checking existing rows. The data-model document also identifies the pending-email plaintext value and the unverified cleanup timer/legal-retention policy. Those concerns remain visible for their owning security/privacy work. This review did not touch live databases, production deployment, Hostinger, or backups; deployment and backups are outside the owner's current scope.

## Disposition

Checklist item 1.04 is verified for the documented architecture and automated migration-integrity scope. Keep applied migration files immutable. Generate a new migration for future schema changes, then run `npm run migrations:check` and the isolated PostgreSQL integration tests.
