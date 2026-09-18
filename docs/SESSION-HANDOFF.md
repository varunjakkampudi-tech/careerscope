# Session Handoff

Updated: 2026-09-16. V1:1.3.4. V2:incomplete2.0.0-alpha.1.

## Continue On Another Computer

This is the sanitized, portable conversation handoff. This repository is public:
raw chat/debug logs, email content, cookies, tokens, resumes, databases, environment
files and SSH keys must not be committed. Git does not transfer the live Copilot
conversation, its tools/permissions or browser authentication. Start a new chat
and ask it to read this file, `README.md`, `v2/ARCHITECTURE.md` and
`v2/PRODUCT-ACCEPTANCE.md` before continuing. Do not assume the Mac's MCP configuration
or user instructions exist on the new machine.

```sh
git clone --branch feature/v2-local-migration https://github.com/varunjakkampudi-tech/careerscope.git
cd careerscope
code .
```

Use the existing feature branch, not main. Main/V1 are preserved; this checkpoint
is not a release or authorization to deploy. Inspect local edits before pulling
into an existing checkout. Install Node with network-permission support (26.8.1
was tested; the declared >=24 minimum alone does not establish parser compatibility).
Install dependencies with `npm ci` and `npm --prefix v2 ci`, then run
`npm --prefix v2 run build:domain` and `npm --prefix v2 run build:core`.
Read the local setup section of `v2/README.md` before generating configuration,
starting approved Docker services, applying reviewed migrations or setting up an
owner. Enter secrets directly in the new computer's terminal. No real owner-data
migration is approved; source checkout alone does not restore existing data.

The previous Next preview process exited. No working app server, authenticated
browser session or connected Mac inference worker is transferred by this checkout.

## Reopen The Five Pages

In a trusted, local VS Code desktop window, run **Terminal > Run Task >
CareerScope: Open five session tabs**. Alternatively:

```sh
node scripts/open-session-tabs.mjs
```

Requires Node and a desktop browser; Linux also needs `xdg-open`, Windows uses
PowerShell. Run locally, not inside SSH/containers/WSL or the Hostinger server.
This asks the default browser to open each page; window/tab placement depends on
browser preferences. It does not recreate VS Code's shared-browser IDs or tabs
inside an integrated browser. Share the new browser pages with Copilot using the
browser integration available on that computer. Sign in manually; Gmail uses the
first signed-in account, so select the intended account before using the search.
Nothing opens automatically on workspace load and no forms are submitted.

