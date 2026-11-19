# Owner item 3.16 — profile completeness checklist: acceptance specification

Status: **design/acceptance preparation only**. This document does not mark item 3.16 verified or claim implementation/test execution.

## Verified starting point (source inspection on `dev` at `2d468d7c23b1784fe42ca3d04b1488a9a69389d2`)

- `apps/web/src/app/(app)/dashboard/page.tsx` currently computes **Career Progress** from four owner-scoped facts: parsed resume, skills added, saved preferences, and an applied lead. This is **not** a field-level profile completeness meter.
- `packages/core/src/profile.ts` validates the persisted profile and exposes `matchingProfile` as a deliberately minimal scoring snapshot. Completeness must not be added to matching evidence or treated as identity verification.
- The pinned owner inventory calls 3.16 **“Profile completeness checklist”**, with sourceStatus **“Existing, expand”** and currentStatus **“not-started”**. The v12 requirements separately call for a profile completeness meter. These statuses must remain unchanged until independently tested implementation exists.

## Proposed implementable acceptance contract (requires implementation and tests)

1. Display a distinct **Profile completeness** checklist on the authenticated candidate profile surface, not a relabeling of dashboard Career Progress. Provide actionable links or focus targets for incomplete fields.
2. Compute the checklist only from the authenticated owner's validated profile response. Do not infer a completed field from a resume parser proposal, another user's data, or a matching/search snapshot.
3. Show separate, explicit completion checks for: required contact details (name, email and home location); education; work history; skills; preferred job titles; preferred locations; salary expectations; availability/notice period; and optional profile photo. Mark optional items clearly; do not make optional values blockers for profile save or discovery.
4. Define the denominator in the implementation and UI. Recommended: required checklist items only for the percentage, while optional enhancements are shown separately. If a required field is already enforced by the save schema, its checklist state must reflect persisted data rather than an unsaved form draft.
5. Use a deterministic pure function with typed input/output and explicit handling for null profile, legacy missing optional fields, empty/whitespace strings, malformed or unavailable response, and loading/error states. A missing profile must never display 100%; a network error must not be represented as zero completeness.
6. Keep all candidate fields private and owner-scoped. No recruiter visibility, verification badge, eligibility claim, or public profile link is implied by completeness. The separately gated verification (3.14), privacy (3.15), and registration/legal (2.05) workflows remain independent.
7. Ensure the UI is keyboard navigable, screen-reader understandable, and usable at responsive widths. A percentage must have a text equivalent and not rely on color alone.

## Evidence required before moving 3.16 to verified

- Unit tests: complete/empty/partial profiles; each checklist item independently toggled; whitespace, legacy defaults, null/loading/error; optional fields excluded from required percentage; deterministic rounding.
- Browser acceptance: authenticated owner saves a missing field, reloads, sees only that checklist entry update; removing it reverses the state; cross-account isolation; accessibility/keyboard/responsive assertions.
- Documentation: traceability inventory, test matrix and file-audit hashes updated **after** code/test changes; record exact head SHA, local commands/results and all required hosted CI jobs. No invented test counts.
- Review the final behavior against the original owner item wording before claiming full verification. If a scope decision remains open, keep currentStatus partial rather than verified.

## Non-goals

No change to authentication, legal registration gate, recruiter visibility, profile photo access, matching scoring, production infrastructure, or deployment. No existing Career Progress percentage is renamed or counted as profile completeness.
