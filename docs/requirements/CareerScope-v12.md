# CareerScope v12: Authoritative Launch Specification

Company: Viswatra
Product: CareerScope
Domain: careerscope.tech
Status: Approved scope for implementation. Nothing in this document is confirmed as built. Build status is tracked against the repository, not in this document.

This version supersedes v11 and v11.1. It applies the final independent review of v11, the v11.1 hardening amendment, and the owner's approvals.

---

## 1. Approved decisions

| # | Decision | Detail |
|---|---|---|
| D1 | Launch sign-in is email OTP through Resend | Phone OTP after launch, once a provider is chosen. Test login exists only in development and staging, and is blocked in production by configuration |
| D2 | Recruiter job posting is in launch | Employer verification and authorization are required before posting |
| D3 | Referrals stay off at launch | Activated only where verified referrers exist. Until then, the candidate sees an informative empty state, not a broken feature |
| D4 | Candidate-to-recruiter email launches with small caps | Tested abuse controls required. Caps raised only after measured delivery and abuse data |
| D5 | Manual official-link application is the baseline | The browser helper is an optional enhancement |
| D6 | Email is the mandatory verification tick | College, profile-link, and other ticks are optional, based on segment |
| D7 | Date of birth is an age-screening measure | It is not proof of adulthood. Only the screening result is retained |
| D8 | Interview organizer is launch-core | Part of the launch definition, not optional |
| D9 | Candidate outreach is sent by CareerScope | Candidate's name is in the message and reply-to. Sending domain is careerscope.tech |
| D10 | Public job pages publish full text only where source rights permit | Otherwise they link out with attribution |
| D11 | Second email provider for sign-in fallback | Configured before launch behind a provider switch flag. Own SPF, DKIM, and DMARC setup |
| D12 | Recovery point for application records: 1 hour | Continuous WAL archiving to an off-host store, confirmed by restore drill. If archiving is not ready by launch, the 24-hour fallback applies and candidates are told to re-check records after a restore |
| D13 | Listing thresholds set from measurement | Not fixed in this document. Measured on approved sources before public discovery opens |
| D14 | Launch source set | Recruiter postings, ATS public boards (Greenhouse, Lever, Ashby, Workable), and candidate-supplied links. Other sources added only after terms and coverage checks. Naukri and Indeed stay gated |

---

## 2. Launch-core acceptance model

| Capability | Launch status | Release condition |
|---|---|---|
| Production sign-in (email OTP) | Required | Real OTP flow works with fallback provider; test login blocked in production by configuration |
| Candidate onboarding and profile | Required | Complete, secure, accessible |
| Resume management | Required | Validated uploads, encryption, user-controlled deletion |
| Verified job discovery | Required | Sources enabled only with recorded permitted uses and measured coverage |
| Explainable matching | Required | Eligibility shown as advice only; evidence and scoring version recorded |
| Manual official-link application | Required | Works without the browser helper or AI |
| Application evidence and tracking | Required | Candidate claims stored separately from employer acknowledgements |
| Interview workflow organizer | Required | Interviews, stages, contacts, and reminders work |
| Job reporting and feedback | Required | Moderation and investigation workflow works end to end |
| Notifications | Required | In-app and email operational; web push opt-in |
| Account security and privacy | Required | Isolation, data rights, retention, abuse protection tested |
| Recruiter job posting | Required | Employer verification and authorization tested |
| Candidate-to-recruiter email | Conditional | Verified recipients, deliverability checks, abuse controls, small caps |
| Email verification tick | Required | Mandatory for all accounts |
| Other verification ticks | Conditional | Only checks actually completed are shown; no misleading claims |
| Browser-assisted form fill | Optional enhancement | Extension security tests and supported-domain tests pass |
| Referrals | Off at launch | Activated per region or group when verified referrers exist and acceptance tests pass |
| AI resume rewriting | Conditional activation | Factuality, privacy, disclosure, and quota gates pass |
| WhatsApp | Gated | Meta business verification and approved templates |
| eKYC identity tick | Post-launch, gated | Provider contract and consent flow |
| Talent pools, AI mock interviews, XP, career planner | Post-launch | Feature-specific acceptance criteria |

