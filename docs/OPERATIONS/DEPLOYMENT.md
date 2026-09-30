# Operations — Deployment

Deployment is: build an archive **from a committed revision**, ship it, build
images labelled with that revision, bring the stack up, then prove that every
answer to "what is deployed" agrees.

Never deploy from a dirty working tree. Never `scp` a hand-edited file onto the
host — provenance checking exists because that has happened.

---

## Scripts

All under [infra](../../infra).

| Script                           | Purpose                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| `provision-host.sh`              | Prepares a fresh Ubuntu 24.04 host. Idempotent. Installs Docker from Docker's repository.         |
| `ship.sh`                        | Ships a build context to the host. **Preserves `infra/.env`.**                                    |
| `build-images.sh`                | Builds both images, recording the source revision in each                                         |
| `deploy.sh`                      | Brings the stack up. Generates secrets on the host; they never leave it.                          |
| `apply-migrations.sh`            | Applies pending migrations and reports the publisher's hot query plan                             |
| `restart-stack.sh`               | **The only supported way to restart the proxy**                                                   |
| `maintenance.sh`                 | Proxy-level maintenance page: `enable` / `disable` / `status`                                     |
| `check-provenance.sh`            | Asserts the deployed revision agrees everywhere                                                   |
| `check-live-origin.sh`           | Verifies cookie attributes, CSRF origin check, proxy headers                                      |
| `check-host-firewall.sh`         | Firewall and Docker networking assertions                                                         |
| `scan-images.sh`                 | Trivy scan of both images with a clean cache                                                      |
| `purge-verification-accounts.sh` | Removes `verify-*` throwaway accounts                                                             |
| `setup-monitoring.sh`            | Installs the host monitor (systemd timer). See [MONITORING.md](MONITORING.md)                     |
| `monitor.sh`                     | The monitor itself — unreachable/unhealthy/stopped/stale/ok, alerts on change                     |
| `check-monitoring.sh`            | Proves the monitor's classification and alerting logic against stub `docker`/`curl`               |
| `setup-backup.sh`                | Installs the host backup job (systemd timer). See [BACKUP.md](BACKUP.md)                          |
| `backup.sh`                      | Dumps, verifies by restoring into a scratch database, promotes, retains                           |
| `check-backup.sh`                | Proves the pipeline against a real disposable Postgres container                                  |
| `setup-discovery.sh`             | Installs the scheduled-discovery timer. See [DISCOVERY-SCHEDULE.md](DISCOVERY-SCHEDULE.md)        |
| `setup-lead-lifecycle.sh`        | Installs the liveness/retention timers. See [LEAD-LIFECYCLE.md](LEAD-LIFECYCLE.md)                |
| `setup-proxy-recovery.sh`        | Installs the proxy split-brain detector/auto-recovery. See [PROXY-RECOVERY.md](PROXY-RECOVERY.md) |
| `recover-proxy.sh`               | The detector/recovery itself - confirms an outage, runs `restart-stack.sh`, circuit-breaks        |
| `check-proxy-recovery.sh`        | Proves the confirm-then-act-then-cooldown state machine against stub `curl`/`restart-stack.sh`    |

---

## Normal deployment

The supported release path is the GitHub Actions **Deploy** workflow. It has
only a `workflow_dispatch` trigger. Supply the reviewed branch, tag, or full
commit SHA in `ref` and select `production`; protected-environment approvals
and secrets apply. The workflow resolves the ref once, requires a successful CI
run for that exact SHA, builds an archive from that commit, and verifies live
provenance. A push to `main` runs CI but never deploys.

The commands below document the equivalent operator procedure for recovery.
They are not an automatic release path and do not replace the exact-revision CI
gate.

```bash
# 1. Commit. The archive comes from a revision, not from the working tree.
git status --porcelain     # must be empty
REV=$(git rev-parse HEAD)
git archive --format=tar.gz -o deploy.tgz "$REV"

# 2. Ship. This preserves the host's .env and records the revision.
scp -i ~/.ssh/careerscope_deploy deploy.tgz root@201.18.193.230:/tmp/
ssh -i ~/.ssh/careerscope_deploy root@201.18.193.230 \
  "bash /opt/careerscope/infra/ship.sh /tmp/deploy.tgz $REV"

# 3. Build with provenance, migrate, bring up.
ssh -i ~/.ssh/careerscope_deploy root@201.18.193.230 "
  cd /opt/careerscope/infra &&
  bash build-images.sh $REV &&
  bash apply-migrations.sh &&
  docker compose -f compose.production.yml up -d --wait
"

# 4. Prove it.
ssh -i ~/.ssh/careerscope_deploy root@201.18.193.230 \
  "bash /opt/careerscope/infra/check-provenance.sh $REV"
```

For a deployment expected to take more than a few seconds, enable maintenance
mode first:

