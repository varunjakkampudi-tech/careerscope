# Temporary Pending Work

Updated: 2026-09-16. Root runtime: v1.3.4. V2: incomplete 2.0.0-alpha.1.
Branch: `feature/v2-local-migration`; portable checkpoint, not a release.
This checklist is retained in Git at the owner's request. The September 10 release
record below is historical, not a current deployment claim. Source commit/push is
authorized; deployment and merging into main are not. See
[the portable handoff](docs/SESSION-HANDOFF.md) for destination setup and five tabs.
September16 recheck: V1's1043 tests and both versions' type/lint/build/format gates
passed. V2's full test rerun was stopped because Docker/Queue Redis was unavailable;
the31-test and browser results below are earlier evidence, not a fresh rerun.

## Current V2 Implementation

- [x] Durable partial-source outcomes: validated retained jobs, exact selected
      sources/counts, explicit partial/failed states, fixed error codes and atomic
      fenced settlement. Handled source failures do not retry as transport failures.
- [x] Partial-result API/UI: source outcomes, saved leads, truthful JSON export and
      retry of failed sources into a new immutable run.
- [x] Owner-scoped resumable SSE: bounded/indexed replay, fenced running transition,
      native browser reconnect, polling fallback, session revocation, connection/rate
      limits and shutdown cleanup. Detailed live source events, retention/reset and
      Nginx/TLS acceptance remain separate work.
- [x] Migrations0007/0008: fresh/repeat and populated0006 upgrades tested on disposable
      databases; no normal/owner migration. Competing start/terminal writes tested.
- [x] Latest verification:31 V2 tests and type/lint/build/format; SQS/PG integration,
      BullMQ execution policy and queue restart/AOF/process check; three browsers at
      320/390/1440 including SSE and targeted retry; screenshots reviewed.
      Root1043 tests plus typecheck/lint/build/format pass.
- [x] Internal upload coordinator: server-computed metadata, bounded copied body,
      private readiness, verified exact-version storage and atomic parse scheduling.
      Lost PUT responses/SQL failures recover without overwrite or extra versions;
      explicit owner-scoped reconciliation leaves missing objects pending.
- [x] Restricted parser child and durable handler: real synthetic PDF/DOCX extraction,
      30-second deadline, 192 MiB V8 old-space, no inherited secrets/network/writes/
      native addons/child spawning. Node network-permission support is required;
      verified on Node 26.8.1. This is not a complete sandbox or total RSS limit.
- [x] DOCX preflight: 200 entries, 20 MiB expansion, 100:1 ratio, validated sizes,
      required parts, encrypted/macro/embedded entries rejected. PDF 50-page bound,
      text 160,000 characters and IPC 1 MiB. Native canvas permissions remain disabled.
- [x] Additive migration `0006_amazing_ares`: owner-scoped bounded parse results,
      fenced atomic completion, rollback and fixed invalid/processing failure codes.
      Real SQS delivery, duplicate/exhaustion and DOCX upload-to-result checks pass;
      parsing never changes profile facts. Normal V2 database was not migrated.
- [x] Previous resume-only verification: 29 V2 tests, typecheck/lint/build/format, isolated queue
      process/restart/AOF restore and runtime audit (zero known advisories). Focused
      corruption, cancellation, archive and PDF page-bound tests pass. Root/browser
      gates were not rerun. No owner uploads or persistent parser runtime enabled.
- [x] Private versioned S3 adapter: explicit local configuration, private-bucket
      readiness, 5 MiB bound, SHA-256, immutable writes and version-specific reads/deletes.
      Synthetic HTTP and LocalStack checks pass; this is not real-runtime acceptance.
- [x] Runtime-neutral `S3_*` configuration, complete legacy `MINIO_*` compatibility,
      conflicting/partial configuration rejection. V2 remains 5 MiB (5,242,880 bytes),
      intentionally separate from V1's 10 MiB; no private configuration changed.
- [x] Evaluate two maintained Apache-2.0 ARM64 candidates using pinned images and
      disposable local Docker resources. SeaweedFS 4.47 passed lifecycle/concurrent
      writes/anonymous and wrong-secret denial, but failed empty-bucket cleanup with
      nonempty deletion disabled. RustFS 1.0.0-rc.6 failed owner/grantee ACL identity
      validation and is a prerelease. Neither accepted; exact digests are in the
      V2 architecture document. Test containers/volumes/network removed.
