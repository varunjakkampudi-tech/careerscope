# Employer domain consistency checks

Stage 06 item 6.03 records whether a posting's source-reported employer website
and application URL use the same host, a different host, or a known ATS host.
The check runs locally during normalization; it makes no network or DNS
requests.

When a provider supplies only a listing URL, that URL remains the navigation
fallback for `applyUrl`, but it is not treated as an application destination
for this check. The result is `unknown` until an actual application URL is
provided.

## Statuses

- `same-host`: the normalized hostnames match after removing a leading `www.`.
- `different-host`: both URLs are valid HTTP(S) URLs, the application host is
  not in the known ATS list, and the hostnames differ.
- `ats-hosted`: the application URL is on a recognized ATS host, even when the
  employer website is not available. This is separate from `different-host`
  because an employer website commonly differs from its applicant tracking
  system.
- `unknown`: the employer website or application URL is missing or invalid.

The check stores the two hostnames and status in each collected job. Historical
jobs without this field parse as `unknown`.

## Boundaries and limitations

Both URLs are claims supplied by a job source. A host match does not verify
employer ownership, and a different host does not establish fraud. This signal
does not hide, reject, or lower the match score of a job. It is not yet shown in
the candidate UI; Stage 06 item 6.13 tracks that display.

The comparison is deliberately host-based, not registrable-domain analysis.
Legitimate subdomains can therefore be recorded as `different-host`. The ATS
allowlist covers the supported Greenhouse, Lever, Ashby, Workable,
SmartRecruiters, and Recruitee URL hosts; other legitimate application hosts may
also be classified as `different-host`. The status remains informational and
must be explained as such anywhere it is displayed.

No live employer identity, domain ownership, TLS, redirect destination, source
permission, or application-link liveness is established by this check.
