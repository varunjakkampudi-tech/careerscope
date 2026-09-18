# Testing

Which command proves which claim. The rule: **compilation is not readiness**,
and a claim without a command behind it is not evidence.

Never delete or weaken a test because it fails. Never edit a test to mask a
regression. Never disable a lint, type or test rule to get CI green.

---

## Start here

For a focused change, run the nearest test first. A full matrix run on every
edit wastes time and teaches you nothing about your change.

For broad changes or a release, run everything below.

---

## Root workspace (V1)

Run from the repository root.

| Command                        | Proves                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `npm test`                     | Vitest suite — 1046 passed, 1 skipped                                                  |
| `npm run typecheck`            | Project references, plus both test tsconfigs                                           |
| `npm run lint`                 | ESLint across the workspace                                                            |
| `npm run format:check`         | Prettier                                                                               |
| `npm run build`                | All packages and both apps compile                                                     |
| `npm run pages:test`           | GitHub Pages export, snapshot crypto, admin session, staging and publishing — 21 tests |
| `npm run pages:workspace:test` | Public workspace snapshot integrity                                                    |
| `npm run pages:visual`         | Pages visual baselines                                                                 |
| `npm run test:ui`              | Browser UI checks                                                                      |
| `npm run test:full-disk`       | Resume storage under a genuinely full disk                                             |
| `npm run skills:check`         | Agent skill manifests — 20 valid                                                       |
| `npm audit --omit=dev`         | Production dependency advisories                                                       |

## V2 workspace

Run from `v2/`.

| Command                          | Proves                                  |
| -------------------------------- | --------------------------------------- |
| `npm test`                       | `node:test` suite — 47 tests            |
| `npm run typecheck`              | `tsc -b`, Next typegen, web tsconfig    |
| `npm run lint`                   | ESLint including the web workspace      |
| `npm run format:check`           | Prettier                                |
| `npm run build`                  | Core plus the Next app                  |
| `npm run test:queue-runtime`     | The queue contract against a real queue |
| `npm run test:database-recovery` | Database recovery behaviour             |
| `npm run test:crash-recovery`    | **Real SIGKILL crash matrix**           |
| `npm run test:performance`       | Declared sustained workload             |
| `npm run test:soak`              | Long-running stability                  |
| `npm run test:ui`                | Browser UI checks                       |

`npm test` and most of the above need the local services up:

```bash
npm run services          # postgres, redis, localstack
npm run db:migrate
```

---

## The crash matrix

`npm run test:crash-recovery` sends **real** `SIGKILL`s. It is not mocked, and
it must not be replaced with mocks. It covers four cases:

1. upload killed during publication
2. publisher killed after the queue send but before the database acknowledgement
3. publisher killed after exclusive publication but before the state update
4. worker killed while holding a live lease

What it asserts: durable convergence, no duplicate publication, no corruption,
correct fencing, lease recovery and idempotency.

## Full-disk storage

`npm run test:full-disk` fills a real filesystem. The contract:

- `put()` raises a typed `ResumeStorageLimit`, surfaced as **507**
- `cancelUpload()` succeeds when the cancellation marker fits, and raises
  `ResumeStorageLimit` when it does not — leaving the upload in `uploading`
- a retry succeeds once capacity returns
- afterwards: `strandedTemporaries = 0`, `reservedBytesAfterFailure = 0`

Cancellation markers are authoritative. They are counted, observable and
governed by quota. **Never delete them by age.**

---

## Accessibility

Automated, across Chromium, Firefox and WebKit at 320, 390 and 1440 px:

- axe — WCAG 2.0 and 2.1, levels A and AA, zero violations
- accessibility-tree assertions
- keyboard-only traversal

This is strong evidence. It is **not** a screen-reader test, and it must never
be reported as one. See [KNOWN-LIMITATIONS](KNOWN-LIMITATIONS.md).

---

## Live verification

Against `https://careerscope.tech`, from `infra/v3`:

| Script                   | Proves                                                         |
| ------------------------ | -------------------------------------------------------------- |
| `check-provenance.sh`    | The deployed revision agrees in all four places                |
| `check-live-origin.sh`   | Cookie attributes, CSRF origin check, proxy header handling    |
| `check-host-firewall.sh` | 14 firewall and Docker networking assertions                   |
| `check-maintenance.sh`   | Maintenance mode, including that `/api/health` stays reachable |
| `check-owner-login.sh`   | Owner sign-in                                                  |
| `check-live-flow.mjs`    | Full public end-to-end flow — 23 checks                        |
| `scan-images.sh`         | Trivy scan of both images with a clean cache                   |

`check-live-flow.mjs` creates an account, so it requires registration to be
temporarily enabled. Afterwards:

```bash
bash purge-verification-accounts.sh    # removes the verify-* namespace only
# then set REGISTRATION_ENABLED=false again
```

**Never leave registration enabled.** Never run destructive tests against owner
data.

---

## Performance

`npm run test:performance` runs the declared workload: 8 concurrent readers, 30
seconds, authenticated read routes, zero failures, explicit thresholds. It
asserts rather than merely printing numbers.

These are single-host figures on a 2 vCPU VPS. They are a regression guard.
**They are not a production SLO** and must not be quoted as one.

---

## Reporting results

State what was run, what passed, and what remains unverified. Do not carry
forward an old result for a test that the current change could affect. Do not
hide a skipped test, a missing prerequisite or an external-service failure.
