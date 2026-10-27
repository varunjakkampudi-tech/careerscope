# Application tracking

`/applications` uses the shared saved-job workspace and owner-scoped lead API.
It filters persisted records to `applied`, `interviewing`, `offer`, `rejected`
and `withdrawn`. `/saved` shows `saved` and `archived` records. Both surfaces
use the same revision-controlled notes, status updates and history.

The current persisted status vocabulary is `saved`, `applied`, `interviewing`,
`offer`, `rejected`, `withdrawn` and `archived`; see
`packages/core/src/leads.ts`. `withdrawn` is a candidate-entered lifecycle
status, not an employer or ATS event.

When a candidate records `applied`, CareerScope stores a candidate-reported
claim containing method, reported time, confirmation, source and confidence.
These values describe what the candidate entered; they do not verify a
submission or employer response. Application evidence is preserved in revision
history and cannot be silently removed. Archiving and restoring a lead are
organizational actions and preserve any existing application report. Existing
legacy lifecycle records without a report remain readable and editable; a new
lifecycle transition requires an explicit candidate report. The report's
timestamp must be a valid offset-bearing ISO datetime and cannot be in the
future.

Candidates explicitly change their records. Opening a source or application
destination does not mark the job applied. No application-submission bot,
browser credential automation or inferred employer outcome is part of this
workspace. Confirmation and confidence are candidate statements, not
provider-verified facts.

Writes require the authenticated owner's session, Origin/CSRF validation and
the current revision. A stale revision returns a conflict instead of replacing
another edit. Details deep links use `?lead=<id>` on the canonical saved or
applications route; they do not imply a separate details-page implementation.

See [API contracts](API-SURFACE.md), [data model](DATA-MODEL.md) and
[product boundaries](PRODUCT.md).