---

## 3. Changes from v11

| # | Change | Source |
|---|---|---|
| 1 | Sign-in outage defined: existing sessions continue, new sign-ins show "temporarily unavailable" | Review B01, v11.1 |
| 2 | Second email provider added for OTP fallback | D11 |
| 3 | Recovery point target set to 1 hour with WAL archiving; 24-hour fallback documented | D12, H3 |
| 4 | Job-source set limited at launch; licensed APIs and career pages added after checks | Review B02, D14 |
| 5 | Listing thresholds deferred to measurement, as a launch gate | D13 |
| 6 | Hardening items H1 to H12 added as acceptance criteria | Review P0 and P1 |
| 7 | Session security: refresh-token rotation, reuse detection, device revocation, cookie policy | H2 |
| 8 | Authentication recovery procedures defined | H1 |
| 9 | Email delivery copy: "delivered" means accepted by mail server, not read | H6 |
| 10 | Photo copy: no claims that browsers prevent downloads; access controls and view logs enforced | H7 |
| 11 | Prompt-injection tests for untrusted text sent to AI | H8 |
| 12 | Deletion timelines per data class; processor list maintained | H9 |
| 13 | WCAG 2.2 AA as explicit target | H10 |
| 14 | Verification evidence schemas, validity, recheck, revocation | H11 |
| 15 | Platform failure tests for Redis, PostgreSQL, email, and workers | H12 |
| 16 | Go/no-go checklist with evidence, owner, result, severity | Review P0 |
| 17 | Alerts delivered through a path independent of the primary VPS | Review section 4 |
| 18 | Outreach, recruiter posting, and referrals unchanged from v11 | D2, D3, D4 |

---

## 4. Module specifications (launch core)

### 4.1 Authentication
- Email OTP via Resend, with a second provider as fallback (D11). Provider switch behind a flag
- Code is single-use, short-lived, and rate-limited by email and by IP
- Attempt caps with lockout backoff
- Sessions: short-lived access tokens; refresh tokens rotate on every use; reuse of a rotated token revokes the token family and signs the device out
- Device list with per-device revocation; sign-out everywhere
- Revocation on password or device change
- Login alerts for new devices; step-up OTP for unusual patterns
- Cookies: HttpOnly, Secure, SameSite
- Outage state: when both providers fail, existing sessions continue. New sign-ins show "Sign-in is temporarily unavailable" with a status link. No claim that access will be restored. Requests are logged with request ID and rejected, never silently dropped. No other sign-in path exists at launch
- Test login: development and staging only; startup check fails if enabled in production
- Phone OTP: post-launch, after provider selection
- Admin and super admin: two-factor required

Authentication recovery:
- Lost email access: recovery through verified identity signals already on the account, with cooldown and login alert. Email alone is never the only recovery factor
- Inaccessible mailbox: support procedure with logged reason and time-limited verification
- Email change: OTP to the current address and OTP to the new address. The old address receives a notice

### 4.2 Onboarding and profile
- Segment selection: student, fresher, experienced
- Date of birth collected for the age screen; only the pass or fail result is kept
- Contact, location, education, graduation year, experience, projects, skills, links
- Preferences: role, job type, locations, salary range (private by default)
- Candidate availability (optional): immediate, notice period, preferred contact, recruiter visibility
- Profile completeness meter
- Public profile link, off by default

### 4.3 Resume
- PDF and DOCX upload; file type, size, and page limits enforced
- Parsing runs in a sandboxed worker; parsed text treated as untrusted
- Encrypted at rest; user-controlled replace and delete
- Multiple versions by target role, with version lineage
- Candidate reviews parsed output before saving
- ATS-friendly templates; ATS score labeled as an estimate
- Share links that expire and can be revoked

