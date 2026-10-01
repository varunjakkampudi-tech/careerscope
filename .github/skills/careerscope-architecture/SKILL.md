---
name: careerscope-architecture
description: 'Ownership boundaries and the non-negotiable architectural constraints of the CareerScope repository. Use before adding a module, introducing a dependency, or changing how a tier talks to another.'
---

# CareerScope Architecture

## Purpose

CareerScope is a modular monolith, not a microservice system. Most damage done to
it comes from engineers who assume otherwise and split something that was
deliberately kept together, or who wire a tier directly to a store it does not
own. This skill exists to make the boundaries explicit before code moves.

## When to use

- Adding a package, service or worker
- Moving code between application or package boundaries
- Introducing a runtime dependency
- Changing how the web tier reaches the API, or the API reaches storage
- Any change that touches `container.ts`, `app.ts`, compose files or `tsconfig` references

## One canonical workspace

The root `careerscope` workspace is the only active application architecture:

| Area        | Canonical implementation                      |
| ----------- | --------------------------------------------- |
| Store       | PostgreSQL 17 + Drizzle                       |
| API         | Fastify                                       |
| UI          | React 19 + Next.js App Router                 |
| Async work  | Transactional outbox, SQS and focused workers |
| Test runner | Node's built-in test runner plus Vitest       |
| Deployment  | Hostinger VPS at `https://careerscope.tech`   |

GitHub Pages and the mobile export are separate static artifacts generated
from the same root packages. They do not introduce a second product runtime.
Keep their contracts explicit and do not add duplicate domain implementations.

## Request path in the deployed stack

```mermaid
flowchart LR
  U[Browser] -->|443| C[Caddy]
  C -->|127.0.0.1:5280| W[Next.js]
  W -->|rewrite /api/*| A[Fastify API :5390]
  A --> P[(PostgreSQL)]
  A --> R[(Redis: rate limits)]
  A --> F[/Encrypted private filesystem/]
  A -->|outbox row| P
  PUB[Publisher] -->|reads outbox| P
  PUB --> Q[[SQS-compatible queue]]
  Q --> S[search worker]
  Q --> FW[files worker]
  S --> P
  FW --> P
```

Only the proxy publishes ports. Every other service joins the proxy network
namespace and binds loopback. The browser never talks to the API directly; it
uses a same-origin `/api` path that Next.js rewrites. This is why
`apps/web/src/lib/api.ts` uses relative URLs and `credentials: 'same-origin'`.

## Constraints that must not be broken

- **The API is the only writer to resume object storage.** Workers mount it
  read-only. There is no cross-process reservation; the single-writer contract is
  what makes the capacity accounting sound.
- **PostgreSQL is the source of truth.** The queue is a delivery hint. Never move
  authoritative state into Redis or the queue.
- **AI inference is off.** It must not gain authority over deterministic matching
  and must never receive private candidate data or application-submission rights.
- **Auto-apply is on hold.** Nothing may submit an application without explicit
  per-step human approval.
- **Infrastructure endpoints stay loopback.** `configuration()` in
  `packages/core/src/runtime.ts` enforces this for the database, Redis and the
  queue. `APP_ORIGIN` is the single exception and must be HTTPS when it is not
  loopback.

## Forbidden shortcuts

- Adding a second writer to `/private/objects`
- Giving a worker a direct HTTP route instead of a queued command
- Bypassing the outbox by publishing to the queue inside a request handler
- Reaching into another workspace's `dist/` instead of its package entry point
- Adding a dependency that duplicates something already in `packages/shared`

## Verification

Architecture changes must survive both workspaces:

```sh
npm run typecheck && npm run lint && npm test && npm run build
npm run typecheck && npm test && npm run build
```

## Related documentation

`ARCHITECTURE.md`, `README.md`, `docs/ARCHITECTURE.md`,
`.github/copilot-instructions.md`.
