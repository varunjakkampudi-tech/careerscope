# Gap matrix

Each row names the roadmap item, what the repository does today, the evidence, and the gap.
Status values: Existing, Partial, Missing, Gated, Unverified.

## Stage 02: authentication, registration and account security

| Item | Feature                          | Status     | Evidence                                                                            | Gap                                                                     |
| ---- | -------------------------------- | ---------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 2.01 | Email-only OTP login             | Existing   | `apps/api/src/email-otp.integration.test.ts`                                        | None found in audit                                                     |
| 2.02 | Resend integration               | Existing   | `packages/core/src/email-otp-delivery.ts`                                           | Live delivery not verified (see 2.20)                                   |
| 2.03 | Six-digit OTP                    | Existing   | `packages/core/src/email-otp.test.mjs`                                              | None found in audit                                                     |
| 2.04 | Five-minute expiry               | Existing   | `packages/core/src/email-otp-challenges.clock.test.ts`                              | None found in audit                                                     |
| 2.05 | Single-use OTP                   | Existing   | `packages/core/src/otp-challenges.integration.test.ts`                              | None found in audit                                                     |
| 2.06 | Five incorrect-attempt limit     | Existing   | `apps/api/src/otp-limits.test.ts`                                                   | None found in audit                                                     |
| 2.07 | OTP request rate limiting        | Existing   | `apps/api/src/otp-limits.test.ts`, `apps/api/src/rate-limit.test.ts`                | None found in audit                                                     |
| 2.08 | Enumeration prevention           | Existing   | `apps/api/src/email-otp.integration.test.ts`                                        | No dedicated test that both branches return identical bodies and timing |
| 2.09 | New-user registration            | Gated      | `REGISTRATION_ENABLED` defaults to `false`; startup requires OTP and legal versions | Owner approval to enable (B-03)                                         |
| 2.10 | Account created only after OTP   | Existing   | `auth.createOtpAccountInTransaction`                                                | No test of concurrent verification of the same challenge                |
| 2.11 | Versioned terms and privacy      | Partial    | Challenge stores `termsVersion` and `privacyVersion`                                | No re-acceptance when a version changes                                 |
| 2.12 | Optional marketing consent       | Partial    | Opt-in stored; withdrawal tested (reconciliation V12-13-006)                        | No per-version consent history shown to the user                        |
| 2.13 | HttpOnly secure sessions         | Existing   | `apps/api/src/app.ts` cookie options                                                | None found in audit                                                     |
| 2.14 | Refresh and rotation             | Existing   | `apps/api/src/session-lookup.test.ts`, `packages/core/src/auth.ts`                  | None found in audit                                                     |
| 2.15 | Revocation and device management | Existing   | `GET /api/account/sessions`, `docs/AUTHENTICATION.md`                               | None found in audit                                                     |
| 2.16 | Email change, both addresses     | Existing   | `scripts/tests/check-ui.ts` email-change journey                                    | None found in audit                                                     |
| 2.17 | Lost-email recovery              | Missing    | Reconciliation V12-4.1-013 and V12-4.1-014 are NOT_IMPLEMENTED                      | No recovery flow, cooldown or inaccessible-mailbox procedure (B-04)     |
| 2.18 | Suspicious-activity protection   | Partial    | Rate limits and session revocation exist                                            | No new-device login alert (V12-4.1-007) and no step-up OTP              |
| 2.19 | Logout and expiry handling       | Existing   | `POST /api/session/logout`, refresh-only revocation test                            | None found in audit                                                     |
| 2.20 | Live Resend domain and inbox     | Unverified | Requires the live provider account                                                  | Owner evidence required (B-01)                                          |

Roadmap conflict, for the owner: stage 02 says production must not expose "a second email fallback",
while the v12 decision D11 requires a second provider for sign-in fallback (B-02).