### 4.4 Photo (optional)
- Never required to sign up or apply
- Metadata stripped; resized; re-encoded; moderated before display
- Private by default; candidate chooses per application
- Hidden in recruiter first-pass views; shown only for applications the candidate sent
- Recruiters cannot download or forward; views logged
- Deterrence notice to recruiters against unauthorized reuse. No claim that the product can prevent downloads
- Never used in matching, scoring, or AI
- No face matching or face analysis

### 4.5 Verification ticks
- Email verified: mandatory
- Phone verified: post-launch
- College verified: optional, for students and recent graduates
- Profile linked: optional, ownership-checked (GitHub, portfolio domain)
- Skill verified: post-launch
- Identity verified: post-launch, gated on eKYC
- Employer confirmed: post-launch
- Each tick has an evidence schema, validity period, recheck rule, and revocation procedure
- Each tick shows its check and date; expires or rechecks; revocable with notice and reason; appeal route
- A tick is shown only when its check has completed
- Ticks cannot be bought, sold, or transferred
- Recruiters see tier and date only

### 4.6 Lead sources and discovery

Launch source set (D14):
1. Recruiter postings (employer-authorized)
2. ATS public boards and APIs: Greenhouse, Lever, Ashby, Workable
3. Candidate-supplied links and forwarded emails

Added only after terms and coverage checks:
4. Licensed job-data APIs
5. Company career pages with JobPosting markup, within permissions
6. Licensed web search for career pages, verified before display
7. Remote job APIs

Not in launch: Naukri and Indeed ingestion (gated on terms clearance or partner access). LinkedIn: excluded.

Each enabled source has a recorded permission profile covering collection, storage, transformation, AI processing, public display, and redistribution.

Discovery rules:
- Verified career page resolution before display
- Deduplication: canonical URL, employer identifier, ATS requisition ID, then cross-source confidence
- Expiry: per-source rules; default is "possibly closed" after three missed runs, closed after a further set period
- Daily sync, 2 to 3 runs, staggered by source; idempotent; locked per source
- Source health and automated suspension on terms change or repeated errors

Coverage gate (D13): before public discovery opens for a city or role family, the owner sets thresholds from measured listing counts and measured stale and duplicate rates on a golden set. Discovery opens only for the cities and roles that meet the thresholds. Elsewhere, the product shows recruiter postings and candidate-supplied links only, and does not promise broad discovery.

### 4.7 Matching and eligibility
- Hard eligibility (degree, work authorization, location, mandatory qualifications): shown as advice on the job. Never hides a job
- Soft relevance (skills, projects, experience, preferences)
- Missing data is shown, not treated as a mismatch
- Score records its scoring version
- Explanation: matched skills, missing skills, location fit, experience fit
- Transparency page for what each measure is and is not
- Job feedback loop: candidate marks irrelevant, duplicate, incorrect, unavailable, or suspicious
- Search quality evaluation against a golden dataset

### 4.8 Applying
Baseline (always available):
1. Candidate opens the official page from CareerScope
2. Candidate copies or uses prepared details from CareerScope
3. Candidate applies on the employer's site
4. Candidate records "applied" with the method and time

Optional enhancement (browser helper):
- Chrome extension running in the candidate's own browser
- Per-site permission, allowlisted employer domains, field preview
- Fills only fields the profile answers; sensitive fields left to the candidate
- Never submits, never captures credentials, never accepts terms
- Supported domains covered by end-to-end tests; unsupported domains fall back to manual

Rules for both paths:
- Auto-apply is off. The candidate reviews and submits
- The system never stores employer-site credentials
- Every apply action is logged with its method

