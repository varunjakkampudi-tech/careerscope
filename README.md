# CareerScope

![CI](https://github.com/varunjakkampudi-tech/careerscope/actions/workflows/ci.yml/badge.svg?branch=main)
![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-339933?logo=node.js&logoColor=white)

**DISCOVER · MATCH · TRACK · GROW**

CareerScope is a private job-search workspace. It collects postings from
public sources, scores them deterministically against the owner's profile,
keeps useful leads, and tracks applications. The user remains in control:
CareerScope never submits job applications automatically.

This repository is the canonical CareerScope product workspace. It is an
engineering/production codebase; live deployment and external acceptance are
reported separately in [docs/PROJECT-STATE.md](docs/PROJECT-STATE.md).

## Architecture

```text
apps/web                 Next.js App Router UI
apps/api                 Fastify HTTP API
apps/workers              publisher, search and resume workers
packages/core             PostgreSQL-backed domain, auth and storage services
packages/shared           validated shared contracts
packages/providers        job-source adapters
packages/matching         deterministic match scoring
packages/resume           bounded resume extraction and derivation
migrations                append-only PostgreSQL/Drizzle migrations
infra                     Compose, Caddy and Hostinger operations
scripts                   development, export and verification tooling
docs                      authoritative product and operations documentation
.ai                       ticket and engineering projections
```

The runtime is a modular monolith: Next.js and Fastify sit behind Caddy;
PostgreSQL is authoritative; Redis provides rate limiting; the transactional
outbox feeds the publisher and workers; resume files are encrypted at rest.
Only the proxy publishes host ports.

See the [architecture index](docs/architecture/README.md) for current system,
request, discovery, outbox, resume, authentication, lifecycle, deployment and
trust-boundary diagrams.

## Requirements

- Node.js 24 or newer
- npm (the repository uses npm workspaces)
- Docker Compose for PostgreSQL, Redis and LocalStack-backed local services

## Local development

Run all commands from the repository root:

```bash
npm ci
npm run setup:local       # creates a private .env; never overwrites one
npm run services          # starts disposable local dependencies
npm run db:migrate
npm run build
npm run start             # API, workers and web
```

Review `.env.example` and [docs/PROJECT-STATE.md](docs/PROJECT-STATE.md)
before enabling optional providers or Cognito. Never commit `.env`, personal
data, resume files, database volumes or credentials.

## Verification commands

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:domain
npm run pages:test
npm run build
```

Service-backed, browser, recovery, accessibility, performance and deployment
checks are listed with their prerequisites in [docs/TESTING.md](docs/TESTING.md).
Hosted CI is the authoritative evidence for checks that require Linux
containers or the production-like services unavailable on every workstation.

## Deployment and operations

Production deployment is manual and main-only. The Deploy workflow accepts no
branch, tag, or SHA input: it verifies and ships the current `main` HEAD only.
A push or pull-request merge to `main` starts CI but does not deploy. Follow
[docs/OPERATIONS/DEPLOYMENT.md](docs/OPERATIONS/DEPLOYMENT.md), use the
provenance and rollback checks, and restart the complete stack rather than the
proxy alone. Firewall, secrets, backup and restore procedures are documented
under [docs/OPERATIONS](docs/OPERATIONS/).

## Scope and limitations

AI inference and auto-apply are off/deferred. Cognito passwordless sign-in is
implemented but requires hosted configuration and provider verification before
deployment. Off-host disaster recovery is an owner-deferred decision; local
backups are not protection from host loss. The remaining human and external
acceptance items are listed in [docs/KNOWN-LIMITATIONS.md](docs/KNOWN-LIMITATIONS.md).

## Documentation map

- [Project state](docs/PROJECT-STATE.md) — current product and deployment truth
- [Architecture](docs/ARCHITECTURE.md) — runtime boundaries and invariants
- [Architecture diagrams](docs/architecture/README.md) — implementation flow maps
- [API surface](docs/API-SURFACE.md) — authenticated endpoint contract
- [Product surface](docs/PRODUCT-SURFACE.md) — supported user journeys
- [Security](docs/SECURITY.md) — security controls and findings
- [Privacy](docs/PRIVACY.md) — data boundaries and agent/Copilot handling
- [Testing](docs/TESTING.md) — evidence commands and acceptance boundaries
- [Operations](docs/OPERATIONS/DEPLOYMENT.md) — deploy, rollback and live checks
- [Known limitations](docs/KNOWN-LIMITATIONS.md) — explicit remaining work
- [Documentation index](docs/README.md) — detailed documentation hierarchy
- [Design source of truth](design/README.md) — visual references and approval status

The optional [START-HERE](START-HERE/README.md) guide provides an extended
operator/session orientation. It supplements this README; it is not a second
product architecture or deployment source of truth. Historical release reviews
and append-only engineering logs remain available under `docs/archive/`,
`docs/` and `.ai/`; they are evidence, not alternate product instructions.
