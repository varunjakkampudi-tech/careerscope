# CareerScope Project Context

This is a navigation map, not a substitute for reading the code being changed.
Read the owning module and its neighboring tests, not the entire repository.

## Architecture

- This module map describes preserved V1. V2 is a separate incomplete migration;
  consult [V2 architecture](../v2/ARCHITECTURE.md) and [V2 status](../v2/README.md).
- V2's private S3 adapter is tested but not enabled. MinIO upstream is archived;
  runtime selection, resume workflows and full migration acceptance remain open.

- npm-workspaces TypeScript monorepo; Node 24+; React/Vite frontend and Fastify API.
- The Mac-local API owns SQLite, resumes, profile, matching, job collection and applications.
- GitHub Pages hosts a separate public jobs export and encrypted read-only admin snapshot.
  It has no live connection to the API and cannot run browser automation.
- Shared Zod schemas define API data. `container.ts` wires repositories and services.
- Search flow: routes/MCP -> queue -> providers -> normalize/dedupe -> matching ->
  enrichment -> repositories. SSE reports durable search events.
- Application automation is opt-in and local. Shared-browser requests are handoffs
  to VS Code Copilot chat, not background worker runs. Account creation and final
  submission require approval; an observed confirmation is required before Applied.

## Module Map

| Path                                  | Responsibility                                                  |
| ------------------------------------- | --------------------------------------------------------------- |
| `apps/api/src/app.ts`, `container.ts` | HTTP app and dependency wiring                                  |
| `apps/api/src/routes/`                | Validated HTTP boundaries                                       |
| `apps/api/src/services/`              | Search, scheduling, applications and browser controls           |
| `apps/api/src/db/repo/`               | Persistence; schema and migrations live in the parent directory |
| `apps/api/src/mcp/`                   | MCP adapters for local job operations                           |
| `apps/web/src/routes/`                | Search, leads, profile, settings and applications views         |
| `apps/web/src/components/`            | UI primitives, lead details and application panel               |
| `apps/web/src/lib/`                   | API access, query hooks and shared-browser request generation   |
| `packages/shared/src/`                | Schemas, shared types and normalization helpers                 |
| `packages/providers/src/`             | ATS, feeds, keyed APIs, browser sources and optional Gmail      |
| `packages/matching/src/`              | Scoring and demand extraction; keep deterministic scoring pure  |
| `packages/resume/src/`                | PDF/DOCX extraction and profile derivation                      |
| `mobile-site/`, `scripts/`            | Static snapshots, encryption, publication and browser checks    |
| `infra/`, `.github/workflows/`        | Optional hosting assets and CI/Pages deployment                 |

## Working Rules

- Preserve unrelated uncommitted changes. Do not deploy or submit jobs without authorization.
- Keep private data, credentials, browser sessions and generated context exports local.
- Never put passwords or OTPs in chat, application notes or exported context.
- Prefer a neighboring test first; do not start real searches or applications as tests.
- Inspect actual source for details omitted by Repomix compression.

## Commands

- Development: `npm run dev` (web and API).
- Focused test: `npx vitest run path/to/file.test.ts`.
- Gates: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`.
- Pages checks: `npm run pages:test`; publish only with explicit authorization.
- Context export: `npx repomix --config repomix.config.json`.
  The default contains this map, selected entry points, manifests and a filtered tree.
  It is not a full source export. The 12,000-token budget is a ceiling, not a target.
  Repomix can write the output before reporting a budget failure; inspect its summary.
- Use the extension's root **Repomix Run** for this configuration. Selection/bundle
  overrides can widen scope; inspect exclusions and output before sharing.

## Detail References

- [Architecture and invariants](ARCHITECTURE.md)
- [Application workflows and limits](APPLICATIONS.md)
- [Local operations](RUNBOOK.md)
- [Public/private snapshot boundary](ENCRYPTED-ADMIN.md)

Do not attach this map or its generated export to every turn. Use it for orientation,
then supply only the files relevant to the current task.