- [x] Upload metadata reservations and additive migration `0005`: owner-scoped
      idempotency, database-enforced metadata bounds and immutable version binding.
      PostgreSQL stores metadata only, not binary resumes.
- [x] Atomic stored-upload transition: row lock, one `resume.parse` outbox command,
      concurrent retries, version conflict rejection and rollback at both writes.
      This internal method requires trusted verification of the stored object first.
- [x] Filter outbox scans by configured queue routes before limiting the batch;
      pending unsupported parse commands no longer starve searches.
- [x] V2 verification: 28 tests, typecheck, lint, build, format, isolated queue
      restart/AOF restore/process lifecycle. Migration `0005` tested on disposable
      fresh databases and repeat migration only; normal V2 database unchanged.
      Latest storage-only continuation reran 28 tests and type/lint/build/format;
      queue process/restart, root and browser checks remain previous-pass evidence.
- [x] Previous pass: profile navigation/sign-out/unload guards and keyboard skip
      navigation; Chromium/Firefox/WebKit workflows and reviewed mobile/desktop screenshots.
- [x] Previous pass: root ExcelJS-only UUID 11.1.1 override and XLSX regression;
      root/V2 runtime audits clean. Root 1,043 tests, 21 Pages tests, three runtime
      guards and browser/static/build gates passed. Not rerun in this backend-only continuation.
- [x] Context, V2 README and architecture status updated. GitHub About was updated
      in the previous pass; no new external metadata changes in this continuation.

## Next V2 Gates

- [ ] Select and validate a maintained private object-storage runtime. MinIO's
      upstream repository is archived and unmaintained; the attempted image pull
      failed. Do not silently use old mirrors, accept licenses or activate paid services.
      Retest corrected candidate builds without relaxing privacy or deletion guards.
      RustFS rc6 source hardcodes the missing ACL grantee ID; this is not repairable
      through local credential settings. A storage fork is a separate decision.
      User explicitly chose upstream-only runtimes; no patched-build evaluation is
      authorized. Latest releases remain the rejected rc6/4.47 candidates.
      Storage-dependent activation remains blocked.
      Both candidates still require persistence/restart and exact-version backup/restore
      acceptance; no production candidate or upload workflow is enabled.
- [ ] Expose the tested internal coordinator through bounded authenticated API/UI
      with owner/origin/CSRF checks and aggregate admission limits, only after runtime
      acceptance. Never trust client object-version claims. No upload API is enabled.
- [ ] Schedule unattended reconciliation and implement retention/version deletion;
      explicit ambiguous-write and interrupted-reservation recovery is now tested.
- [ ] Activate a dedicated parser worker and publisher route after storage acceptance;
      handler, isolation and durable retry/fencing/results are tested internally.
      OS/container CPU/RSS/egress and long-running process acceptance remain pending.
- [ ] Owner-approved resume facts into immutable matching snapshots; do not infer
      or overwrite qualifications without review.
- [ ] Coordinated PostgreSQL/object/configuration/encryption-material restore.
      Populated search-schema upgrade is now tested, not a full topology restore
      or permission to migrate the real owner.
- [ ] Benchmark/model approval and dedicated AI worker; 4B prior smoke is not
      application approval, 9B remains unapproved. Keep inference outside Fastify.
- [ ] Enrichment, Gmail/provider parity, approval-gated application worker,
      detailed live source progress, SSE retention/reset and Nginx/TLS acceptance,
      observability and V2 theme/accessibility parity.
- [ ] SQLite-to-PostgreSQL cutover rehearsal, sustained mixed-workload soak and
      full V2 acceptance. Existing tests do not establish 100% completion.

## Historical September 10 Release

The remaining sections preserve the v1.3.1 release record and its original follow-up
checklist. Current local Docker verification and the resolved UUID advisory above
supersede their older blocker statements. EC2/public deployment remains deferred.

### Release State

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
- [x] Resolved September 15: scoped UUID 11.1.1 override, no ExcelJS downgrade;
      workbook round-trip and export route regression passed, runtime audit clean.
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