### 4.9 Tracking and application evidence
- Saved jobs with folders or tags
- Manual tracking: applied, interview, offer, rejected, withdrawn
- Each application records evidence: method, timestamp, confirmation, source, confidence
- Candidate claim is stored separately from any employer or ATS acknowledgement. The product never shows an acknowledgement it did not receive
- Notes, documents, contacts, timeline
- Follow-up reminders; duplicate-application warning; quality check before sending
- Export to CSV or PDF
- Application journey recovery: interrupted preparation restored without repeating work

### 4.10 Interview workflow organizer (launch-core)
- Interview rounds with dates, times, format, and contacts
- Preparation checklist per round
- Reminders before each round
- Status updates per round
- Notes and documents linked to the round
- Independent of AI mock interviews

### 4.11 Candidate-to-recruiter email (conditional, small caps)
- Candidate-initiated, one message at a time; no bulk sends
- Sent by CareerScope from careerscope.tech. The message names the candidate, and reply-to is the candidate's address
- Disclosure in the message that CareerScope sent it on the candidate's behalf
- Recipients only from permitted sources: company-published contact, verified referrer, or opted-in recruiter. No harvesting from sites or portals
- Launch caps: low daily limit per account, per-recipient rate limit, block list
- Attachments scanned; resume sent only when the candidate selects it
- Delivery tracking: sent (accepted by mail server), delivered, bounced, replied. Delivered does not mean read. Replies are shown only when actually received through the integration or confirmed by the candidate
- Abuse reports to human review; repeat abuse suspends sending
- Caps raised only after measured delivery and abuse data

### 4.12 Recruiter posting (launch)
- Recruiter onboarding with manual employer verification
- Postings limited to employer-authorized vacancies
- Auto-sync from the employer's ATS or career page where available
- Free posting; paid visibility later, never higher match rank
- Company page submission as onboarding route
- Receives candidate emails through the outreach channel

### 4.13 Referrals (off at launch)
- Module is built behind a flag and stays off until activation criteria are met
- Activation criteria: verified referrers exist for the target region or group; acceptance tests in section 7 pass; referrer employment verification is rechecked on schedule
- Until activation: candidate sees an informative empty state, and no referral requests are sent
- When active: referrer verifies work email on the company domain; referral links checked; requests made by people only; candidate chooses what to share; duplicate requests blocked; referrers may decline without reason; reporting both ways; withdrawal removes referrer access

### 4.14 Public job pages (rights-gated)
- Full description only where source rights permit public display
- Otherwise a summary with attribution and a link to the official page
- JobPosting markup only for current, complete, rights-cleared postings
- Expired postings removed from markup per Google's requirements
- Canonical links to the official page
- Sitemap generated only from eligible pages

### 4.15 Notifications
- Channels at launch: in-app; email via Resend from careerscope.tech; web push opt-in (PWA)
- WhatsApp: gated on Meta approval, opt-in required
- Security messages always send by email and in-app
- Transactional and marketing kept separate; marketing needs opt-in
- Per-channel and per-type preferences; quiet hours in local time
- Daily cap per user with digest fallback
- One event, one message per channel; outbox with retries, backoff, and dead-letter store
- Deliverability center: bounces, complaints, suppressions, and delivery failures
- Templates in English, Telugu, and Hindi
- No resume, salary, or contact details in notification text

### 4.16 Feedback, reporting, and moderation
- Job feedback: irrelevant, duplicate, incorrect, unavailable, suspicious
- Candidate and recruiter report and block
- Content moderation queue for profiles, job posts, and messages
- Investigation workflow with reason codes and outcomes
- Spam limits on messages and referrals

### 4.17 Admin and super admin
Admin:
- CRUD for users, jobs, sources, company pages, content
- Career page verification queue; source management and health
- Email abuse queue; moderation queue; report queue
- Security dashboard; API and server health; logs with search
- Support view of a user account: only with consent or a logged reason, time-limited, reason-coded

Super admin only:
- Billing and plan settings; role assignment; secrets and provider keys
- Destructive operations; dual approval for sensitive operations
- Global kill switch for AI, email, and sync

