# CareerScope contributor and agent guide

CareerScope is a candidate-controlled job discovery and application-tracking
product (Next.js web, Fastify API, background workers, PostgreSQL, Redis).
This file is the entry point for human contributors and coding agents.

## Commands

Use Node 24 or newer.

- `npm ci` - install dependencies
- `npm run setup:local` - create a private local `.env` (never overwrites)
- `npm run services` - start local PostgreSQL and Redis
- `npm run db:migrate` - apply migrations
- `npm run build` - build packages, API, workers and web
- `npm start` - run API, publisher, worker, files worker and web
- `npm run format:check`, `npm run lint`, `npm run typecheck` - static checks
- `npm test`, `npm run test:domain`, `npm run test:integration` - tests
- `npm run gates:test` - the aggregate gate CI runs

## Branches

- `main` is production. Do not commit or push to it directly.
- `dev` is the integration branch. Branch from `dev`, open a pull request
  back into `dev`, and promote `dev` to `main` through a reviewed release.

## Layout

- `apps/api` - Fastify HTTP API
- `apps/web` - Next.js web client (brand assets in `public/brand`)
- `apps/workers/search` - publisher, search and file workers
- `packages/*` - shared domain code (core, shared, providers, matching, resume)
- `migrations/` - Drizzle SQL migrations; do not edit applied files
- `scripts/` - build, check and test tooling
- `infra/` - Docker, Caddy and host deployment scripts
- `docs/` - product, architecture, security and operations documentation

## Documentation

Start at [docs/README.md](docs/README.md). Key pages: [ARCHITECTURE](docs/ARCHITECTURE.md),
[API-SURFACE](docs/API-SURFACE.md), [DATA-MODEL](docs/DATA-MODEL.md),
[SECURITY](docs/SECURITY.md) and [DEPLOYMENT](docs/operations/DEPLOYMENT.md).

## Rules

- Never commit `.env`, secrets or personal data.
- Do not deploy, change repository settings or call paid providers without
  explicit owner approval.
- Add or update tests with behavior changes, and keep docs in step with code.
