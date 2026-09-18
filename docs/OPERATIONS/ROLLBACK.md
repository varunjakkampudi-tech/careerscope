# Operations — Rollback

Rolling back means returning the running system to a previously known-good
revision. It is a redeploy of an older commit, not a restore from backup —
**there is no off-host backup.**

---

## Before anything

Establish what is actually running:

```bash
ssh -i ~/.ssh/careerscope_deploy root@201.18.193.230 \
  "bash /opt/careerscope/infra/v3/check-provenance.sh"
```

Record that SHA. It is what you are rolling back _from_, and it is what you roll
forward to if the rollback makes things worse.

---

## Rolling back application code

Images are labelled with their source revision, so a previous image may still be
on the host:

```bash
docker image ls --format '{{.Repository}}:{{.Tag}} {{.ID}}'
docker image inspect careerscope:v3 --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
```

If the previous image is gone, rebuild from the older commit using the normal
[deployment](DEPLOYMENT.md) procedure with the older SHA. That is the reliable
path and should be the default.

```bash
bash maintenance.sh enable "Rolling back" "about 10 minutes"
# deploy the older SHA exactly as in DEPLOYMENT.md
bash check-provenance.sh <older-sha>
bash maintenance.sh disable
```

**Do not** run `docker system prune -a`. It deletes the older images that make a
fast rollback possible.

---

## Rolling back the database

This is the hard case, and honesty matters more than procedure here.

Migrations are forward-only. There are no down migrations. If a deployment
applied a migration and you roll the code back past it, the schema is ahead of
the code.

| Situation                                                          | Action                                                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Migration was additive (new table, new nullable column, new index) | Old code ignores it. Roll the code back and leave the schema alone.     |
| Migration was destructive or changed a constraint                  | There is no automated path. Stop and assess before doing anything else. |

Take a snapshot **before** attempting any schema surgery:

```bash
docker exec careerscope-postgres-1 pg_dump -U careerscope careerscope \
  > /opt/careerscope/rollback-$(date +%s).sql
```

That file lives on the same host as the database it protects. It survives a bad
migration. It does **not** survive losing the machine. It is not disaster
recovery.

---

## If the stack will not come up

1. **Check provenance and logs first.**

   ```bash
   docker compose -f compose.production.yml ps
   docker compose -f compose.production.yml logs --tail 50 api
   ```

2. **502 on every request, containers healthy.** This is the orphaned network
   namespace, not an application fault. The proxy was restarted alone.

   ```bash
   bash /opt/careerscope/infra/v3/restart-stack.sh
   ```

3. **Postgres refuses the password.** `infra/v3/.env` was lost or regenerated
   against the existing volume. The password in the file must match the one the
   volume was initialised with. If the file is gone, the value can sometimes be
   recovered from a still-running container's environment:

   ```bash
   docker inspect careerscope-api-1 --format '{{range .Config.Env}}{{println .}}{{end}}' | grep DATABASE_URL
   ```

   Do not delete the volume to "fix" this. That destroys all data.

4. **Last resort.**
   ```bash
   docker compose -f compose.production.yml up -d --force-recreate
   ```

---

## Verifying a rollback

Do not declare it done on a 200 from the home page.

```bash
bash check-provenance.sh <target-sha>     # 4/4 agreement
bash check-host-firewall.sh               # 14/14
curl -sS https://careerscope.tech/api/health
bash check-live-origin.sh                 # cookie, CSRF, proxy headers
bash purge-verification-accounts.sh       # clean up the throwaway account
```