1. [Previous GitHub Actions release run](https://github.com/varunjakkampudi-tech/careerscope/actions/runs/34487640159)
2. [Gmail unread job-message search](https://mail.google.com/mail/u/0/#search/is%3Aunread%20%7Bfrom%3Alinkedin.com%20from%3Anaukri.com%20from%3Aindeed.com%20subject%3Ajob%20subject%3Aopportunity%20subject%3Ainterview%20subject%3Aapplication%7D)
3. [Naukri home](https://www.naukri.com/mnjuser/homepage)
4. [Indeed India](https://in.indeed.com/?from=gnav-viewjob)
5. [LinkedIn posting](https://www.linkedin.com/jobs/view/4465704104/)

Links are navigation bookmarks, not proof a posting is still open or an application
was submitted. Preview the URLs without opening anything using `--print`.

## Current Implementation And Decisions

- Internal versioned resume upload/recovery, restricted PDF/DOCX parser and fenced
  durable results are implemented and tested. No enabled owner upload lifecycle,
  owner review/matching, retention or accepted object-storage runtime yet.
- Durable partial-source search outcomes, retained validated jobs, saved leads,
  truthful exports and failed-source retry are connected. Owner-scoped resumable
  SSE, session revocation, bounded streams and polling fallback are implemented.
- Earlier recorded checks:31 V2 tests,1043 V1 tests, type/lint/build/format gates,
  queue restart/AOF restore and Chromium/Firefox/WebKit320/390/1440 workflows pass.
  Fresh/repeat/populated search upgrades tested with synthetic data. Migrations
  0005-0008 have NOT been applied to the normal V2 database. Verification is not
  proof of production readiness; rerun appropriate gates on the destination host.
- September16 transfer recheck: V1's1043 tests, typecheck, lint, build and formatting
  passed; V2 typecheck, lint, build and formatting passed. The V2 full test rerun was stopped after
  repeated Queue Redis connection failures: Docker was stopped. This rerun is
  blocked, not a new full-suite pass. Restart approved local prerequisites before
  rerunning service-dependent tests on the destination computer.
- Keep upstream-only storage: user declined a RustFS source-patch evaluation.
  Tested RustFSrc6 and SeaweedFS4.47 remain rejected under unchanged private ACL,
  immutable-write/version and deletion guards. No silent fallback or fork.
- User reports purchasing a Hostinger server after discussing KVM2:2vCPU,8GB RAM,
  100GB NVMe. Exact purchased plan, OS, existing workloads, SSH access, deployment
  domain and permission for staging changes still require confirmation.
- Multiple domains are intended. Proposed topology uses one HTTPS reverse proxy
  with isolated apps and a same-origin CareerScope UI/API. Capacity is unverified;
  low worker concurrency, external builds and off-server backups were recommended.
- Proposed optional Mac inference: Mac pulls leased AI work from an authenticated
  VPS HTTPS API, calls loopback Ollama and returns validated fenced results. No
  public11434 port, no inference in Fastify, one approved model/request at a time.
  Offline Mac must not stop deterministic matching. This remote worker protocol
  is NOT implemented;4B/9B benchmark approval and managed-device permission remain.
- Full backlog remains: resume integration, approved AI worker, enrichment/Gmail,
  application approvals, detailed progress/retention, Nginx/TLS, observability,
  public parity, coordinated restore, migration/cutover and mixed-load acceptance.
- Current authorization covers committing/pushing this code and sanitized handoff
  to the existing V2 branch. It does not authorize deployment, domain changes,
  owner-data migration, account/terms acceptance or final job submissions.

Suggested first prompt on the new machine:

> Read docs/SESSION-HANDOFF.md, README.md, v2/ARCHITECTURE.md,
> v2/PRODUCT-ACCEPTANCE.md and the applicable
> repository instructions. Inspect the current branch and local changes. Continue
> from the verified implementation without claiming unfinished features complete.
> Confirm Hostinger details and staging authorization before remote changes.

## Historical September 10 State

The sections below are historical and do not override the September16 status above.
Verified release at that time: v1.3.2, commit `10b0544`.

## Resume State

- The workspace was renamed from `temp` to `careerscope`.
- Maintenance commit `19acff4` coordinates API/frontend development processes,
  preserves intentional migration/seed output, and updates operational guidance.
- Run `npm run dev` from the repository root and keep its terminal open. The API
  uses port 8080 and the frontend uses port 5173. Do not start duplicate servers.
  This command is not a persistent service or an automatic restart policy.
- The recurring session-fetch failure occurred when a separately launched service
  was absent. Both now run together; signed-in session and lead checks returned 200.
- MCP source/status filters and authenticated scheduler diagnostics passed live
  checks. A queued scheduled attempt does not prove successful provider results.
- GitHub Actions run `34487640159` and GitHub Pages deployment succeeded.
  All 26 deployed assets matched the release; public and encrypted-admin workflows
  passed at desktop and mobile widths.
- Verification passed: 998 application tests, 21 Pages checks, three infrastructure
  checks, typecheck, build, formatting, clean lint and three-browser acceptance.

## Remaining Boundaries

- The v2 stack is deployed on a Hostinger VPS and served at `https://careerscope.tech`
  with a Let's Encrypt certificate. Deployment procedures live in `infra/v3`. Do not
  provision further infrastructure or enable additional cloud workflows without approval.
- Real applications require truthful qualifications, duplicate-history checks,
  separate account/terms approval and final-submission approval. No successful
  real application submission is claimed.
- Dependency advisory remediation, Actions upgrades, physical-device and
  screen-reader acceptance, worker authentication and future scheduled-run
  completion remain tracked in
  [the V2 acceptance record](../v2/PRODUCT-ACCEPTANCE.md).
- Check current Git status and running processes before resuming. Do not restore
  older archived files over newer user changes.

## Private Session Archive

The replacement local archive is under:

`data/session-backups/2026-09-10-current/`

It contains earlier session history plus the current available transcript, debug
logs, tool attachments and selected handoff/configuration snapshots. Its
`manifest.json` records captured paths, sizes and SHA-256 hashes. The previous
standalone archive is removed only after replacement checks pass.

The full archive is Git-ignored and owner-access-only. This document is the
sanitized, committable recovery guide; raw conversations and attachments must
not be added to Git or published. No application database, credentials, resumes
or browser authentication storage are copied separately.

Capture is point-in-time: later messages are not included automatically. Native
chat logs are retained where available, but restoring a session in VS Code's
sidebar may require its supported import flow. A new chat can resume by reading
this guide and the local archive; automatic conversation restoration is not promised.
