# Product Surface

What a user can actually do today. Written from the deployed V2 application, not
from a design document.

---

## Access

`https://careerscope.tech` is a **single-owner** workspace. Public registration
is disabled. There is no landing page, no marketing site and no public job
browsing — the root URL is the application.

Unauthenticated, the only reachable endpoints are health, session, login and
register (the last disabled).

---

## The one page

`v2/apps/web/src/app` contains exactly one route, `/`, plus a generated
`robots.ts`. Every capability below is a component on that page, not a
navigable route.

| Area              | Component               | What it does                                       |
| ----------------- | ----------------------- | -------------------------------------------------- |
| Sign in / account | `account-form.tsx`      | Email and password sign-in                         |
| Account security  | `account-security.tsx`  | Change password; revoke other sessions             |
| Profile           | `profile-editor.tsx`    | Edit the candidate profile; revision-checked saves |
| Resume            | `resume-panel.tsx`      | Upload, watch parsing, cancel, delete              |
| Search results    | `match-evidence.tsx`    | Per-job score with the evidence behind it          |
| Leads             | `saved-leads.tsx`       | Save, note, archive, reopen, view history, export  |
| Preparation       | `preparation-panel.tsx` | Rules-v1 readiness and interview questions         |

All API access goes through `lib/api.ts`.

---

## What a user can do

### Profile

Create and edit a candidate profile. Saves carry a revision; if the record
changed since it was loaded, the save is refused with "Record changed; reload
before saving" rather than silently overwriting.

### Resume

Upload a PDF or DOCX. Upload is idempotent per `Idempotency-Key`, returns
`202`, and parsing happens asynchronously in the files worker — in a child
process, so a malformed document cannot take the worker down.

An in-flight upload can be cancelled. A settled one can be deleted. When the
disk is genuinely full the API returns **507** with a typed error, and the
upload stays in `uploading` so it can be retried once capacity returns.

Limits: 5 uploads/hour, 10 recovery attempts/hour, 20 cancels or deletes/minute.

### Discovery

Start a search. It runs across five sources — RemoteOK, Himalayas, Greenhouse,
Lever and Workable — each with its own deadline and failure isolation, so one
slow or broken source cannot poison the run or another source's results. A run
that partially fails reports which sources failed rather than silently
returning fewer jobs.

Results are deduplicated by fingerprint.

Searches are idempotent per owner, enforced by a unique index, so a double-click
does not start two runs. A running search can be cancelled.

### Live progress

Search progress streams over server-sent events. Events carry a monotonic
sequence; on reconnect the client sends `Last-Event-ID` and the server resumes
after it, so a dropped connection does not lose progress.

### Matching

Each job is scored deterministically against a **frozen snapshot** of the
profile taken when the run started — so editing the profile mid-run cannot
change results underneath the user. Scores come with evidence and provenance.
Hard exclusions apply, and low-confidence sources are capped.

No AI. No external model calls. The same inputs always produce the same score.

### Leads

Save a job as a lead, add notes, archive it, reopen it. Every change is
revisioned and recorded in history. Concurrent edits produce a 409, not a lost
update. Leads export from the search they came from.

### Preparation

Rules-v1 readiness assessment and interview questions, with evidence links.
Deterministic, like matching.

### Account security

Change password — requires the current one, rate limited to 5/hour, and clears
the session. Revoke all other sessions. Sign out.

---

## What a user cannot do

Not because it is hidden, but because it does not exist:

- Register (disabled on the deployed host)
- Reset a forgotten password — no email sender exists
- Verify an email address
- Browse jobs without signing in
- View company profiles, market or skills aggregates
- Save a search or set up alerts
- Reach any admin view
- Deep-link to any area — there is only one route

See [KNOWN-LIMITATIONS](KNOWN-LIMITATIONS.md) and
[FRONTEND-ADMIN-ROADMAP](FRONTEND-ADMIN-ROADMAP.md).

---

## Maintenance

During maintenance the proxy serves a 503 page from a file flag, so it works
even when the whole stack is down. `/api/health` stays reachable throughout.
