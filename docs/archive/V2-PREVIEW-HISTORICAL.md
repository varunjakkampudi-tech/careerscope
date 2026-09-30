# CareerScope v1.2.0

The V2 preview features are included in the v1.2.0 minor release. These additions
preserve the existing Mac-local backend and static mobile deployment architecture.

## Mac Workspace

- Search supports a Last 24 hours provider-search window.
- Fresh matches opens New/Saved leads posted in the last day at 85% or higher,
  ordered newest first. Unknown posting dates are excluded.
- Saved shortlist includes every saved lead, without date or score restrictions.
- Both shortcuts clear previous selections and stale filters, and persist the
  selected filters in the URL.
- Application history links back to the original lead for review. It does not
  start or retry an application automatically. Existing submission approval and
  uncertain-outcome protections remain unchanged.

## Mobile Workspace

- Public All jobs/Saved views and per-job bookmark toggles.
- Composable keyword, source, posted-date and ordering controls with URL state.
- Public posting URLs are saved in this browser only, never in the repository or
  the private snapshot. They do not synchronize to Mac lead statuses.
- Missing saved postings are reported when an updated snapshot drops their URLs.
- Clear saved jobs requires confirmation; blocked browser storage is handled.
- Encrypted admin supports the same posted-date windows. Private decryption and
  tab-session behavior are unchanged. Settings/Profile icons remain absent.

## Verification

Run `npm test`, `npm run typecheck`, `npm run build`, `npm run test:ui`,
`npm run pages:test`, `npm run pages:workspace:test`, and
`node scripts/check-admin-ui.mjs` before releasing.

The isolated browser fixtures use synthetic jobs and do not submit applications,
run real provider searches, or modify the user's profile. Live availability,
country eligibility and employer requirements must still be reviewed before
applying. Mobile remains static and the backend stays Mac-local.
