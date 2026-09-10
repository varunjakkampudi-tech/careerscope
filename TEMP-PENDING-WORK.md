# Temporary Pending Work

Updated: 2026-09-10. Baseline: CareerScope v1.3.0, commit `a231f63`.
This is a reviewed handoff checklist retained in Git at the owner's request.
The baseline results below describe v1.3.0, not future deployment verification.

## Current State

- GitHub Pages is deployed; CI run `34467130374` succeeded.
- Public: https://varunjakkampudi-tech.github.io/careerscope/
- Admin: https://varunjakkampudi-tech.github.io/careerscope/admin.html
- Release verification passed: 998 application tests, 21 Pages tests, three
  infrastructure tests, typecheck, formatting, build and browser acceptance.
- All 26 live assets matched the release. Live public saved-job filtering and
  encrypted-admin unlock/reload/lock passed at 320, 390 and 1440 pixels.
- Linux Firefox/WebKit exposed a narrow header overlap during release; it was
  fixed and the remote browser checks passed before deployment.
- Pages serves static snapshots only. API, collection and Copilot remain local.
- No confirmed real application submission has been completed.

## Ready For Local Follow-Up

- [ ] Update stale CI comments in `.github/workflows/ci.yml`: verification now
      launches real browsers, not only mocked pages or container smoke tests.
      Check YAML parsing and formatting; do not change job behavior for this cleanup.
- [ ] Consolidate `docs/RELEASE-REVIEW.md` with the final v1.3.0 deployment result
      and Linux header fix. Retain its limited manual-review scope and deferred gates.
- [ ] Review GitHub Actions Node 20 deprecation warnings. Check supported action
      releases and runner requirements, including the upload-pages-artifact dependency,
      before upgrading. Acceptance: full CI and Pages artifact/deployment checks pass.
- [ ] Resolve the three existing console lint warnings in API migration/seed
      scripts without removing useful command output. Run lint and isolated migration
      and seed checks against disposable data, never the owner's database.
- [ ] Rerun `npm audit --omit=dev` and triage current results. Earlier notes mention
      moderate ExcelJS/uuid advisories; their present status was not rechecked here.
      Do not use a forced dependency downgrade. Verify export behavior after changes.
- [ ] Confirm the running MCP process loads the committed source/status filter
      fix. Its protocol regression test passed, but an older process may need restarting.
      Acceptance: filtered `list_leads` calls return only the requested source/status.
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
- [ ] Confirm the local daily scheduler's next eligible run while the Mac/API are
      awake. Pages does not run collection or auto-refresh snapshots; review and publish
      new exports when a public update is intended.

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
