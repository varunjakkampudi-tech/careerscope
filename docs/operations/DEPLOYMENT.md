# Operations — Deployment

Deployment is: build an archive **from a committed revision**, ship it, build
images labelled with that revision, bring the stack up, then prove that every
answer to "what is deployed" agrees.

Never deploy from a dirty working tree. Never `scp` a hand-edited file onto the
host — provenance checking exists because that has happened.

---

## Scripts

The staging origin smoke requires `CAREERSCOPE_STAGING_NETRC` pointing to a
private, owner-readable curl netrc file and `CAREERSCOPE_TEST_EMAIL` selecting
an existing test account. Never commit the netrc or echo its contents. This smoke
does not enable signup, create arbitrary users, or delete database records.

All under [infra](../../infra), in `host/` (run on or against the host) and `checks/` (verification). See [infra/README.md](../../infra/README.md).

| Script                                | Purpose                                                                                           |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `host/provision-host.sh`              | Prepares a fresh Ubuntu 24.04 host. Idempotent. Installs Docker from Docker's repository.         |
| `host/ship.sh`                        | Ships a build context to the host. **Preserves `infra/.env`.**                                    |
| `host/build-images.sh`                | Builds both images, recording the source revision in each                                         |
| `host/deploy.sh`                      | Brings the stack up. Generates secrets on the host; they never leave it.                          |
| `host/apply-migrations.sh`            | Applies pending migrations and reports the publisher's hot query plan                             |
| `host/restart-stack.sh`               | **The only supported way to restart the proxy**                                                   |
| `host/maintenance.sh`                 | Proxy-level maintenance page: `enable` / `disable` / `status`                                     |
| `checks/check-provenance.sh`          | Asserts the deployed revision agrees everywhere                                                   |
| `checks/check-live-origin.sh`         | Explicit staging smoke: existing test identity, secure cookies, Origin refusal and logout         |
| `checks/check-host-firewall.sh`       | Firewall and Docker networking assertions                                                         |
| `host/scan-images.sh`                 | Trivy scan of both images with a clean cache                                                      |
| `host/purge-verification-accounts.sh` | Removes `verify-*` throwaway accounts                                                             |
| `host/setup-monitoring.sh`            | Installs the host monitor (systemd timer). See [MONITORING.md](MONITORING.md)                     |
| `host/monitor.sh`                     | The monitor itself — unreachable/unhealthy/stopped/stale/ok, alerts on change                     |
| `checks/check-monitoring.sh`          | Proves the monitor's classification and alerting logic against stub `docker`/`curl`               |
| `host/setup-discovery.sh`             | Installs the scheduled-discovery timer. See [DISCOVERY-SCHEDULE.md](DISCOVERY-SCHEDULE.md)        |
| `host/setup-lead-lifecycle.sh`        | Installs the liveness/retention timers. See [LEAD-LIFECYCLE.md](LEAD-LIFECYCLE.md)                |
| `host/setup-proxy-recovery.sh`        | Installs the proxy split-brain detector/auto-recovery. See [PROXY-RECOVERY.md](PROXY-RECOVERY.md) |
| `host/recover-proxy.sh`               | The detector/recovery itself - confirms an outage, runs `restart-stack.sh`, circuit-breaks        |
| `checks/check-proxy-recovery.sh`      | Proves the confirm-then-act-then-cooldown state machine against stub `curl`/`restart-stack.sh`    |

---

## Normal deployment

Deployment is a **manual, operator-run procedure**. No deploy workflow exists:
`.github/workflows/ci.yml` is the only workflow, it runs tests and builds, it
has no deployment credentials, and no push, merge, tag or schedule deploys
anything. See [CI-CD.md](CI-CD.md).