Both roles: audit log of every action; per-user AI quotas and token usage

### 4.18 Accessibility and language
- English, Telugu, and Hindi interface
- WCAG 2.2 AA is the explicit design and testing target. Any exception is documented with its reason and planned fix
- Keyboard navigation; readable layouts
- Reduced motion option; accessibility preferences saved to profile
- Light mode for slow connections: text-first lists and apply flow

---

## 5. Cost and quota controls

- Per-tier quotas for AI rewrites, explanations, and parsing; free tier has low fixed quotas
- Quotas reserved before the AI call and released on failure
- Provider timeouts and retry limits on every AI and notification call
- Fallback behavior: AI features show a clear "try later" state, never a silent failure
- Circuit breaker: when daily spend crosses a threshold, AI features pause automatically and the super admin is alerted
- Notification volume capped per user and per day, with alerts on unusual spikes
- Sync compute capped per source per day
- Cost dashboard reviewed daily

---

## 6. Operations and failure domains

Single-VPS plan at launch:
- Resource limits per service (web, API, workers, Redis, database) set and load-tested
- Database and workers moved off the web host first if load tests show contention
- Failure domains documented: what fails together, and what keeps working
- Health checks per service; automatic restart with alerting
- Alerts delivered through a path independent of the primary VPS
- Host-level failure is a known single point of failure at launch. Splitting containers on one machine does not remove it

Recovery targets:
- Recovery point objective: 1 hour for user-created application records, using continuous WAL archiving to an off-host store (D12). Fallback if archiving is not ready by launch: 24 hours, with candidates told to re-check records after a restore
- Recovery time objective: service restored within 4 hours
- Restore drill: performed before launch and monthly after. Drill result recorded in the go/no-go checklist

Backups:
- Hostinger backups verified for frequency, retention, and off-server copies
- Off-host copy required before launch
- Restore tested to a separate environment

Degraded modes (must be tested):
- Email provider down (one provider): failover to the second provider. Existing sessions continue
- Both email providers down: new sign-ins show "Sign-in is temporarily unavailable". Existing sessions continue. Outbound email is queued and retried
- AI provider down: AI features show "try later"; manual flows keep working
- Source down: stale sources marked "possibly closed" only per the rule in section 4.6; no false closures
- Redis down: caches bypassed; auth routes fail closed
- Database down: maintenance page; no writes accepted without a confirmed commit
- Worker down: jobs remain queued; dead-letter store receives jobs after retry limit

---

## 7. Testing

Test types: smoke (every deploy), sanity (every pull request), regression (nightly and before release), critical path (every deploy), Playwright E2E (pull request and nightly), load (before launch), security (every release), accessibility (pull request), prompt-injection (every release), platform failure (before launch).

Load scenarios: 200 normal users; 1,000 concurrent visitors mostly on public pages; 300 users running matches and AI at once; sync during traffic. Pass: performance targets met; error rate under 1%; no lost or duplicated data.

Acceptance tests that must pass before launch:
- Email OTP sign-in works; test login blocked in production
- Authentication outage: simulated provider failures keep existing sessions working; new sign-ins show the outage state; the state clears on recovery
- Session reuse detection: reused refresh token revokes the token family
- Record-level access: no user can read another user's applications, resumes, interviews, or photos
- Role escalation blocked
- Manual apply path works with the browser helper disabled
- Application evidence: candidate claim and employer acknowledgement stored separately
- Verification ticks: each shown only when its check completed; expiry and revocation tested
- Photo hidden in recruiter first-pass views
- Candidate outreach: disclosure present, reply-to correct, caps enforced
- Delivered-but-unread message shows no read or reply status
- Public job page: full text only for rights-cleared sources
- Notification delivery in English, Telugu, and Hindi
- Account deletion removes data from database, storage, caches, and third parties per policy, within published timelines
- Kill switch stops AI, email, and sync
- Referrals show empty state while off
- Platform failure tests pass individually for Redis, PostgreSQL, email provider, and workers, including recovery and data consistency
- Restore drill meets the 1-hour recovery point and 4-hour recovery time targets, or the 24-hour fallback is in effect and disclosed internally

