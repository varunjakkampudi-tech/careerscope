# Production Readiness

## Current Release Status

The product is now **CareerScope v1.0.0**. See [release notes](RELEASE-1.0.0.md)
for the local release scope, compatibility details, and UI verification gates.

Application-level hardening and local verification are complete for a single-owner,
same-origin deployment. This is not a claim that every portal is live or that a
public deployment has been validated. No cloud resources, domain, certificate or
paid provider account were created. Docker and nginx are unavailable on the
development machine; image builds and native proxy validation remain release gates.

## Source Verification

A bounded live probe on 2026-09-09 searched for Software Engineer jobs posted in
the last 30 days, without location filtering, with at most two results per source,
a 20-second source budget and no retries. Returned jobs passed normalization with
a title and application URL. No results were inserted into the user's database.

| Source                   | Observed outcome                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------- |
| Greenhouse               | 2 valid jobs                                                                           |
| Ashby                    | 2 valid jobs                                                                           |
| SmartRecruiters          | 2 valid jobs                                                                           |
| Recruitee                | 1 valid job                                                                            |
| Remotive                 | 2 valid jobs                                                                           |
| Himalayas                | 2 valid jobs                                                                           |
| Lever                    | Short probe budget expired; not verified live                                          |
| Workable                 | HTTP 429; rate-limited, no results verified                                            |
| RemoteOK                 | Request timeout; not verified live                                                     |
| Adzuna, Jooble, JSearch  | Credentials absent; signup intentionally skipped                                       |
| Gmail                    | OAuth not configured; prior browser imports are not an ongoing mailbox connector       |
| LinkedIn, Naukri, Indeed | Browser sources disabled in the production-style probe; no live automated-search claim |
| Foundit, Cutshort        | Imported provenance only; no automated provider                                        |

The probe is a small connectivity/schema sample, not comprehensive job coverage
or a per-provider uptime guarantee. Browser-assisted imports already in the app
remain usable; they do not establish that the server can access signed-in portals.
An 85% score filter can hide valid low-confidence/snippet-only results; inspect
the source's fetched/kept counts and lower the threshold when auditing discovery.

Provider warning/error events now populate the per-source summary, not only the
run log. Successful results survive partial failures. Budget expiry is explicitly
labeled partial. A run finishing does not mean every selected source succeeded.
The app must not bypass portal blocks or fabricate results to fill a source.

## Hardening In This Release

- Interrupted application submissions retain an explicit uncertain-outcome flag.
  Retries require a portal-check acknowledgment tied to the latest attempt;
  confirmed submissions are blocked from retrying across the full run history.
- Settings shows the last recorded daily-search queue or pause result, including
  actionable configuration errors. A queued attempt is not a completed search.
- Restored malformed nginx include directives and streaming proxy behavior.
- Proxy overwrites forwarded client IPs; hosted templates trust only that proxy.
- Compose requires an explicit HTTPS `AUTH_ORIGIN` and pins owner login on.
- HTTP bootstrap serves ACME challenges only, returning 503 elsewhere until TLS.
- Production disables the desktop application agent. Copilot application automation
  still requires the local desktop, CLI authentication, and approval workflow.
- Container/systemd file creation uses a private umask; nested runtime data and
  environment files are excluded from the Docker build context.
- Readiness health checks use `/api/health/ready`.
- Optional browser-image startup script is explicitly included in the build context.
- Existing security controls include hashed passwords, revocable HttpOnly JWT
  sessions, Secure production cookies, Origin checks, throttling, no-store API
  responses, CSP, and dependency/route regression tests.

## Release Gates

1. Choose the deployment host and domain; configure DNS and exact HTTPS origin.
2. Create the owner locally, stop the API, and take a consistent backup of the
   SQLite database and resumes. Restore into the production data volume with
   owner-only access and uid/gid appropriate to the runtime. Never copy a live
   SQLite file without a proper backup API or stopping writers.
3. Keep `.env`, database, WAL files and backups private. Backups include the
   password hash, JWT signing key and session records. Prefer clearing restored
   `auth_sessions` before go-live to invalidate pre-deployment sessions.
4. Build and validate on the target host:

   ```sh
   docker compose -f infra/docker-compose.yml config --quiet
   docker compose -f infra/docker-compose.yml build api
   docker compose -f infra/docker-compose.yml up -d
   ```

5. Follow the runbook's certificate issuance steps. Set
   `NGINX_CONFIG=./nginx/job-radar-tls.conf`, replace the example domain in the TLS
   file, recreate nginx, and run `docker compose -f infra/docker-compose.yml exec -T nginx nginx -t`.
6. Verify HTTP redirects to HTTPS after TLS activation, HTTPS readiness is 200,
   anonymous `/api/leads` is 401, owner sign-in works, and logout revokes access.
   Confirm resume upload/download, CSV/XLSX export, search progress streaming,
   source failure messages and no externally reachable port 8080.
7. Run a small real search for each enabled source on the deployment network.
   Confirm quotas and terms before enabling a keyed service. Leave blocked or
   unconfigured sources unavailable; do not claim all portals are operational.
8. Test backup restoration and rollback on a separate volume. Schedule backups,
   certificate renewal, disk monitoring and readiness alerts before public use.

Local verification commands:

```sh
npm run typecheck
npm test
npm run lint
npm run test:ui
npm audit --omit=dev --audit-level=high
```

## Known Limits

The runtime dependency audit reports two moderate advisories through ExcelJS's
transitive `uuid` dependency (GHSA-w5hq-g745-h8pq), and no high/critical advisories
at this check. The suggested automatic fix downgrades ExcelJS across a major
version; it was not applied. Track upstream remediation or test a targeted update
before accepting the residual risk for the intended deployment.

This is a single-owner application, not multi-tenant SaaS. MFA and email password
recovery are not implemented. Current Playwright engine checks are not physical
device tests. Actual TLS, reverse-proxy execution, production network access,
backup restoration, and container image execution still need target-host validation.