Placeholders used below: `<DEPLOY_HOST>` is the host address or name,
`<DEPLOY_USER>` is the dedicated **non-root** deploy account, and
`<DEPLOY_KEY>` is the path to that account's private SSH key. Keep their real
values in the owner's private operations notes, never in this repository. Do not
deploy as `root`; the deploy user must own `/opt/careerscope` and have access
to the Docker socket (see [HOSTINGER.md](HOSTINGER.md#access)).

Before deploying, confirm that the CI run for the exact revision you are about
to ship passed. Nothing enforces this automatically, so record the SHA and the
run you checked.

```bash
# 1. Commit. The archive comes from a revision, not from the working tree.
git status --porcelain     # must be empty
git fetch --no-tags origin main
REV=$(git rev-parse origin/main)
git archive --format=tar.gz -o deploy.tgz "$REV"

# 2. Ship. This preserves the host's .env and records the revision.
scp -i <DEPLOY_KEY> deploy.tgz <DEPLOY_USER>@<DEPLOY_HOST>:/tmp/
ssh -i <DEPLOY_KEY> <DEPLOY_USER>@<DEPLOY_HOST>   "bash /opt/careerscope/infra/host/ship.sh /tmp/deploy.tgz $REV"

# 3. Build with provenance (writes RELEASE_RECORD), migrate, deploy.
ssh -i <DEPLOY_KEY> <DEPLOY_USER>@<DEPLOY_HOST> "
  cd /opt/careerscope/infra &&
  bash host/build-images.sh $REV &&
  bash host/apply-migrations.sh &&
  bash host/deploy.sh <domain> <acme-email|internal>
"

# 4. Prove it.
ssh -i <DEPLOY_KEY> <DEPLOY_USER>@<DEPLOY_HOST>   "bash /opt/careerscope/infra/checks/check-provenance.sh $REV"
```

### Image references

`compose.production.yml` has no default image: `CAREERSCOPE_IMAGE` (runtime) and
`CAREERSCOPE_PROXY_IMAGE` (proxy) are required, and `docker compose` refuses to
start without them. No mutable tag such as `careerscope:v3` exists any more.

`build-images.sh` tags each image with the short revision (`careerscope:<sha12>`
and `careerscope:<sha12>-proxy`) and writes `/opt/careerscope/RELEASE_RECORD`
with the revision, both names and the build-time image digests (`sha256:` image
IDs). `deploy.sh` loads that record through `host/release-env.sh` and stops
before starting anything if the record is missing, a value is empty, the
revision differs from `DEPLOYED_COMMIT`, `DEPLOYED_COMMIT` is missing (fail
closed; the operator passes `--first-deploy` to `deploy.sh` and
`apply-migrations.sh` only on the very first deploy of a new host), or a tag no longer resolves to its
recorded digest. It then writes the two variables into `infra/.env` (`ship.sh`
removes the previous release's values, so old images are never reused by
accident). If the images are pushed to a registry, set the variables to
`registry.example/careerscope@sha256:<digest>` instead.
`checks/check-provenance.sh` reads the image names from the release record;
`host/scan-images.sh` and `checks/check-queue-contract.sh` require
`CAREERSCOPE_IMAGE` (and `CAREERSCOPE_PROXY_IMAGE`) in the environment.

The Redis password is not passed on a command line or as a container
environment variable, and it is not inside any URL: `deploy.sh` runs
`host/render-redis-config.sh`, which writes `infra/.env.secrets/redis.conf`,
`redis-queue.conf` (for the Redis servers) and `redis-password` (for the API and
workers; directory `0700`). Compose mounts them as secrets. The API and
workers receive `REDIS_PASSWORD_FILE=/run/secrets/redis-password` and
`REDIS_URL` / `QUEUE_REDIS_URL` without credentials; `packages/core`
(`configuration()`) reads the file at startup and adds the password in memory,
so `docker inspect` shows no password. The script is idempotent and runs on
every deploy.

Email OTP sign-in is required in production, so the API needs two secrets. They
follow the same pattern: set `EMAIL_OTP_HMAC_SECRET` (generated by `deploy.sh`
with `openssl rand -hex 32` when missing) and `RESEND_API_KEY` (set by the
operator; deploy stops without it) in `infra/.env`. `deploy.sh` runs
`host/render-otp-secrets.sh`, which writes `infra/.env.secrets/email-otp-hmac-secret`
and `resend-api-key` (directory `0700`, values never printed) and compose mounts
them as Docker file secrets into the **api service only**. The api receives
`EMAIL_OTP_HMAC_SECRET_FILE` and `RESEND_API_KEY_FILE`; `configuration()` reads
them at startup, applies the `isRandomSecret` screen to the HMAC secret, and
fails startup if a file is missing, empty or weak (the error names the variable,
never the value). Setting both a variable and its `_FILE` is refused. The
non-secret `EMAIL_OTP_ENABLED=true` and `RESEND_FROM_EMAIL` are plain environment
values for every service; workers call `configuration()` with
`emailOtpSecrets: false` and never receive the secrets.

For a deployment expected to take more than a few seconds, enable maintenance
mode first:

```bash
bash host/maintenance.sh enable "Deploying" "about 5 minutes"
# ... deploy ...
bash host/maintenance.sh disable
```

The maintenance flag is a **file**, not application state, so the page still
serves while the stack is down. `/api/health` stays reachable throughout.

---

## One-time follow-up required for the CS-28 release

CS-28 ("two different openings can be merged into one") changed how a job
posting's identity is computed and added `npm run db:backfill-job-sightings`
(`scripts/jobs/backfill-job-sightings.ts`) to recompute `job_sightings` from
`search_jobs` under the corrected rule. It is idempotent and safe to re-run,
but it is **not** wired into `apply-migrations.sh` and must be run once,
manually, the first time this release reaches production — after migrations,
before traffic resumes:

```bash
ssh -i <DEPLOY_KEY> <DEPLOY_USER>@<DEPLOY_HOST> "
  cd /opt/careerscope/infra &&
  docker exec careerscope-api-1 node --import tsx /app/scripts/jobs/backfill-job-sightings.ts
"
```

Corrected 2026-09-23: the `bootstrap` service's compose definition only
mounts `bootstrap.mjs` (`volumes: ['private:/private',
'../host/bootstrap.mjs:/app/bootstrap.mjs:ro']`), not the rest of `CareerScope/scripts` —
the original `docker compose run --rm --no-deps bootstrap ...` form here
would have failed with "file not found" the first time anyone actually ran
it. `backfill-job-sightings.ts` (and CS-26's `run-scheduled-discovery.ts`)
are now copied into the runtime image in `infra/docker/Dockerfile`, and the
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
ssh -i <DEPLOY_KEY> <DEPLOY_USER>@<DEPLOY_HOST> "
  cd /opt/careerscope/infra &&
  bash host/setup-monitoring.sh
"
```

Then set `MONITOR_WEBHOOK_URL` in `/etc/careerscope-monitor.env` on the host
and re-run `setup-monitoring.sh` (idempotent) so the timer picks it up. See
[docs/operations/MONITORING.md](MONITORING.md) for the full design, the
manual "stop a container and observe" proof this ticket's acceptance criteria
require, and the known limitation (nothing currently watches the watcher).
Remove this section once the step has been exercised against production.

---

## One-time follow-up required for the CS-26 release

CS-26 ("nothing runs discovery on a schedule") adds a scheduled-discovery
timer, same reasoning as CS-24/CS-25 - host state, installed once manually:

```bash
ssh -i <DEPLOY_KEY> <DEPLOY_USER>@<DEPLOY_HOST> "
  cd /opt/careerscope/infra &&
  bash host/setup-discovery.sh
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
(`infra/docker/Dockerfile`), and the corrected command targets the
always-running `api` container via `docker exec` instead.

---

## One-time follow-up required for the CS-27 release

CS-27 ("postings never expire or get re-checked") adds two host-native
timers - lead liveness checking and search-results retention - same
reasoning as CS-24/25/26:

```bash
ssh -i <DEPLOY_KEY> <DEPLOY_USER>@<DEPLOY_HOST> "
  cd /opt/careerscope/infra &&
  bash host/setup-lead-lifecycle.sh
"
```

See [LEAD-LIFECYCLE.md](LEAD-LIFECYCLE.md) for the full design and the
SSRF-hardening rationale. Remove this section once the step has been
exercised against production.

Also caught and fixed while building this: `infra/docker/Dockerfile.dockerignore`
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

**No Docker image build runs in CI.** `.github/workflows/ci.yml` has no image job,
so verifying an image build (`build-images.sh`) is a manual step, which is what
caught the two defects above.

---

## One-time follow-up required for the CS-3 release

CS-3 ("proxy restart strands every service behind a healthy-looking 502")
adds host-native proxy split-brain detection and auto-recovery, same
reasoning as CS-24/25/26/27:

```bash
ssh -i <DEPLOY_KEY> <DEPLOY_USER>@<DEPLOY_HOST> "
  cd /opt/careerscope/infra &&
  bash host/setup-proxy-recovery.sh
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

Encrypted resume storage reclaims abandoned write temporaries at API startup and
then every 5 minutes while the API runs. Only temporaries older than 10 minutes are
removed, so live writers and more than one process sharing the directory are safe;
a writer stalled past that bound retries its write once. The same sweep removes
cancellation markers older than 24 hours (the database row is authoritative after
that) and recounts the marker quota from the directory. New markers are keyed with
a key derived from the storage key; markers written before that change are still
accepted until they age out. The sweep logs counts only, and a failure is logged
without stopping the API.

---

## Restarting

```bash
bash /opt/careerscope/infra/host/restart-stack.sh
```

Restarting the proxy on its own is an outage. Docker gives it a fresh network
namespace and leaves every other container attached to the dead one; they stay
healthy on their own healthchecks while the proxy answers every request with 502. `restart-stack.sh` restarts the proxy, reattaches the dependents in
dependency order, and verifies both upstreams from inside the stable anchor
namespace.

See [KNOWN-LIMITATIONS](../KNOWN-LIMITATIONS.md#restarting-the-proxy-alone-is-an-outage).

---

## Database credentials

The generated `POSTGRES_PASSWORD` lives in `/opt/careerscope/infra/.env` on
the host and **that is the only copy**. An earlier version of the procedure
replaced the deployment directory wholesale and destroyed it; the next deploy
would have generated a fresh password that the existing database volume
rejects. `ship.sh` now preserves and restores it explicitly.

Never regenerate this value against an existing `careerscope_database` volume.

## Redis credentials

| Name             | Purpose                                                                                                                                                                                                                                                                                               | Required in production | Handling                                                                       |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------ |
| `REDIS_PASSWORD` | Password for the rate-limit Redis (6379) and the persistent queue Redis (6380). It is mounted into the Redis containers as a file secret (never `--requirepass` or an environment variable) and read by the API and workers from `REDIS_PASSWORD_FILE`; it is not in `REDIS_URL` / `QUEUE_REDIS_URL`. | Yes                    | Lives in `/opt/careerscope/infra/.env`. Never commit it or paste it into logs. |

`deploy.sh` generates `REDIS_PASSWORD` on first deploy if `infra/.env` lacks it,
and `ship.sh` preserves the file. `compose.production.yml` and
`compose.acceptance.yml` fail with "Redis password required" when it is unset.
Host-side scripts that connect to Redis directly (for example
`infra/checks/check-queue-contract.sh`, which exits with an error when
`REDIS_PASSWORD` is not exported) build the URL themselves from the exported value.

---

## CI/CD

GitHub Actions runs tests, type checking, linting, formatting and builds.
Actions are pinned to commit SHAs, with Dependabot maintaining them.

It does **not** deploy. There are no deployment credentials in the repository,
and no push, pull-request, merge, tag, schedule or upstream-workflow trigger
deploys. Production deployment is exclusively an authorized operator running the
manual procedure above. A deploy workflow may be added only with owner approval
and an isolated target; see [STAGING.md](STAGING.md).
