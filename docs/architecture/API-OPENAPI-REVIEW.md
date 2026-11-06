# API and OpenAPI contract review

Owner roadmap: Stage 01, checklist 1.07, “Complete API/OpenAPI contracts.”

## Result

**Verified complete for the current registered API surface.** The API publishes an authenticated
OpenAPI 3.0.3 document as JSON and YAML, plus an interactive Swagger UI. Every runtime route must
have a contract entry or API startup fails. The generated document describes operation inputs,
success and failure responses, authentication and CSRF requirements, and optional resume-storage
and cancellation capabilities.

The hand-maintained endpoint tables in [API-SURFACE](../API-SURFACE.md) are checked against the
generated OpenAPI paths. Error-envelope declarations, route-family failure behavior, spec access,
same-origin Try It Out behavior, and disabled/enabled resume capabilities have focused coverage.

## Verification evidence

- `apps/api/src/openapi.ts`: route-contract registry, fail-closed transform, security schemes,
  response schemas, and authenticated docs UI.
- `tests/integration/database.integration.test.ts`: compares every registered runtime route with
  the generated paths under disabled, storage-enabled, and cancellation-enabled configurations;
  checks required declarations, response coverage, representative request/response schemas,
  security, SSE, upload content type, idempotency, and protected Swagger resources.
- `apps/api/src/error-handler.test.ts`: ensures the public endpoint tables cover the generated
  spec, checks the error envelope on documented failures, and checks the declared schema for every
  4xx and 5xx response.
- `docs/API-SURFACE.md`: current endpoint families, request security, error contract, and special
  transport behavior.

Local verification on 2026-11-06 passed:

- `node --import tsx --test apps/api/src/error-handler.test.ts` — 14 tests passed.
- `node --env-file=.env --import tsx --test --test-name-pattern="Swagger documents every runtime route" tests/integration/database.integration.test.ts` — 1 targeted integration test passed against the local PostgreSQL service.

The local Windows runtime is Node 22.23.2 while the repository requires Node 24 or newer. The
hosted Node 24 workflow remains the authoritative toolchain gate for the exact checklist PR SHA.

## Scope and limits

OpenAPI schemas are descriptive documentation and do not replace Fastify runtime validation or
serialization. Runtime route matching and selected schema invariants are tested, but every
individual OpenAPI property is not mechanically derived from its Zod validator. The API docs
remain session-protected and perform real same-origin operations; verification uses synthetic
fixtures. No production endpoint or deployment was used for this review.
