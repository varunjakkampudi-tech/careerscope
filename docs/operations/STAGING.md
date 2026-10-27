# Staging deployment status and prerequisites

## Current status

Staging deployment is **BLOCKED**. There is no verified independent staging
host, isolated database/Redis, GitHub `staging` environment, credential set,
deployment artifact pipeline, post-deployment health suite, or staging rollback
evidence. No staging or production deployment workflow exists. The CI workflow
uses only ephemeral test services and cannot deploy. Production is deployed only
by the manual operator procedure in [DEPLOYMENT.md](DEPLOYMENT.md#normal-deployment);
there is no automated path to either environment.

Do not use the production Hostinger VPS, production database/Redis, production
data, or production credentials as staging. Do not create a deploy workflow
until the owner provides an isolated target and approves its branch/environment
restrictions.

## Owner prerequisites

Before staging automation can be designed or enabled, the owner must provide and
approve:

- A separately hosted staging system, network boundary, hostname, TLS and
  non-production service credentials.
- A staging-only PostgreSQL/Redis instance and synthetic test dataset.
- GitHub environment `staging`, restricted to `dev`, with only staging
  secrets and required approval controls.
- A documented immutable artifact and provenance procedure, migration strategy,
  bounded health/smoke checks, monitoring and tested staging recovery path.
- Actions budget appropriate for the required integration, all-browser, and
  manual recovery suites.

Track required owner actions in the issue tracker. Never store secret values or
host-only configuration in source control.

## Future safe validation sequence

Once prerequisites are approved, implement and independently review a
manual-only deployment workflow restricted to the designated development
branch and `staging` environment. It must verify the exact triggering SHA and
artifact digest, run pre-deployment checks, apply migrations only to staging,
wait for bounded health/readiness, run smoke/sanity/critical user journeys,
verify DB/Redis/workers/queues, preserve sanitized logs, and stop on any failed
gate. Test rollback only against staging data with the documented recovery
procedure. Production remains outside the workflow and owner-controlled.

Until those conditions and exact hosted runs are proven, do not claim staging
deployment readiness. Current container recovery material is in
[`ROLLBACK.md`](./ROLLBACK.md) and
[`./BACKUP.md`](./BACKUP.md); neither substitutes
for staging validation.