When referrals are activated, the referral acceptance tests in v10 section 16 must also pass.

---

## 8. Monitoring, analytics, and logs

- Uptime, errors (Sentry or equivalent), structured JSON logs, traces, metrics
- Every log line: request ID, hashed user ID, route, duration; redaction for resumes, emails, phone numbers, tokens
- Request ID shown to users in errors
- Debug by request ID, hashed user, or feature
- Dashboards: operations, cost, product funnel, business
- Alerts: downtime, error spikes, sync failures, AI spend, bounce rate, failed jobs, sign-in outage
- Alert delivery independent of the primary VPS
- Analytics: no personal data; consent for non-essential tracking
- Retention: 30 days detailed logs, 90 days summaries, audit logs as required

---

## 9. Data safety

- Portal data stored: link, title, company only
- Listing bodies from portals not stored, cached, or logged
- No user or portal content used for AI training without explicit opt-in
- AI provider no-training settings verified and recorded
- Minimal data sent to AI; untrusted text (job descriptions, resumes, messages) tested for prompt injection
- Deletion timelines per data class: primary database, file storage, caches, search, logs, third-party processors, and backups. Legal retention exceptions listed
- Staff see masked personal data; unmasking logged with reason

---

## 10. Legal and trust

- Privacy policy and terms naming Viswatra
- Grievance officer (DPDP Act)
- DPDP implementation matrix: legal basis, notices, consent withdrawal, grievance, retention, processors, breach procedure
- Commencement dates confirmed against the official MeitY notification before any date is stated publicly
- Cross-border transfers to AI and model providers disclosed
- AI disclosure wherever AI output appears, with a contest path
- Outreach email rules published, with abuse reporting
- Age screen disclosure; under-18 accounts not created
- Recruiter terms: posting, outreach, data use
- Photo and verification consent flows reviewed by counsel
- Verification evidence and recheck rules reviewed by counsel
- Recruiter pricing and refund terms published before any paid plan

---

## 11. Post-launch and gated

Post-launch: phone OTP; mobile push and mobile apps; SMS; skill verification; employer-confirmed tick; identity verification (gated on eKYC); recruiter search, shortlists, pipeline, analytics; talent pools; career transition planner; offer decision workspace; portfolio showcase; job market experimentation; in-app code execution; AI mock interviews; XP, quests, and streaks; courses beyond external links; alumni mentors; email auto-tracking; voice input.

Gated on external approval: WhatsApp (Meta); Indeed and Naukri ingestion (partner or terms); eKYC contract; licensed job-data providers.

Never: LinkedIn ingestion or form fill; automated submission; stored employer credentials; scraping recruiter contacts from sites or portals; pay-to-rank.

---

## 12. External dependencies

| Dependency | Needed for | Owner | Status |
|---|---|---|---|
| careerscope.tech SPF, DKIM, DMARC | Email and outreach | Owner | To do |
| Resend account and domain verification | Email OTP and notifications | Owner | To do |
| Second email provider account, domain verification, SPF, DKIM, DMARC | Sign-in fallback | Owner | To do |
| Meta business verification | WhatsApp | Owner | To do |
| Licensed job-data provider terms and coverage check | Discovery (post-check) | Owner | To do |
| Indeed publisher approval | Indeed feed | Owner | Gated |
| Naukri partner access | Naukri feed | Owner | Gated |
| Legal review | DPDP, outreach, verification, recruiter terms, cross-border | Counsel | To do |
| Hostinger backup verification | Data safety | Owner | To do |
| Off-host WAL archive store | 1-hour recovery point | Owner | To do |
| Candidate and recruiter interviews | Validation | Owner | To do |

---

## 13. Acceptance gates before launch

