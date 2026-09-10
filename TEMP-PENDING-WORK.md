# Temporary Pending Work

Updated: 2026-09-10. Deployed baseline: CareerScope v1.3.1, commit `0904377`.
This is a reviewed handoff checklist retained in Git at the owner's request.
The release results below describe v1.3.1. Follow-up edits are local until committed
and independently verified for publication.

## Current State

- GitHub Pages is deployed; CI run `34470638235` succeeded.
- Public: https://varunjakkampudi-tech.github.io/careerscope/
- Admin: https://varunjakkampudi-tech.github.io/careerscope/admin.html
- Release verification passed: 998 application tests, 21 Pages tests, three
  infrastructure tests, typecheck, formatting, build and browser acceptance.
- All 26 live assets matched the release. Live public saved-job filtering and
  encrypted-admin unlock/reload/lock passed at 320, 390 and 1440 pixels.
- The release contains 2,183 public jobs and 2,510 encrypted private leads;
  the existing admin passphrase was retained.
- The v1.3.0 Linux header overlap was fixed. The v1.3.1 retry also passed after
  browser acceptance waited for shortlist requests before reload/navigation.
- Pages serves static snapshots only. API, collection and Copilot remain local.
- No confirmed real application submission has been completed.

## Ready For Local Follow-Up

- [x] Restore local session fetching after the folder rename by running API and
      frontend together with root `npm run dev`. Added sibling shutdown on command
      exit; synthetic success/failure lifecycle checks passed. Authenticated session,
      health, lead counts and scheduler diagnostics return HTTP 200.
- [x] Correct stale browser comments in `.github/workflows/ci.yml`. Parsed YAML
      matches the committed workflow exactly; formatting passed. No job behavior changed.
- [x] Consolidate `docs/RELEASE-REVIEW.md` with v1.3.1 deployment evidence and the
      earlier Linux header fix, retaining the limited manual-review scope.
- [x] Review available Node 24 Actions releases: checkout v7.0.1, setup-node v7.0.0,
      upload-pages-artifact v5.0.0 (nested upload-artifact v7.0.0), configure-pages
      v6.0.0 and deploy-pages v5.0.1. No versions changed in this follow-up.
- [ ] Upgrade Actions in a separate verified change after checking runner and
      compatibility requirements. Acceptance: remote CI and Pages deployment pass.
- [x] Resolve three CLI lint warnings through an exact-file console.log allowance
      for migration/seed; service restrictions remain. Repository lint is clean.
      Disposable-data checks passed: migration/repeat, seed/skip/force and missing-file
      failure exit/stderr. CLI behavior and owner data are unchanged.
- [x] Rerun `npm audit --omit=dev`: two moderate entries, zero high/critical, from
      GHSA-w5hq-g745-h8pq via ExcelJS 4.4.0 -> uuid 8.3.2. Installed ExcelJS uses v4,
      not the affected v3/v5/v6 buffer APIs. Synthetic XLSX/CSV checks passed.
- [ ] Track the unresolved UUID advisory and an upstream-compatible fix. No forced
      ExcelJS downgrade or unverified major UUID override was applied.
- [x] Recheck the attached MCP process after reopening the renamed workspace.
      LinkedIn/new reports 247 matches and returned only LinkedIn/New leads;
      LinkedIn/saved returns zero. The previous stale-process filter failure is cleared.
- [x] Verify authenticated scheduler diagnostics: daily 07:00 Asia/Kolkata,
      interval 1440 minutes, persisted queued attempt on 2026-09-10 at 02:10:53 UTC.
      No schedule was changed or search manually triggered. Next eligible daily
      window is 2026-09-11 at 07:00 Asia/Kolkata, subject to process/queue availability.
- [ ] Extend manual review to unchanged files if a full line-by-line audit is
      required. Previous work inventoried the repo but concentrated deep review on
      changed and high-risk paths. Track specific findings rather than blanket cleanup.

## Requires Owner Or External Access

- [ ] Perform physical-phone and screen-reader acceptance for public/admin and
      the local workspace: focus order, labels, filter controls, tables, errors and lock.
      Automated desktop browser emulation is not a substitute for these checks.
- [ ] Verify one real job application under supervision: confirm exact role,
      truthful qualifications, eligibility and prior application history first.
      Ask separately before each account/terms step and before final submission.
      Record Applied only after an unambiguous portal confirmation; stop on uncertainty.
      The previous Indeed Apply button did not open a form, even with a manual click.
- [ ] Decide whether the isolated worker needs Gmail OAuth. Shared-browser Gmail
      and worker Gmail are separate paths; the optional reader is not proven with a
      real authorized mailbox. Configure secrets directly, never in this checklist.
      Verify exact sender/recipient, freshness, ambiguity rejection and OTP redaction.
- [ ] Recheck live provider availability and missing credentials when needed.
      Mocked adapter tests do not establish live access. Record rate limits, bot checks
      and partial results explicitly; do not sign up for services without approval.
- [ ] Observe completion of the next eligible scheduled run while the Mac/API are
      awake. Diagnostics are now accessible and show a prior queued attempt, not
      proof of successful provider results. Pages does not run collection or refresh
      snapshots; review and publish new exports when a public update is intended.

## Blocked Until Docker And EC2 Are Approved

Do not install a runtime on the office Mac, enable cloud deployment or provision
resources without approval. EC2 remains manual-only and disabled.

- [ ] On an approved Docker host, build and boot `api`, `api-scrape` and `api-apply`.
      Current optional container CI covers the first two, not the application target.
      Verify non-root startup, API readiness and headed Chromium, not just image builds.
- [ ] Test the application Compose override: persistent Copilot authentication,
      VNC password guards, SSH-only viewer access, volume ownership and shared memory.
- [ ] Exercise browser sandbox and network-egress isolation on the target kernel.
      Test VNC/CLI/browser crashes and API restart during an application; uncertain
      outcomes must not cause duplicate submissions or false Applied statuses.
- [ ] Before enabling `.github/workflows/deploy-ec2.yml`, deploy an exact verified
      commit rather than moving main, select the intended Compose override, and check
      readiness through the actual TLS/proxy path rather than HTTP alone.
- [ ] Provision approved EC2 capacity, domain/TLS and restricted security groups.
      Verify owner login, Secure cookies, proxy/SSE behavior and private data access.
- [ ] Test backup/restore and rollback using disposable data before migrating real
      SQLite data, resumes and authenticated browser state. Keep secrets out of Git.
- [ ] Run the acceptance gates in `docs/EC2-APPLICATIONS.md` and record evidence
      before describing the remote application worker as production-ready.

## Handling This File

- This temporary checklist is committed as reviewed documentation; it contains no
  credentials and is not part of the allowlisted GitHub Pages artifact.
- The publisher rejects uncommitted changes and untracked files. Commit reviewed
  checklist updates before publication; do not weaken the clean-worktree guard.
- Do not rerun publication just to retry a failed push: push the existing release
  commit after resolving the failure to avoid an unintended extra version bump.
- Reference docs: `docs/RELEASE-REVIEW.md`, `docs/EC2-APPLICATIONS.md`,
  `docs/APPLICATIONS.md`, `docs/RUNBOOK.md` and `docs/ENCRYPTED-ADMIN.md`.
