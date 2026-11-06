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
| 1.12 | `scripts/tests/design-system-doc.test.ts`                    | Quality gates  |
| 1.13 | `scripts/ci/check-traceability.test.mjs`                     | Quality gates  |

The owner's separate fifteen-item Stage 01 prompt maps to this register in
[FOUNDATIONS](FOUNDATIONS.md). Its release-gate behavior is additionally covered
by `scripts/ci/check-deploy-gate.test.mjs`, run by `npm run gates:test`; the tests
ensure manual partial suites cannot authorize a SHA or override a full-trigger
failure. The prompt's item 1.01 full-file audit is complete and independently
approved; current coverage is recorded in [STAGE-01-FILE-AUDIT](audits/STAGE-01-FILE-AUDIT.md).

## Stage 02

| Item             | Proof                                                                                                                         | Runs in                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 2.02             | `packages/core/src/email-otp-delivery.test.ts` (notice path, escaping, no code in notices); live check recorded in GAP-MATRIX | Quality gates, Services suite |
| 2.08             | `apps/api/src/email-otp.integration.test.ts`                                                                                  | Services suite                |
| 2.10             | `apps/api/src/email-otp.integration.test.ts` (concurrent verification)                                                        | Services suite                |
| 2.11             | `apps/api/src/legal-acceptance.integration.test.ts`                                                                           | Services suite                |
| 2.17             | `apps/api/src/recovery.integration.test.ts`                                                                                   | Services suite                |
| 2.18             | `apps/api/src/new-device-alert.integration.test.ts`, `packages/core/src/email-otp-delivery.test.ts`                           | Quality gates, Services suite |
| 2.19             | `apps/api/src/session-logout.integration.test.ts`, `apps/api/src/session-lookup.test.ts`                                      | Services suite, Quality gates |
| 2.13, 2.14, 2.15 | `apps/api/src/session-lookup.test.ts`, `apps/web/src/lib/next-proxy-headers.test.ts`                                          | Quality gates                 |
| 2.16             | `scripts/tests/check-ui.ts` (email-change journey)                                                                            | Browser suite                 |

The Chromium browser suite (`scripts/tests/check-ui.ts`) covers the sign-in, settings and shell
changes of this stage. Its result is recorded with the commit that ships them.