- Sources: permission profile recorded for each enabled source; coverage thresholds set from measured data; stale and duplicate rates measured on a golden set
- Candidate loop: first match, first application, and completion measured with test accounts
- Evidence: apply method and confirmations stored correctly
- Verification: ticks, expiry, and revocation tested
- AI: factuality, prompt-injection, quota, and fallback tests pass
- Data protection: isolation, deletion, restore drill, consent withdrawal, incident procedure
- Sign-in: both email providers tested; outage state tested
- Session security: rotation and reuse detection tested
- Outreach: caps, disclosure, reply-to, abuse controls tested
- Recruiters: employer verification and posting authorization tested
- Operations: failure domain plan, recovery targets, degraded modes, and platform failure tests pass
- Launch controls: test login blocked in production; kill switch working; feature flags verified in production; alerts reach the owner independently of the primary VPS

---

## 14. Scope and next step

- The approved launch core is smaller than v9's full list
- Referrals, AI resume rewriting, and the browser helper are not blocking launch
- No reliable day count can be given without a code audit against the repository
- Next step: attach the repository. The gap matrix will mark each section as specified, implemented, tested, blocked, or launch-ready

---

## 15. Go/no-go checklist

Each row needs evidence, an owner, a result (pass, fail, or waived with reason), and a blocking severity. Launch requires zero open critical items, and every high item either passed or explicitly waived by the owner in writing.

| # | Item | Source | Evidence | Owner | Result | Severity |
|---|---|---|---|---|---|---|
| 1 | Email OTP sign-in works; test login blocked in production | D1, 4.1 | | | | Critical |
| 2 | Second email provider failover tested | D11 | | | | Critical |
| 3 | Sign-in outage state tested with both providers down | 4.1, section 6 | | | | Critical |
| 4 | Launch source set permission profiles recorded | D14, 4.6 | | | | Critical |
| 5 | Listing coverage per target city and role family meets owner threshold | D13 | | | | Critical |
| 6 | Stale and duplicate rates measured on golden set | D13 | | | | High |
| 7 | Authentication recovery procedures tested | 4.1 | | | | High |
| 8 | Session rotation and reuse detection tested | 4.1 | | | | High |
| 9 | 1-hour recovery point with WAL archiving; restore drill meets target | D12 | | | | Critical |
| 10 | Off-host backup copy in place | section 6 | | | | Critical |
| 11 | Record-level access isolation tests pass | section 7 | | | | Critical |
| 12 | Account deletion tests pass across all stores | section 9 | | | | High |
| 13 | Email delivery copy reviewed | 4.11 | | | | Medium |
| 14 | Photo copy reviewed; access controls tested | 4.4 | | | | High |
| 15 | Prompt-injection suite passes | section 9 | | | | High |
| 16 | WCAG 2.2 AA tests pass on core flows | 4.18 | | | | High |
| 17 | Verification evidence, expiry, and revocation tests pass | 4.5 | | | | High |
| 18 | Platform failure tests (Redis, PostgreSQL, email, workers) pass | section 7 | | | | High |
| 19 | Single-VPS failure domains documented; resource limits load-tested | section 6 | | | | High |
| 20 | Alerts deliver through a path independent of the primary VPS | section 6, 8 | | | | Critical |
| 21 | Kill switch stops AI, email, and sync in production | section 7 | | | | Critical |
| 22 | Outreach caps, disclosure, reply-to, and abuse controls tested | D4, 4.11 | | | | High |
| 23 | DPDP commencement dates confirmed against MeitY notification | section 10 | | | | High |
| 24 | Legal review complete for DPDP, outreach, verification, recruiter terms | section 12 | | | | High |
| 25 | Owner sign-off on accepted risks, including the single-VPS host failure risk | section 6 | | | | Critical |

---

## Appendix: Positioning

> CareerScope: fewer applications, better matches, and jobs you can trust, from the company's own page.
