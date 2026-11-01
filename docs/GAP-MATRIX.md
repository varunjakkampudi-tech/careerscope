# Gap matrix

Each row names the roadmap item, what the repository does, the evidence, and any remaining gap.
Status values: Done (built and tested here), Existing (built earlier and tested), Gated (disabled
by configuration pending an owner decision).

## Stage 02: authentication, registration and account security

| Item | Feature                          | Status   | Evidence                                                                                                                                                                                      | Remaining gap                                                                                                 |
| ---- | -------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 2.01 | Email-only OTP login             | Existing | `apps/api/src/email-otp.integration.test.ts`                                                                                                                                                  | None                                                                                                          |
| 2.02 | Resend integration               | Done     | `packages/core/src/email-otp-delivery.ts`. Resend dashboard shows `careerscope.tech` Verified; a live notice to the owner address shows Delivered                                             | Notice is in the inbox, not spam (checked 1 Nov 2026); sign-in code placement not checked separately          |
| 2.03 | Six-digit OTP                    | Existing | `packages/core/src/email-otp.test.mjs`                                                                                                                                                        | None                                                                                                          |
| 2.04 | Five-minute expiry               | Existing | `packages/core/src/email-otp-challenges.clock.test.ts`                                                                                                                                        | None                                                                                                          |
| 2.05 | Single-use OTP                   | Existing | `packages/core/src/otp-challenges.integration.test.ts`                                                                                                                                        | None                                                                                                          |
| 2.06 | Five incorrect-attempt limit     | Existing | `apps/api/src/otp-limits.test.ts`                                                                                                                                                             | None                                                                                                          |
| 2.07 | OTP request rate limiting        | Existing | `apps/api/src/otp-limits.test.ts`, `apps/api/src/rate-limit.test.ts`                                                                                                                          | None                                                                                                          |
| 2.08 | Enumeration prevention           | Existing | `apps/api/src/email-otp.integration.test.ts` asserts that sign-in does not create accounts and that the response does not depend on the address                                               | None                                                                                                          |
| 2.09 | New-user registration            | Gated    | `REGISTRATION_ENABLED` defaults to `false`; startup requires OTP and versioned legal documents                                                                                                | Owner approved. Enabling still needs counsel-approved legal text and public URLs, then the deploy step (B-03) |
| 2.10 | Account created only after OTP   | Existing | `auth.createOtpAccountInTransaction`; `apps/api/src/email-otp.integration.test.ts` covers concurrent verification of one challenge                                                            | None                                                                                                          |
| 2.11 | Terms and privacy re-acceptance  | Done     | `packages/core/src/legal-acceptance.ts`; `apps/api/src/legal-acceptance.integration.test.ts`; acceptance dialog in the signed-in shell                                                        | Telugu and Hindi wording needs native review                                                                  |
| 2.12 | Optional marketing consent       | Existing | Append-only `account_acceptances` ledger with versions; withdrawal tested                                                                                                                     | None                                                                                                          |
| 2.13 | HttpOnly secure sessions         | Existing | `apps/api/src/app.ts` cookie options                                                                                                                                                          | None                                                                                                          |
| 2.14 | Refresh and rotation             | Existing | `apps/api/src/session-lookup.test.ts`, `packages/core/src/auth.ts`                                                                                                                            | None                                                                                                          |
| 2.15 | Revocation and device management | Existing | `GET /api/account/sessions`, `docs/AUTHENTICATION.md`                                                                                                                                         | None                                                                                                          |
| 2.16 | Email change, both addresses     | Existing | `scripts/tests/check-ui.ts` email-change journey                                                                                                                                              | None                                                                                                          |
| 2.17 | Lost-email recovery              | Done     | `packages/core/src/recovery-email.ts`; `apps/api/src/recovery.integration.test.ts`; recovery section in account security; recovery path on the sign-in page                                   | Telugu and Hindi wording needs native review                                                                  |
| 2.18 | Suspicious-activity protection   | Done     | New-device sign-in alert (`apps/api/src/new-device-alert.integration.test.ts`, `packages/core/src/email-otp-delivery.test.ts`); notices on recovery use, recovery address changes and removal | No threshold-based step-up: every sign-in already requires an email code, so the extra step is inherent       |
| 2.19 | Logout and expiry handling       | Existing | `POST /api/session/logout`, `apps/api/src/session-logout.integration.test.ts`                                                                                                                 | None                                                                                                          |
| 2.20 | Live Resend domain and inbox     | Done     | See 2.02                                                                                                                                                                                      | Sign-in code placement not checked separately                                                                 |

## Decisions recorded for stage 02

- **Recovery address (2.17):** confirmed by a six-digit code sent to the address. Refused when the
  address is any account's sign-in address, so it cannot point at another account. Recovery sign-in
  is refused for 72 hours after confirmation, so a stolen session cannot add a recovery address and
  use it at once. Each recovery event sends a notice to the sign-in address.
- **Recovery replies (2.17):** the anonymous recovery routes return the same response whether or not
  an account or recovery address exists, and every rejected code returns the same 401.
- **Terms re-acceptance (2.11):** only a recorded earlier version forces acceptance. An account with
  no record is not forced, because it predates the record. Reads stay open. Every other change returns
  403 until the account accepts.
- **Step-up (2.18):** the sign-in itself is an email code, so a further step-up for new devices would
  add no check. Threshold-based step-up is not built.
- **Second email provider (B-02):** owner decision, recorded in the stage 02 close-out: no second
  delivery provider is added in stage 02. The roadmap stage 02 says no second fallback. The provider-
  neutral fallback interface stays in place, and a real fallback remains a launch gate for later.
- **Registration (B-03, item 2.09):** owner approved enabling registration. `REGISTRATION_ENABLED`
  stays `false` in the repository. It is set to `true` only at deployment, after counsel approves the
  effective Terms and privacy text and their public HTTPS URLs (see
  [AUTHENTICATION](AUTHENTICATION.md)). The owner's approval does not replace counsel's approval of the
  legal text.
