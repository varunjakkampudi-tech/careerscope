# CareerScope

CareerScope is a candidate-controlled job discovery and application-tracking
product. It combines deterministic resume and job matching with
provenance-aware provider adapters, saved jobs and an explicit application
lifecycle. The candidate stays in control of every lifecycle transition, and
unknown provider data is shown as unknown rather than guessed.

## Stack

- Next.js 16, React 19, TypeScript, App Router and TanStack Query
- Fastify 5, PostgreSQL with Drizzle, Redis
- Transactional outbox with publisher, search and file workers
- Encrypted private resume storage, Caddy and Docker
- Passwordless test-account selection with opaque server sessions; hosted
  tests require a private password-protected proxy

## Quick start

Requires Node 24 or newer, Docker and npm.

```sh
npm ci
npm run setup:local   # creates a private, ignored .env; never overwrites one
npm run services      # local PostgreSQL and Redis
npm run db:migrate
npm run build
npm start             # API, publisher, worker, files worker and web
```

The web app is served on http://localhost:5280 and the API on port 5390.
Configure optional provider values only in an approved environment, and never
commit `.env` or credentials.

## Scripts

| Script                                                                        | Purpose                                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------- |
| `npm run build` / `build:core`                                                | Full build / TypeScript project build only              |
| `npm start`                                                                   | Run all processes; `start:api`, `start:web` etc. singly |
| `npm run format:check` / `format`                                             | Prettier check / write                                  |
| `npm run lint`, `npm run typecheck`                                           | ESLint and TypeScript checks                            |
| `npm test`, `npm run test:domain`                                             | Unit tests                                              |
| `npm run test:integration`                                                    | Service-backed integration tests                        |
| `npm run test:ui`, `test:visual`                                              | Browser and visual checks against a local build         |
| `npm run test:queue-runtime`, `test:database-recovery`, `test:crash-recovery` | Recovery checks                                         |
| `npm run test:performance`, `test:soak`, `test:full-disk`                     | Load and resilience checks                              |
| `npm run privacy:check`, `security:check`                                     | Privacy scan and dependency audit                       |
| `npm run check`                                                               | Full local gate (below); run before every push          |
| `npm run gates:test`                                                          | Node/deploy policy tests plus `check`; what CI runs     |
| `npm run db:generate`, `db:migrate`                                           | Generate and apply Drizzle migrations                   |
| `npm run services`, `services:queue`                                          | Start local Docker dependencies                         |

`npm run check` runs, in order: `eol:check`, `privacy:check`, `format:check`,
`lint`, `typecheck`, `test:unit`. It deliberately excludes `test:integration`
(PostgreSQL and Redis; start them with `npm run services` and a sanitized
`.env`) and the browser suites; CI runs those in the `services` job.

`eol:check` inspects tracked files, so it cannot pass in a repository with no
commits or nothing staged. Git hooks (husky) are installed by `npm install`:
pre-commit runs lint-staged (Prettier and ESLint on staged files) and commit-msg
enforces Conventional Commits through commitlint.

Service-backed and browser checks need the local services and browser
dependencies. Report them as not executed when those are unavailable.

## Layout

| Path           | Contents                                                      |
| -------------- | ------------------------------------------------------------- |
| `apps/api`     | Fastify HTTP API                                              |
| `apps/web`     | Next.js web client                                            |
| `apps/workers` | Publisher, search and file workers                            |
| `packages/*`   | Shared domain code: core, shared, providers, matching, resume |
| `migrations/`  | Drizzle SQL migrations                                        |
| `scripts/`     | Build, check and test tooling                                 |
| `infra/`       | Docker, Caddy and host deployment scripts                     |
| `docs/`        | Product, architecture, security and operations documentation  |

## Documentation

Start at [docs/README.md](docs/README.md). See also
[ARCHITECTURE](docs/ARCHITECTURE.md), [API-SURFACE](docs/API-SURFACE.md) and
[SECURITY](docs/SECURITY.md). Contributor and agent conventions are in
[AGENTS.md](AGENTS.md).

## Deployment

Deployment is manual and guarded; see
[docs/operations/DEPLOYMENT.md](docs/operations/DEPLOYMENT.md).
