# Operations — Deployment

Deployment is: build an archive **from a committed revision**, ship it, build
images labelled with that revision, bring the stack up, then prove that every
answer to "what is deployed" agrees.

Never deploy from a dirty working tree. Never `scp` a hand-edited file onto the
host — provenance checking exists because that has happened.

---

## Scripts

All under [infra/v3](../../infra/v3).

| Script                           | Purpose                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| `provision-host.sh`              | Prepares a fresh Ubuntu 24.04 host. Idempotent. Installs Docker from Docker's repository. |
| `ship.sh`                        | Ships a build context to the host. **Preserves `infra/v3/.env`.**                         |
| `build-images.sh`                | Builds both images, recording the source revision in each                                 |
| `deploy.sh`                      | Brings the stack up. Generates secrets on the host; they never leave it.                  |
| `apply-migrations.sh`            | Applies pending migrations and reports the publisher's hot query plan                     |
| `restart-stack.sh`               | **The only supported way to restart the proxy**                                           |
| `maintenance.sh`                 | Proxy-level maintenance page: `enable` / `disable` / `status`                             |
| `check-provenance.sh`            | Asserts the deployed revision agrees everywhere                                           |
| `check-live-origin.sh`           | Verifies cookie attributes, CSRF origin check, proxy headers                              |
| `check-host-firewall.sh`         | Firewall and Docker networking assertions                                                 |
| `scan-images.sh`                 | Trivy scan of both images with a clean cache                                              |
| `purge-verification-accounts.sh` | Removes `verify-*` throwaway accounts                                                     |

---

## Normal deployment

```bash
# 1. Commit. The archive comes from a revision, not from the working tree.
git status --porcelain     # must be empty
REV=$(git rev-parse HEAD)
git archive --format=tar.gz -o deploy.tgz "$REV"

# 2. Ship. This preserves the host's .env and records the revision.
scp -i ~/.ssh/careerscope_deploy deploy.tgz root@201.18.193.230:/tmp/
ssh -i ~/.ssh/careerscope_deploy root@201.18.193.230 \
  "bash /opt/careerscope/infra/v3/ship.sh /tmp/deploy.tgz $REV"

# 3. Build with provenance, migrate, bring up.
ssh -i ~/.ssh/careerscope_deploy root@201.18.193.230 "
  cd /opt/careerscope/infra/v3 &&
  bash build-images.sh $REV &&
  bash apply-migrations.sh &&
  docker compose -f compose.production.yml up -d --wait
"

# 4. Prove it.
ssh -i ~/.ssh/careerscope_deploy root@201.18.193.230 \
  "bash /opt/careerscope/infra/v3/check-provenance.sh $REV"
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
bash /opt/careerscope/infra/v3/restart-stack.sh
```

Restarting the proxy on its own is an outage. Docker gives it a fresh network
namespace and leaves every other container attached to the dead one; they stay
healthy on their own healthchecks while the proxy answers every request with 502. `restart-stack.sh` restarts the proxy, reattaches the dependents in
dependency order, and verifies both upstreams from inside the proxy namespace.

See [KNOWN-LIMITATIONS](../KNOWN-LIMITATIONS.md#restarting-the-proxy-alone-is-an-outage).

---

## Database credentials

The generated `POSTGRES_PASSWORD` lives in `/opt/careerscope/infra/v3/.env` on
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
carries V1. Promoting V2 to `main` is a release decision that has not been made.
