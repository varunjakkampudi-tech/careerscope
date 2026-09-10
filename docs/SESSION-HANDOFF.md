# Session Handoff

Updated: 2026-09-10. Verified release: v1.3.2, commit `10b0544`.

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

- Docker/EC2 execution and deployment remain deferred. Do not install system
  software, provision infrastructure or enable cloud workflows without approval.
- Real applications require truthful qualifications, duplicate-history checks,
  separate account/terms approval and final-submission approval. No successful
  real application submission is claimed.
- Dependency advisory remediation, Actions upgrades, physical-device and
  screen-reader acceptance, worker authentication and future scheduled-run
  completion remain tracked in [the pending-work checklist](../TEMP-PENDING-WORK.md).
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
