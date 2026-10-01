# CareerScope Owner Decisions — 2026-10-02

Status: OWNER-APPROVED PRODUCT/PLATFORM DECISIONS

This record resolves owner-controlled decision gates. It does not fabricate implementation,
independent-review, provider-authorization, DNS, secret, hPanel, live-host or deployment evidence.

## CS-46 — Resume-derived matching facts
DECISION: require an explicit per-fact exclusion mechanism.

Resume-derived skills and titles are evidence proposals, not irrevocable truth. A candidate must be
able to exclude an individual resume-derived skill/title from matching without deleting the resume.
The exclusion persists across searches until the resume is re-parsed; a re-parse must present the
new facts for reconciliation rather than silently re-enable a previously excluded fact.

The deterministic matcher remains authoritative. Exclusion is user control over input evidence,
not AI influence over scoring.

## CS-50 — Application/interview lifecycle
DECISION: approve the honest, user-controlled lifecycle already selected in product design.

CareerScope does not infer employer outcomes. Opening an external application URL never marks
Applied. Application/interview status and dated history are user-entered unless a future explicitly
authorized integration supplies a verified event. Do not fabricate ATS stages, dates, notes,
documents or AI insights. This owner decision satisfies the owner-signoff gate in CS-50.

## CS-64 — Resume-title language scope
DECISION: English title derivation only for the current release.

Non-English or undeterminable titles must be reported as undetermined, never silently converted to
an empty success. Future language support is a separately versioned capability with positive
language fixtures and English regression coverage. This owner decision satisfies CS-64 AC1.

## CS-17 — Dismiss semantics
DECISION: support dismiss, but do NOT overload application lifecycle status.

Dismiss is a discovery disposition, separate from saved/applied/interviewing/offer/rejected/archive
application state. It must persist per owner/job so a dismissed posting is not immediately
re-recommended, be reversible, and be auditable. The API/domain model must expose this explicitly
before the UI enables Dismiss.

## CS-40 / CS-88 — Admin control plane
DECISION: owner design baseline is approved.

The approved CareerScope Admin design covers dashboard, users/recruiters, CMS draft-preview-publish-
version-rollback, analytics, AI FinOps, system/server health, logs/audit, feature flags,
integrations, security/privacy, providers, queues/DLQ, backups, releases, scheduled jobs and system
states.

Authorization requirements:
- separate privileged admin surface;
- server-enforced RBAC and least privilege;
- no raw database editor;
- no secrets/tokens/raw resume contents in generic investigation endpoints;
- operational logs are distinct from immutable admin/security audit events;
- destructive/high-risk actions require explicit confirmation, reason and audit;
- ordinary authenticated users and anonymous callers must be rejected by the API, not merely hidden
  by navigation.

Owner design approval is granted. Independent Security/System Designer review remains mandatory
before privileged endpoints are implemented or enabled.

## CS-44 / CS-92 — Recovery sender/domain/security decisions
DECISION:
- Sender domain: careerscope.tech
- Default transactional From identity: no-reply@careerscope.tech
- Support/Reply-To identity: support@careerscope.tech once that mailbox/alias is operational
- Secrets: production secret store/environment injection only; never Git, logs, CMS plaintext or chat
- Recovery design: approve the existing non-enumerating, expiring, single-use, replay-resistant
  design, subject to executable abuse fixtures and independent Security review
- Registration remains disabled until its own release gate is satisfied

Domain/DNS verification, provider credentials, deliverability and live sending evidence are
operational gates and are not claimed by this decision.

## CS-89 — OpenRouter production AI
DECISION: authorize guarded production activation only after secret provisioning and live gate
verification.

AI remains OFF by default. Only explicitly approved use cases may enable it. Deterministic
matching/ranking must never depend on the model. Use a provider-catalog-verified currently-free
model where the ticket requires one. Budget/rate limits, fail-closed behavior, redacted logging,
feature kill switch and rollback to AI_ENABLED=false are mandatory.

This decision authorizes activation; it does not claim that a production API secret has been
provisioned.

## CS-90–CS-94 — Cognito
DECISION: architecture direction approved, rollout remains gated.

- Primary region: ap-south-1 unless AWS account/service availability requires a documented exception.
- Cognito becomes the future external identity authority only after migration acceptance.
- Existing CareerScope owner identity/data remains canonical during migration; never create duplicate
  owner records merely because Cognito subject identifiers differ.
- Exchange successful Cognito authentication for CareerScope's server-side opaque session; do not
  expose provider tokens to application JavaScript beyond what the approved flow strictly requires.
- OTP/passwordless verification is preferred for the planned flow.
- Current Argon2/session authentication remains the rollback path until Cognito E2E acceptance is
  proven.
- Custom auth domain should use a careerscope.tech subdomain selected during DNS setup; no DNS claim
  is made here.
- Email sender decisions follow CS-44/CS-92 above.
- UI designs for signup/OTP/recovery/error/resend/mobile/accessibility are owner-approved through the
  frozen CareerScope design handoff.

AWS account identifiers, pool IDs, secrets, DNS records, SES production access, disposable test
mailboxes and live rollout evidence must come from the real environment and must never be invented.

## CS-30 / CS-86 — Managed firewall
DECISION: use defence in depth and attach a Hostinger managed firewall policy.

Intended public inbound exposure:
- TCP 443: public IPv4 + IPv6
- TCP 80: public IPv4 + IPv6 only for HTTP-to-HTTPS/ACME requirements
- TCP 22: restricted to the narrowest practical trusted administrative source range; preserve
  Hostinger console/recovery access before tightening
- PostgreSQL 5432, Redis 6379, LocalStack/other internal ports: never public

Keep the existing host-native firewall and container/network-namespace controls. Never flush the
host ruleset, publish internal ports or treat local simulation as managed-firewall evidence.
hPanel attachment and external IPv4/IPv6 probes remain operator evidence and are not claimed here.

## Off-host backup
DECISION: off-host encrypted backup is required before production recovery can be called complete.

Use encrypted, access-controlled off-host storage with retention and restore testing. The repository
must not contain backup credentials. A real scheduled dump, off-host copy and restore drill are
required evidence; documentation alone is not acceptance.

## Evidence rule
Owner decisions remove decision gates only. Tickets remain BLOCKED/QA/UAT as required by their
remaining executable acceptance criteria. Never promote a ticket merely because this file exists.
