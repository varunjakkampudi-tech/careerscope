# Test matrix

Records which test proves each stage item. Only tests that a CI script runs count. The traceability
gate enforces this for the foundations register in [FOUNDATIONS](FOUNDATIONS.md).

## Stage 01

| Item | Proof                                                        | Runs in        |
| ---- | ------------------------------------------------------------ | -------------- |
| 1.01 | `scripts/ci/check-traceability.mjs`, architecture boundaries | Quality gates  |
| 1.02 | `scripts/ci/check-requirements-inventory.mjs`                | Quality gates  |
| 1.07 | `tests/integration/migrations.integration.test.ts`           | Services suite |
| 1.08 | `packages/core/src/outbox.integration.test.ts`, queue tests  | Services suite |
| 1.09 | `apps/api/src/error-handler.test.ts`                         | Quality gates  |
| 1.10 | `scripts/tests/domain-events-doc.test.ts`                    | Quality gates  |
| 1.13 | `scripts/tests/design-system-doc.test.ts`                    | Quality gates  |
| 1.14 | `scripts/ci/check-traceability.test.mjs`                     | Quality gates  |

## Stage 02 (in progress)

Session and logout behaviour is covered by:

- `apps/api/src/session-logout.integration.test.ts` (refresh-only revocation)
- `apps/api/src/session-lookup.test.ts` (session budget and rate limits)
- `apps/web/src/lib/next-proxy-headers.test.ts` (local test-access canary)

The remaining stage 02 items have no new tests yet. See [GAP-MATRIX](GAP-MATRIX.md).
