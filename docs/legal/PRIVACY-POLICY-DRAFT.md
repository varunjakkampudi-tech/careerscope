# CareerScope Privacy Notice — Counsel Draft

**Status: DRAFT — NOT APPROVED, NOT EFFECTIVE, AND NOT FOR PUBLICATION.**

Prepared 20 October 2026 from repository code, current architecture documents,
and the CareerScope product scope. This draft records known
technical facts and identifies unknowns; it is not a legal conclusion or a
compliance certification. The repository implements guarded OTP registration
and versioned acceptance recording, but registration is disabled by default and
this draft is not presented for acceptance. Code in this checkout is not proof
that OTP or signup is enabled in any deployed environment.

## 1. Operator and contact details — unresolved

The approved product source requires the policy to name Viswatra. The precise
legal entity name, postal address, privacy contact, grievance contact/officer,
jurisdiction-specific rights channel, and effective date have not been verified
in this repository. Owner and qualified counsel must supply and approve them.

## 2. Information the current product handles — engineering inventory

The current implementation and approved product scope indicate these data
classes:

| Data class                      | Current use                                                                                         | Known handling / unresolved detail                                                                                                                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account email                   | Email OTP sign-in and account identity (implementation present; deployment availability unverified) | OTP challenges persist keyed/HMAC-derived address and code digests, not plaintext codes. Resend receives the recipient address and message code to deliver authentication mail when explicitly configured. Sender-domain verification and provider tracking settings remain unverified. |
| Session state                   | Authenticate workspace requests                                                                     | Browser receives an opaque HttpOnly, SameSite=Strict cookie (Secure on HTTPS); the server stores a hash and expiry. Exact cleanup/retention of expired database rows requires verification.                                                                                             |
| Profile and preferences         | Candidate workspace and deterministic matching                                                      | Owner-scoped PostgreSQL profile data; specific field retention/deletion and any optional visibility rules require per-feature verification.                                                                                                                                             |
| Resume files and parsed results | Candidate-controlled resume review and matching                                                     | Private encrypted file storage and owner-scoped metadata/results are implemented. Storage-provider location, backup retention, deletion propagation, and processor terms require operator/counsel confirmation.                                                                         |
| Search and job evidence         | Job discovery, match explanation, saved-job and application workflows                               | Search requests, source outcomes, job records, saved-job state, notes, and lifecycle data are stored in PostgreSQL. Exact retention for each class and each provider source is not established by this notice.                                                                          |
| Abuse-control state             | Limit authentication and sensitive requests                                                         | Redis holds short-lived rate-limit counters; queue Redis is a separate service. Exact host-level persistence/retention must be confirmed against deployment configuration.                                                                                                              |
| Operational diagnostics         | Service reliability and security                                                                    | Structured logs use request correlation and configured redaction. Host retention, access, backups, and whether any deployed proxy logs contain client identifiers require operator validation.                                                                                          |

This table is an implementation inventory, not a complete legal record of
processing. Any additional fields, subprocessors, analytics, or collection paths
must be added only after verifying active code and deployment configuration.

## 3. Purposes and service providers — known scope and open verification

Known product purposes are account authentication, workspace operation, profile
and preference management, resume processing, permitted job discovery,
deterministic matching, saved-job organization, and candidate-controlled
application tracking. Resend is the current authentication-email provider.
PostgreSQL, Redis, private file storage, infrastructure hosting, and permitted
job sources are part of the documented architecture; actual provider entities,
locations, subprocessors, transfer arrangements, and contractual terms are not
verified by this repository evidence.

The approved v12 source keeps AI and certain integrations gated. Current API
session behavior reports AI disabled. Do not state that no data is processed by
AI in every deployment until all server/worker configuration and provider paths
are verified for the target release.

## 4. Cookies, analytics, and marketing

The current authenticated API uses a necessary session cookie. This repository
does not establish a complete production cookie inventory for the deployed
domain or proxy. The account UI/API implements an optional marketing preference
with append-only acceptance events and withdrawal; marketing message delivery is
not implemented. Authentication requests do not constitute marketing consent.
Signup is disabled by default and must remain disabled until approved legal text
and production configuration are established.

## 5. Retention, deletion, export, and rights — unresolved

No unverified retention period is promised here. Counsel and the owner must
approve a retention schedule by data class, including primary records, encrypted
files, parsed results, caches, queues, security logs, backups, and third-party
processors. Account deletion, export, consent withdrawal, legal retention
exceptions, response timelines, and recovery behavior require implementation
and end-to-end verification before this notice describes them as available.

## 6. Security and incidents — bounded factual statement

The codebase includes server-side sessions, owner-scoped authorization,
CSRF/origin checks, encrypted private resume storage, structured logging, and
secret-redaction controls. These controls are not a guarantee that breaches are
impossible and do not establish a certification. Hosted configuration, access
controls, incident contacts, breach procedures, monitoring, and any statutory
notice timelines require current operator evidence and counsel review.

## 7. Cross-border processing and legal basis — counsel decision required

This repository does not verify data residency, processor location, transfer
mechanisms, jurisdiction-specific legal bases, or the applicability/commencement
of a particular legal requirement. Counsel must verify official sources and
approve the notices, legal basis, processor disclosures, grievance procedure,
retention, and transfer language before publication. Do not infer that
necessary-service processing is blanket consent.

## 8. Version and acceptance controls

The notice version must be selected only after counsel approval. Before new
accounts can be finalized, the backend enforces and atomically records the
configured Terms version, required privacy notice acknowledgment, UTC timestamp,
and associated account identity after OTP verification. Any marketing choice
remains separate, unchecked by default, optional, versioned, and revocable
through the account settings flow. These behaviors are implemented in this
checkout, but registration remains disabled by default and no acceptance is
being collected under this draft. Do not enable signup until counsel-approved
text, version identifiers, public HTTPS URLs, and production configuration are
approved and verified.