```bash
bash maintenance.sh enable "Deploying" "about 5 minutes"
# ... deploy ...
bash maintenance.sh disable
```

The maintenance flag is a **file**, not application state, so the page still
serves while the stack is down. `/api/health` stays reachable throughout.

---

## One-time follow-up required for the CS-28 release

CS-28 ("two different openings can be merged into one") changed how a job
posting's identity is computed and added `npm run db:backfill-job-sightings`
(`scripts/backfill-job-sightings.ts`) to recompute `job_sightings` from
`search_jobs` under the corrected rule. It is idempotent and safe to re-run,
but it is **not** wired into `apply-migrations.sh` and must be run once,
manually, the first time this release reaches production — after migrations,
before traffic resumes:

```bash
ssh -i ~/.ssh/careerscope_deploy root@201.18.193.230 "
  cd /opt/careerscope/infra &&
  docker exec careerscope-api-1 node --import tsx /app/scripts/backfill-job-sightings.ts
"
```

Corrected 2026-09-23: the `bootstrap` service's compose definition only
mounts `bootstrap.mjs` (`volumes: ['private:/private',
'./bootstrap.mjs:/app/bootstrap.mjs:ro']`), not the rest of `CareerScope/scripts` —
the original `docker compose run --rm --no-deps bootstrap ...` form here
would have failed with "file not found" the first time anyone actually ran
it. `backfill-job-sightings.ts` (and CS-26's `run-scheduled-discovery.ts`)
are now copied into the runtime image in `infra/Dockerfile`, and the
corrected command targets the always-running `api` container via
`docker exec` instead, matching how CS-24/CS-25's own scripts reach the
database. This gap was caught while implementing CS-26, before this step had
ever been exercised against production, and this file's edit is the fix.

See `docs/KNOWN-LIMITATIONS.md` for what this does and does not fix (it stops
future drift; a false merge that predates CS-28 keeps its inflated evidence
permanently, which is a disclosed, accepted limitation, not an oversight).
Remove this section once the step has been exercised against production for
this release.

---

## One-time follow-up required for the CS-24 release

CS-24 ("nothing watches the running system") adds a host-native monitor that
must be installed once, manually, on the production host — it is
intentionally not part of `apply-migrations.sh` or the deploy sequence, since
it is host state (a systemd timer), not application state:

```bash
ssh -i ~/.ssh/careerscope_deploy root@201.18.193.230 "
  cd /opt/careerscope/infra &&
  bash setup-monitoring.sh
"
```

Then set `MONITOR_WEBHOOK_URL` in `/etc/careerscope-monitor.env` on the host
and re-run `setup-monitoring.sh` (idempotent) so the timer picks it up. See
[docs/OPERATIONS/MONITORING.md](MONITORING.md) for the full design, the
manual "stop a container and observe" proof this ticket's acceptance criteria
require, and the known limitation (nothing currently watches the watcher).
Remove this section once the step has been exercised against production.

---

## One-time follow-up required for the CS-25 release

CS-25 ("no scheduled database dump exists, even on the host") adds a
host-native daily backup, same reasoning as CS-24: it is host state, not
application state, so it is installed once, manually, not via
`apply-migrations.sh`:

```bash
ssh -i ~/.ssh/careerscope_deploy root@201.18.193.230 "
  cd /opt/careerscope/infra &&
  bash setup-backup.sh
"
```

`setup-backup.sh` runs one real backup immediately (dump, restore-verify,
promote) so the first proof doesn't wait for 03:30. See
[docs/OPERATIONS/BACKUP.md](BACKUP.md) for the full design, how to actually
restore from a produced dump, and the known limitation (nothing currently
watches the watcher — shared with CS-24). Remove this section once the step
has been exercised against production.

---

## One-time follow-up required for the CS-26 release

CS-26 ("nothing runs discovery on a schedule") adds a scheduled-discovery
timer, same reasoning as CS-24/CS-25 - host state, installed once manually:

```bash
ssh -i ~/.ssh/careerscope_deploy root@201.18.193.230 "
  cd /opt/careerscope/infra &&
  bash setup-discovery.sh
"
```

Installing the timer does **not** turn discovery on for anyone - it defaults
off per owner and stays off until explicitly enabled (see
[DISCOVERY-SCHEDULE.md](DISCOVERY-SCHEDULE.md) for why, and how to enable it
for now with no UI). Remove this section once the step has been exercised
against production.

Also corrected as part of this release: the CS-28 follow-up step above used
to invoke `docker compose run --rm --no-deps bootstrap ...`, which would have
failed - `bootstrap`'s compose definition only mounts `bootstrap.mjs`, not
the rest of `CareerScope/scripts`. Both `backfill-job-sightings.ts` and this ticket's
`run-scheduled-discovery.ts` are now copied into the runtime image
(`infra/Dockerfile`), and the corrected command targets the
always-running `api` container via `docker exec` instead.

---

## One-time follow-up required for the CS-27 release

CS-27 ("postings never expire or get re-checked") adds two host-native
timers - lead liveness checking and search-results retention - same
reasoning as CS-24/25/26:

```bash
ssh -i ~/.ssh/careerscope_deploy root@201.18.193.230 "
  cd /opt/careerscope/infra &&
  bash setup-lead-lifecycle.sh
"
```

See [LEAD-LIFECYCLE.md](LEAD-LIFECYCLE.md) for the full design and the
SSRF-hardening rationale. Remove this section once the step has been
exercised against production.

Also caught and fixed while building this: `infra/Dockerfile.dockerignore`
is an **allowlist** (`**` first, then specific paths un-ignored) - CS-26's
own new scripts had been added to the `Dockerfile`'s `COPY` instructions but
never to this allowlist, which would have made those `COPY` steps fail
during an actual image build (the files would never have reached the build
context at all), not merely at runtime as the CS-28 fix above assumed. Caught
by actually building the runtime image locally rather than only trusting the
Dockerfile edit, and confirmed by running the built image and listing
`/app/scripts` directly. Fixed by adding all four scripts
(`backfill-job-sightings.ts`, `run-scheduled-discovery.ts`,
`check-lead-liveness.ts`, `enforce-search-retention.ts`) to the allowlist.

Also fixed: CS-26 added a required `origin` field to every search-creation
call, and the same real build caught `apps/web/src/app/page.tsx`'s two
existing search-trigger call sites (`next build`'s own type check, which
`tsc`/ESLint alone do not run) - both are genuinely user-initiated clicks, so
both now explicitly pass `origin: 'manual'`.

**Neither this v3 Docker build nor the images it produces run in CI** - the
`image` job in `.github/workflows/ci.yml` builds `infra/Dockerfile` (the
legacy previous implementation image), not `infra/Dockerfile`. This gap already exists
independent of CS-27 and matches CS-9's own tracked scope; verifying a v3
image build is currently a manual step, which is what caught the two defects
above.

---

## One-time follow-up required for the CS-3 release

CS-3 ("proxy restart strands every service behind a healthy-looking 502")
adds host-native proxy split-brain detection and auto-recovery, same
reasoning as CS-24/25/26/27:

```bash
ssh -i ~/.ssh/careerscope_deploy root@201.18.193.230 "
  cd /opt/careerscope/infra &&
  bash setup-proxy-recovery.sh
"
```

See [PROXY-RECOVERY.md](PROXY-RECOVERY.md) for the full design (a System
Designer review evaluated five options before any code was written) and the
literal "kill Caddy and observe the automatic recovery" proof this ticket's
own acceptance criteria require. Remove this section once the step has been
exercised against production.

---

## Provenance

`check-provenance.sh` asserts four values are equal:

1. `DEPLOYED_COMMIT` recorded on the host
2. the OCI revision label on the runtime image
3. the OCI revision label on the proxy image
4. the revision reported by the running API

This exists because they once disagreed: `DEPLOYED_COMMIT` claimed one revision,
the runtime label carried an older one, the proxy image had no label at all, and
files on disk had been patched in by hand. **Provenance that is not checked is
decoration.**

A commit that touches only documentation, shell scripts or tests is not
runtime-affecting and does not require a redeploy — but the divergence must be
stated, not hidden.

---

## Restarting

```bash
bash /opt/careerscope/infra/restart-stack.sh
```

Restarting the proxy on its own is an outage. Docker gives it a fresh network
namespace and leaves every other container attached to the dead one; they stay
healthy on their own healthchecks while the proxy answers every request with 502. `restart-stack.sh` restarts the proxy, reattaches the dependents in
dependency order, and verifies both upstreams from inside the proxy namespace.

See [KNOWN-LIMITATIONS](../KNOWN-LIMITATIONS.md#restarting-the-proxy-alone-is-an-outage).

---

## Database credentials

The generated `POSTGRES_PASSWORD` lives in `/opt/careerscope/infra/.env` on
the host and **that is the only copy**. An earlier version of the procedure
replaced the deployment directory wholesale and destroyed it; the next deploy
would have generated a fresh password that the existing database volume
rejects. `ship.sh` now preserves and restores it explicitly.

Never regenerate this value against an existing `careerscope_database` volume.

---

## CI/CD

GitHub Actions runs tests, type checking, linting, formatting and builds.
Actions are pinned to commit SHAs, with Dependabot maintaining them.

It does **not** deploy. There are no deployment credentials in the repository,
and automatic "merge to `main` → deploy" is not wired up, because `main` still
carries previous implementation. Promoting CareerScope to `main` is a release decision that has not been made.
