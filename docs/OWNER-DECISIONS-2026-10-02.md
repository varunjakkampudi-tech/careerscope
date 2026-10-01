# CareerScope owner decisions — 2026-10-02

Status: **APPROVED OWNER DIRECTION**

This record resolves product/architecture choices that were intentionally blocked on owner direction.
It does not fabricate host, provider, CI, legal, or operator evidence. Tickets that additionally require
live evidence remain blocked until that evidence exists.

## CS-46 — resume-derived matching facts

**Decision: explicit per-fact exclusion gate.**

CareerScope must never silently reintroduce a resume-derived skill or title that the candidate declined.
Add durable exclusions for resume-derived skills/titles, scoped to the candidate and resume parse/revision.
The matching context may use accepted resume-derived facts plus explicit profile preferences; excluded facts
must contribute zero to matching, recommendations, recruiter discovery, or AI context.

Requirements:
- exclusions are explicit, reversible and visible to the candidate;
- re-parsing a changed resume creates a reviewable proposal and does not silently clear prior intent;
- match evidence distinguishes profile-entered, resume-accepted and excluded facts;
- years-of-experience keeps the existing explicit-user-value-wins rule;
- no LLM decides whether an excluded fact returns.

## CS-40 / CS-88 — admin authorization and admin UX

**Decision: proceed with a dedicated privileged Admin Control Plane.**

Approved functional scope: dashboard, users/candidate verification, recruiters, jobs/content, CMS,
analytics, AI model/cost controls, system/server health, logs/audit, feature flags, integrations,
privacy/data requests, providers, queues/workers/DLQ, backups, deployments, scheduled jobs and security.

Authorization contract:
- server-enforced RBAC and least privilege; UI hiding is never authorization;
- initial roles: Owner, Platform Admin, Support, Content Editor, Recruiter Operations,
  Security Auditor and Billing Viewer;
- destructive/high-risk operations require explicit confirmation, reason and audit event;
- no raw arbitrary database editor;
- secrets/tokens/cookies/passwords are never returned to the admin UI;
- operational logs and immutable admin/security audit events remain distinct;
- CMS publishing uses Draft -> Preview -> Publish -> Version History -> Rollback.

The approved CareerScope Design System handoff is the visual source of truth. Implementation must use
real APIs/data or explicit unavailable states; illustrative screenshot values are never production data.

## CS-44 — account recovery and verification

**Decision: do not build a second bespoke email-token recovery system.**

Cognito is the target identity architecture. CS-44's security requirements (non-enumeration, expiry,
single-use semantics, throttling, abuse controls, safe recovery UX) become acceptance requirements of
the Cognito authentication work. Until Cognito is released, retain the current authenticated password
change and documented operator recovery path; do not expose a fake forgot-password flow.

## CS-90..CS-94 — Cognito architecture

**Decision: approved target architecture.**

- AWS region: **ap-south-1**.
- Primary account identifier: **verified email**. Email comparison is normalized/case-insensitive.
- Phone number: optional profile/contact field initially; phone OTP login is a later capability.
- Hosted identity authority: Cognito; CareerScope continues to issue/own its opaque application session
  after server-side provider verification/exchange.
- Browser storage must not persist Cognito access/refresh tokens.
- Custom auth domain target: **auth.careerscope.tech** when DNS/certificate configuration is ready;
  provider default domain may be used only for controlled pre-production verification.
- Existing owner account is linked/migrated by verified normalized email through a one-time controlled
  migration; never create a duplicate owner. Existing password hashes are not exported to Cognito.
- Rollout is feature-flagged/canary and keeps the current Argon2/session path available as rollback until
  disposable-account E2E, monitoring and owner-account continuity are proven.
- OTP values/tokens never enter logs, URLs, repository evidence or analytics.
- Branded email sender target: a verified CareerScope domain identity; actual From/Reply-To and SES
  production access remain operational/DNS evidence, not assumptions.

## CS-89 — OpenRouter / AI

**Decision: architecture and eventual activation approved, but production remains default-OFF until secret and live proof exist.**

AI may provide assistive preparation/explanation functionality only. It must not control deterministic
matching, ranking, authorization, identity, candidate verification or application status.

Activation requirements remain fail-closed:
- owner-provisioned secret through the approved runtime secret path, never Git/chat;
- a specific provider-catalog-verified free model immediately before activation;
- budgets/rate limits and admin kill switch;
- redacted telemetry/cost attribution;
- exact-SHA deployment, live verification and rollback proof.

This decision clears the product-approval question; it does not pretend the secret or live activation exists.

## CS-5 — V1 retirement

**Decision: V2 is canonical; retire V1 only through evidence-backed strangler migration.**

Do not delete the legacy layer in one large change. For each remaining V1 dependency:
1. inventory consumer and data contract;
2. provide V2 replacement;
3. run parity/compatibility evidence;
4. move production consumer;
5. prove rollback;
6. delete only after no runtime/build/deploy dependency remains.

Static/public artifacts that still serve a legitimate purpose may remain until their V2 replacement is live.
No 22k-line deletion is accepted merely to improve a completion percentage.

## CS-30 / CS-86 — managed firewall

**Decision: required production policy is allow inbound 22/80/443 only; deny other unsolicited inbound traffic.**

Preserve the existing OS nftables and loopback/container-network controls. The managed Hostinger firewall
is defence in depth and must be configured in hPanel and verified externally. This repository record is
owner approval of the policy, **not evidence that hPanel has been changed**.

## CS-34 — web runtime least privilege

**Decision: approve least-privilege web runtime and rollout.**

The web service receives only configuration it demonstrably consumes. Database credentials, resume
encryption material and unrelated service secrets must not be inherited by the web runtime. Roll out
through the normal exact-SHA deployment gate and verify production health/provenance.

## Backups and off-host disaster recovery

**Decision updated: production data protection is required before CareerScope becomes materially multi-user.**

For the current single-owner phase, local verified database backups may remain the immediate baseline.
Before public/multi-user/recruiter rollout, add encrypted off-host backups with least-privilege credentials,
retention, restore drill, monitoring and documented RPO/RTO. A backup is not considered proven until a
restore is successfully verified. Do not describe local-only snapshots as disaster recovery.

## Candidate verification

Approved trust model: candidates may upload a profile photo; an authorized CareerScope verification role
reviews the profile and completes the defined verification call/process. The verified badge is protected
backend state only. Candidate-editable data cannot set or preserve it. Decisions are auditable and the
badge means only CareerScope's defined profile/identity verification — not employment, skills, government
identity, background-check clearance or endorsement unless separately implemented.

## External integrations

Email, LinkedIn, Naukri and other connected accounts are future, feature-flagged integrations.
Use only legitimately authorized provider capabilities. No credential harvesting, cookie/session replay,
CAPTCHA bypass or unauthorized authenticated scraping. Provider capabilities are explicit and default-deny.

## Closure rule

Owner-decision blockers covered above may now move to implementation/design review where their owner gate
was the only blocker. Tickets requiring live Hostinger, DNS, provider-secret, CI, human accessibility,
or restore evidence remain blocked until that real evidence is recorded.
