# Operator runbook — clear five tickets by SSH, plus one that needs more

**Written:** 2026-09-25 · **Corrected:** 2026-09-25 · **For:** the owner or an
authorised operator · **Clears by SSH:** CS-3, CS-24, CS-25, CS-26, CS-27
· **Also covered, but NOT by SSH:** CS-30 — see
[CS-30 needs hPanel and a second machine](#cs-30-needs-hpanel-and-a-second-machine)

> **Correction, 2026-09-25.** This header previously read _"clear seven tickets
> in one host session"_ and listed CS-30 and CS-47 alongside the rest. Both were
> wrong, and the document contradicted itself about CS-30 two hundred lines
> later.
>
> - **CS-30 is not an SSH task.** Its own step below says so: it requires the
>   **Hostinger hPanel**, and verification _from a machine that is not the VPS_.
>   An operator who set aside one SSH window would have finished it with CS-30
>   still open, needing a web console and a second machine nobody had told them
>   to arrange.
> - **CS-47 is not blocked on a host at all.** It is in QA, not BLOCKED, and has
>   been removed from this runbook.
>
> Five tickets clear by SSH. The runbook's own summary line was relayed as fact
> without checking the statuses behind it — which is the failure this project
> has been flagging in other people's evidence all day.

Every one of these tickets has an acceptance criterion of the form _"proven by
doing X on a real host"_. The implementations are complete and locally
verified; what is missing is host evidence, which no agent in this project can
obtain. This runbook exists so that one operator session captures all of it in
a single pass instead of triggering seven separate investigations.

## How to use this

Run the commands **in order**. For each step, capture the **real output** —
including output that fails. A failure captured here is worth more than a
success assumed.

### ⚠️ This repository is PUBLIC. Do not paste raw journald into it.

`docs/SECURITY.md` records that the repository is **public**. Three steps below
capture up to 250 lines of raw `journalctl`, including
`careerscope-discovery.service` — **the owner's own job searches** — and
`careerscope-liveness.service`, which fetches posting URLs. Pasting that
verbatim into `.ai/backlog.json` publishes host paths, unit names and timer
cadence at minimum, and **at worst the owner's search terms: personal data about
what work they are looking for while employed.**

This project's own contract says never log a URL, a body, a cookie or a token.
An instruction to paste raw logs into a public artefact, with no review step,
moves whatever those units do log straight past that rule.

**Mandatory, not advice:**

1. **Capture to a local file**, outside the repository:
   ```bash
   journalctl -u careerscope-discovery.service -n 100 --no-pager \
     > ~/careerscope-evidence/discovery.log
   ```
2. **Record only the verdict and a summarised excerpt** in the ticket's
   `evidence` array — exit codes, counts, timestamps, the one line that proves
   the point.
3. **Read the excerpt for URLs, query strings, email addresses and search terms
   before committing.** If in doubt, record the verdict and omit the excerpt.
4. Keep the full capture locally in case the owner wants to inspect it.

Nothing in this runbook deploys, restarts the stack, or changes application
behaviour, with two explicitly-marked exceptions in §CS-3 and §CS-25 that stop
and restart individual units. Read those before running them.

## Absolute prohibitions — these have each caused a real incident

- **Never run `nft flush ruleset`.** It deletes Docker's NAT rules and kills
  container egress. The symptom is an unrelated timeout, not a firewall error.
- **Never restart the proxy alone.** Every service joins its network namespace;
  restarting it orphans them all behind a 502 while they still report healthy.
  Use `infra/v3/restart-stack.sh`.
- **Never run `docker system prune -a`.** It removes the images a rollback
  depends on.
- **Never regenerate `POSTGRES_PASSWORD`** against an existing volume.
  `infra/v3/.env` on the host is the only copy.
- **Never delete a PostgreSQL volume.**

---

## Step 0 — establish where you are (do this first, always)

```bash
cd /opt/careerscope            # adjust if your install path differs
bash infra/v3/check-provenance.sh
curl -fsS https://careerscope.tech/api/health
systemctl list-timers --all | grep careerscope
```

**Expected:** provenance reports a clean match between the deployed revision
and its recorded commit; `/api/health` returns JSON including a version;
`list-timers` lists the CareerScope timers.

**Record the `list-timers` output verbatim — it is shared evidence for CS-24,
CS-25, CS-26, CS-27 and CS-47.** Note especially whether any timer shows
`LAST` as `n/a`, which means it has never fired.

> If `list-timers` shows **fewer** CareerScope timers than expected, stop and
> record that. It is a finding, not a setup problem to quietly correct.

### Derive the Postgres container name ONCE, here

Two later steps need it — the CS-24 container-stop proof and the CS-25 restore
drill — and **one of them stops a running service while the other runs the only
irreversible statement in this document.** Derive it once, guarded, and reuse
`"$PG"` in both. Two derivations of the same value is the same defect as two
lists of the same thing, and it is how the guard ended up on one site and not
the other.

> **The guards in this document use `return 1` inside a function, never
> `exit 1`.** This runbook is written to be pasted into an interactive SSH
> shell, and a bare `exit` in a pasted block **logs you out** — potentially
> mid-restore-drill. If you adapt any block, keep that property.

```bash
require_one_container() {   # $1 = name fragment, e.g. postgres
  MATCH=$(docker ps --format '{{.Names}}' | grep "$1")
  if [ -z "$MATCH" ] || [ "$(echo "$MATCH" | wc -l)" != 1 ]; then
    echo "STOP: expected exactly one '$1' container, got: ${MATCH:-<none>}"
    return 1
  fi
  echo "using container: $MATCH"
}

require_one_container postgres && PG=$MATCH
echo "PG=${PG:-<UNSET - DO NOT CONTINUE>}"
```

> The name carries a Compose `-1` suffix that is easy to get wrong, which is
> why it is derived rather than typed. **Zero matches would give
> `docker stop ""`; multiple matches would pass a multi-line string.** The
> guard refuses both rather than guessing. **If `PG` prints as `<UNSET>`, stop
> and record that — do not continue into the steps that use it.**

**If you open a new shell at any point, re-run this block before continuing** —
`$PG` and the function do not survive it.

---

## CS-47 — scheduler health (OPTIONAL: this ticket is NOT host-blocked)

> **Removed from the "clears" list, 2026-09-25.** CS-47 is in **QA**, not
> BLOCKED. Its checker is CI-wired and its acceptance does not wait on an
> operator session, so it is **not** one of the tickets this runbook unblocks.
>
> The steps below are still worth doing while you are on the host — installing
> the unit and proving detection against a real stopped timer is genuine
> evidence, and the ticket records that `setup-scheduler-health.sh` has never
> been run anywhere. But **skipping it blocks nothing**, and it must not be
> counted toward the five.

The checker is built, and its 69-assertion test suite passes locally. It has
**never run on a host** and no webhook has ever been posted to.

> **Prerequisite, stated because the script states it and this runbook did
> not.** `setup-scheduler-health.sh` watches the six timers installed by
> `setup-monitoring.sh` (CS-24), `setup-backup.sh` (CS-25),
> `setup-discovery.sh` (CS-26), `setup-lead-lifecycle.sh` (CS-27) and
> `setup-proxy-recovery.sh` (CS-3) — **install those first.** On an
> under-provisioned host this step otherwise reports six "never recorded a run"
> results, and **you cannot tell a provisioning gap from a detection failure.**

> **Note the binary name.** The installer places the script at
> `/usr/local/bin/careerscope-scheduler-health.sh` — **with** the
> `careerscope-` prefix. An earlier version of this runbook omitted it in all
> three invocations below. If you get `No such file or directory`, check the
> path before you start debugging the installer.

```bash
sudo bash infra/v3/setup-scheduler-health.sh
systemctl status careerscope-scheduler-health.timer --no-pager
sudo /usr/local/bin/careerscope-scheduler-health.sh; echo "EXIT=$?"
```

**Expected:** `EXIT=0` and a single line reporting all six timers enabled,
active and within their expected interval.

**The single highest-value thing to check first:** `systemctl show` renders
timestamp and timespan properties differently across systemd versions (raw
microseconds vs a human string), and `systemd-analyze` labels iterations
`Iteration #2:` or `Iter. #2:`. The parsers accept both and **fail loudly**
on anything else — so the worst case is a permanent noisy false alarm, not a
silent pass. Confirm which form Ubuntu 24.04 emits here.

Now prove it actually detects a dead timer (this is the acceptance proof):

```bash
sudo systemctl stop careerscope-retention.timer
sudo /usr/local/bin/careerscope-scheduler-health.sh; echo "EXIT=$?"   # expect EXIT=1, retention named
sudo systemctl start careerscope-retention.timer
sudo /usr/local/bin/careerscope-scheduler-health.sh; echo "EXIT=$?"   # expect EXIT=0 again
```

**Pass criterion:** the middle run exits non-zero and names
`careerscope-retention.timer`, and no other timer. Retention is chosen
deliberately — it is the LOWER-ranked timer, so stopping it is the least
disruptive possible proof.

> **Known open gap, do not let this step paper over it:** `check-scheduler-health.sh`'s
> curl stub records _that_ a POST happened and discards the body, so
> `json_escape()` is exercised by no test (CS-47 F-1). A live webhook delivery
> observed here is therefore **more** valuable than usual — if you can, confirm
> the alert arrives in the real channel and that it contains no URL, token or
> host path.

---

## CS-24 — monitoring

> **`check-monitoring.sh` is NOT host evidence and running it here gathers
> nothing.** Its own header says it _"runs entirely against stub `docker`/`curl`
> binaries; it never touches a real host, a real container or a real webhook."_
> On the host it passes exactly as it passes in CI, and an operator who records
> `EXIT=0` beside CS-24 has recorded the CI result a second time.
>
> It is listed only so you can confirm the installed copy matches. **The timer
> and journal lines below are the real evidence.**

```bash
bash infra/v3/check-monitoring.sh; echo "EXIT=$?"   # stub-driven: confirms nothing about the host
systemctl status careerscope-monitor.timer --no-pager
journalctl -u careerscope-monitor.service -n 50 --no-pager > ~/careerscope-evidence/monitor.log
```

**Pass criterion (AC2 is already met without this step — see the ticket):** the
timer is active and enabled, and the journal shows real recent executions with a
`LAST` that is not `n/a`.

### AC3 needs a step this runbook was missing

AC3 asks that monitoring **distinguish a real failure**, and the script itself
records that the _"stop a container and observe the alert"_ proof is a one-time
manual step against the real deployment. It was never written down here, so the
criterion could not be satisfied by following this document.

⚠️ **This stops a real service.** Never the proxy — restarting the proxy alone
strands every service in its namespace.

**Do not name a container. Read the set the monitor actually watches.**
`monitor.sh:65` iterates `$MONITOR_CONTAINERS`, which is **configuration**
(`:28`, with a default), not a fixed name — its `set -f` comment says so
explicitly. Stopping anything outside that set proves nothing.

**And it must be a worker, not Postgres.** `monitor.sh:58` gates the entire
worker loop behind `if [ "$status" = ok ]`. Stopping Postgres takes the API
down, so `status` becomes `unreachable`, **the loop never runs, and the
`stopped` classification AC1 names is structurally unreachable.** You would
cause a user-visible outage and still not exercise the criterion.

**Allow for the real interval.** The timer is `OnUnitActiveSec=5min`, and
alerting is edge-triggered with a bounded re-notify (`monitor.sh:21`, `:117`),
so **recovery needs its own tick**. AC1 allows 15 minutes; use it.

```bash
# /etc/careerscope-monitor.env is root-only 0600. Reading it without sudo
# silently yields the defaults - the same permission trap as the backup
# directory, and it could have you stop a container the monitor does not watch.
#
# An unreadable env file is a STOP, not a note. The ":-" fallback below is
# only legitimate when the file was genuinely read and the variable was
# genuinely unset, which is monitor.sh's own documented default. If the file
# could not be read, the fallback would substitute three guessed names for a
# configured value nobody looked at - and you would then stop a container the
# monitor may not watch, see a silent journal, and record AC3 as failed.
MONITOR_ENV_OK=no
sudo test -r /etc/careerscope-monitor.env && MONITOR_ENV_OK=yes
echo "env file readable: $MONITOR_ENV_OK"

MONITOR_CONTAINERS=
if [ "$MONITOR_ENV_OK" = yes ]; then
  # Defaulting is monitor.sh:28's documented behaviour, applied only because
  # the file was actually read. Note there is no 2>/dev/null here: a sourcing
  # error must be visible, not swallowed.
  MONITOR_CONTAINERS=$(sudo sh -c '. /etc/careerscope-monitor.env; echo "${MONITOR_CONTAINERS:-careerscope-search-1 careerscope-files-1 careerscope-publisher-1}"')
fi
echo "monitor watches: ${MONITOR_CONTAINERS:-<UNKNOWN - DO NOT CONTINUE>}"

# Pick the first WATCHED container that is actually running. Never substitute.
TARGET=""
for c in $MONITOR_CONTAINERS; do
  if docker ps --format '{{.Names}}' | grep -qx "$c"; then TARGET=$c; break; fi
done
if [ -z "$TARGET" ]; then
  echo "STOP: no watched container to stop. Either the env file was unreadable"
  echo "or none of the watched containers are running. Both are findings in"
  echo "their own right - record which one, and do NOT substitute a container"
  echo "of your own. The next block will refuse to run."
fi
echo "TARGET=${TARGET:-<UNSET - DO NOT CONTINUE>}"
```

```bash
# The guard is INSIDE the block that stops the container, not beside it.
# An empty TARGET here would make "docker stop" fail harmlessly and then
# sleep through a full tick and capture a quiet journal - and a quiet journal
# is exactly what the pass criterion reads as an AC3 failure. The refusal
# must therefore prevent the sleep, not just the stop.
if [ -z "$TARGET" ]; then
  echo "REFUSING: TARGET is unset. Nothing was stopped, so nothing can be"
  echo "concluded about AC3. This is not an AC3 failure - do not record one."
else
  echo "about to stop: $TARGET"
  docker stop "$TARGET"
  sleep 330                     # one full 5-minute tick plus margin
  journalctl -u careerscope-monitor.service -n 30 --no-pager

  docker start "$TARGET"
  sleep 330                     # edge-triggered recovery needs its own tick
  journalctl -u careerscope-monitor.service -n 30 --no-pager
fi
```

**Pass criterion — the classification must be `stopped` specifically:**

1. The middle capture reports **`status=stopped`** with
   **`detail="not running:<name>"`** naming the container you stopped. A
   monitor that stays **silent** through a genuinely stopped container has
   failed AC3 — record that outcome exactly as it happened, but only if
   `TARGET` was actually set and the stop actually ran.
2. The final capture shows it back to `ok`.

> **An `unreachable` or `unhealthy` alert is a FAILURE of this step, not a
> pass.** It means something other than a watched worker went down — most
> likely the API — so the criterion was never exercised. Under a looser reading
> ("an alert fired") that would be recorded as success, which is exactly the
> substitution this runbook exists to prevent.
>
> **If `TARGET` printed `<UNSET>`, stop.** Without that guard the block would
> sleep for eleven minutes, capture a quiet journal, and lead you to record
> _"AC3 failed"_ when nothing was ever stopped.

<!-- A second, looser "Pass criterion" block stood here until 2026-09-25. It
     required only that the monitor be "detecting and reporting" the stopped
     service, which an `unreachable` alert satisfies - the exact reading the
     block above forbids - and it was positioned to be read LAST. It was not
     wrong when written; it was superseded and not removed. Its one load-
     bearing sentence is merged into item 1. Do not reintroduce a second
     criterion here: one step, one pass criterion. -->

---

## CS-26 — scheduled discovery

```bash
systemctl status careerscope-discovery.timer --no-pager
journalctl -u careerscope-discovery.service -n 100 --no-pager
```

**Pass criterion:** the timer is active and enabled, and the journal shows at
least one **completed** discovery run — not merely a started one. Record the
run's outcome. A run that completed with zero results is a legitimate outcome
and must be recorded as such, not as a failure.

---

## CS-27 — posting expiry and re-check (liveness)

```bash
systemctl status careerscope-liveness.timer --no-pager
journalctl -u careerscope-liveness.service -n 100 --no-pager
bash infra/v3/check-maintenance.sh; echo "EXIT=$?"
```

**Pass criterion:** the timer is active, and the journal shows a liveness pass
that actually re-checked postings. Note CS-27's own recorded limitation:
liveness cannot distinguish a slow ATS from a dead one, so record what it
concluded, not whether you agree with it.

---

## CS-3 — proxy restart does not strand services

**This step restarts the stack.** Do it at a quiet moment. It is the only way
to prove the criterion.

```bash
curl -fsS -o /dev/null -w '%{http_code}\n' https://careerscope.tech/
sudo bash infra/v3/restart-stack.sh
sleep 20
curl -fsS -o /dev/null -w '%{http_code}\n' https://careerscope.tech/
curl -fsS https://careerscope.tech/api/health
docker ps --format '{{.Names}}\t{{.Status}}'
```

**Pass criterion:** HTTP 200 before and after, `/api/health` answers, and every
container reports healthy. **A 502 after the restart is the exact defect this
ticket exists for — if you see one, record it and do not retry until it clears
by itself, because "it worked the second time" is not the evidence.**

> Use `restart-stack.sh`. **Never** `docker restart` the proxy alone — that is
> the original incident this ticket documents.

Also verify the recovery path:

```bash
bash infra/v3/check-proxy-recovery.sh; echo "EXIT=$?"   # stub-driven: NOT host evidence, see note
systemctl status careerscope-proxy-recovery.timer --no-pager
```

> **The `check-proxy-recovery.sh` line above is decorative.** Like
> `check-monitoring.sh` it runs against stub binaries and passes identically on
> a laptop, in CI and on the host. It confirms the installed copy is intact and
> nothing more. **The restart-and-verify steps in this section are the real host
> evidence**, and they are correct as written.

---

## CS-25 — backup: unattended dump + a real restore drill

**This is the highest-risk item in the entire backlog**, and the most important
step in this runbook. The ticket sat in UAT describing recoverability that has
never been demonstrated to exist. Its criteria are explicit: a dump _"produced
without a human running anything"_, and a restore that _"is exercised, not
documented — a dump nobody has restored is a guess"_.

### Part 1 — prove the dump happens unattended

> **`systemctl status` and `ls -lh` CANNOT detect a failed backup, and this
> step previously relied on both.** `backup.sh`'s `fail()` (`:75-87`) writes
> `STATUS=failed` to `last-status`, sends an alert, **and then `exit 0`
> deliberately** — its comment says so: _"this is an observability tool. A
> failed dump is reported through the alert and the status file (AC3), not
> through the exit code of a systemd unit nobody is watching."_ On failure it
> also leaves **the last good dump byte-identical and in place**.
>
> So after a failed run the unit is **green** and `ls -lh` shows **yesterday's
> good dump**. Both original checks pass while today's backup failed. **The one
> authoritative record is `last-status`, and it must be read.**

```bash
systemctl status careerscope-backup.timer --no-pager
systemctl list-timers careerscope-backup.timer --no-pager
sudo ls -lh /var/backups/careerscope/
sudo cat /var/backups/careerscope/last-status      # THE authoritative record
bash infra/v3/check-backup.sh; echo "EXIT=$?"
```

**Pass criterion — all three, not any one:**

1. **`last-status` reads `STATUS=ok`.** A `STATUS=failed` here is the finding,
   whatever the unit and the directory listing say. Record the `REASON=` line
   verbatim if present.
2. A dump file exists whose mtime corresponds to a **timer** run, not a human
   invocation. If the newest dump's timestamp matches a manual run, this is not
   met — wait for the timer and re-check.
3. Record the filename, size and timestamp.

> A green unit is not evidence here, and neither is a recent file. **Reading
> only those two is structurally incapable of detecting the exact failure mode
> AC3 was built to expose** — which is the whole reason `last-status` exists.

### Part 2 — the restore drill

> **Do Part 1b first if the timer has ever fired.** `backup.sh` describes its
> own second phase: it restores each dump into a disposable scratch database, so
> _"every single scheduled run proves its own dump is actually restorable."_
> A `journalctl -u careerscope-backup.service` extract showing that verify phase
> succeeding on a **timer-triggered** run is real host evidence, costs one
> command, and carries none of the risk below. **That is the cheapest and
> strongest AC2 evidence.** The manual drill below is an independent second
> opinion, not the only route.

Restore into a **scratch database**. Never restore over the live one.

**`$PG` comes from the guarded derivation in Step 0** — one derivation, reused
here and in the CS-24 step above. If you have opened a new shell since, re-run
that block before continuing.

Everything below uses `"$PG"`, **including the cleanup**, so the target of the
one irreversible statement in this document is derived rather than typed.

**Find the dump, and distinguish "cannot read" from "none exist":**

```bash
# /var/backups/careerscope is root-owned mode 0700 (backup.sh:44), so a
# non-root `ls` fails with "Permission denied". WITHOUT sudo, and with stderr
# discarded, that message vanishes and the guard below reports "no dump found"
# - manufacturing a business-continuity emergency on the highest-risk ticket
# in the backlog. Check readability FIRST, and never redirect the error away.
sudo test -r /var/backups/careerscope || {
  echo "STOP: cannot read /var/backups/careerscope - this is a PERMISSIONS"
  echo "problem, NOT evidence that backups are missing. Re-run with sudo."
}

LATEST=$(sudo ls -t /var/backups/careerscope/*.dump | head -1)
if [ -z "$LATEST" ]; then
  echo "no dump found - and the readability check above PASSED, so this"
  echo "really is the finding. Record it."
else
  echo "$LATEST"
fi
```

> The two messages are deliberately different. **An unreadable directory and an
> empty one are different facts and must never produce the same sentence** —
> the guard catches emptiness, but a discarded error turns "I was not allowed
> to look" into "there is nothing there", which is the loudest possible wrong
> conclusion on this ticket.

**`backup.sh` writes `pg_dump -Fc` — custom format.** It must be restored with
`pg_restore`, not `psql`, and it is not a `.sql` file:

```bash
docker exec -i "$PG" psql -U careerscope -c 'CREATE DATABASE restore_drill;'

docker exec -i "$PG" pg_restore -U careerscope -d restore_drill < "$LATEST"
```

Then the sanity queries — **a restore that produces an empty schema is a failed
restore, and this is exactly where that gets caught:**

```bash
docker exec -i "$PG" psql -U careerscope -d restore_drill -c \
  "SELECT count(*) AS tables FROM information_schema.tables
     WHERE table_schema='public';"

docker exec -i "$PG" psql -U careerscope -d restore_drill -c \
  "SELECT count(*) AS users FROM users;"

# NOTE: the Drizzle export is `searches`; the POSTGRES TABLE is `search_runs`.
# Querying `FROM searches` raises `relation "searches" does not exist`, which
# reads exactly like a failed restore and is not one.
docker exec -i "$PG" psql -U careerscope -d restore_drill -c \
  "SELECT count(*) AS search_runs FROM search_runs;"
```

**Pass criterion:** `tables` is **13** (the current schema; 14 is also correct
if a Drizzle migrations table lives in `public`), and the row counts are
plausible against production. A restore yielding 0 tables, or a `users` count of
0, is a **FAILED DRILL** — record it exactly as such.

> **Before recording FAILED DRILL, check you are reading a restore failure and
> not a command failure.** A `relation ... does not exist` error, a
> `No such container`, or an empty `$LATEST` are **defects in this runbook or in
> your session**, not evidence that the backup is unrecoverable. A false FAILED
> DRILL triggers an emergency business-continuity investigation against a
> working backup system and consumes the window it was meant to clear.

⚠️ **Clean up only after recording the output. This is the one irreversible
statement in this document.** Confirm `echo "$PG"` still prints the scratch
container you expect, and that the database name reads `restore_drill` and
nothing else, before running it:

```bash
echo "about to DROP restore_drill on: $PG"
docker exec -i "$PG" psql -U careerscope -c 'DROP DATABASE restore_drill;'
```

> Do not skip Part 2 because Part 1 looked fine. A dump that exists and a dump
> that restores are different claims, and only the second one is recoverability.

---

## CS-30 needs hPanel and a second machine

**This is NOT an SSH task and cannot be done from the SSH window above.** It
needs two things the rest of this runbook does not:

1. **The Hostinger hPanel** — a web console, not a shell.
2. **A machine that is not the VPS**, to verify from outside. Checking from the
   host proves nothing: a rule that blocks the internet still lets the host
   reach itself.

Arrange both **before** starting, or this ticket will not close in the same
sitting as the other five.

1. In hPanel, open the VPS firewall configuration.
2. Record: whether a managed firewall is **attached** to this VPS at all, and
   the full inbound rule list (port, protocol, source).
3. Record whether rules exist for **both IPv4 and IPv6**. An IPv4-only ruleset
   with open IPv6 is a real and common exposure.

Then verify from **outside** the host — from a machine that is not the VPS:

```bash
# expected reachable
nc -vz careerscope.tech 443
nc -vz careerscope.tech 22      # or your configured SSH port

# expected BLOCKED — these must fail
nc -vz careerscope.tech 5432    # PostgreSQL
nc -vz careerscope.tech 6379    # Redis
nc -vz careerscope.tech 8080    # internal API
```

And on the host, the repository's own check:

```bash
bash infra/v3/check-host-firewall.sh; echo "EXIT=$?"
```

**Pass criterion:** 443 and SSH reachable; 5432, 6379 and 8080 **refused or
timing out** from outside, on both IPv4 and IPv6; `check-host-firewall.sh`
passes its 14 assertions.

> **Preserve administrative recovery access.** Before changing any rule,
> confirm you have console access through hPanel so a mistake cannot lock you
> out. **Never flush the host ruleset** — the firewall owns only the
> `inet careerscope` table, and flushing takes Docker's NAT rules with it.
> Local simulation is explicitly **not** evidence for this ticket.

---

## Step Final — record the results

For each ticket, append the real captured output to its `evidence` array in
`.ai/backlog.json`, and set status:

- **UAT** only where the pass criterion was genuinely met, with the output to
  show it.
- **BLOCKED** (unchanged) where it was not — with the actual failure recorded.

Then append one dated entry to `review.txt` summarising what was run and what
it showed.

**If a step fails, that is a successful run of this runbook.** These seven
tickets exist because nobody had looked. Finding out that the backup does not
restore is the single most valuable outcome available today — far more valuable
than seven green rows.
