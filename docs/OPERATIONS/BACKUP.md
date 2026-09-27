# Operations — Backup

## Why this exists

Off-host backup was a deliberate decision (see [SECRETS](SECRETS.md) and
[HOSTINGER](HOSTINGER.md) for why), but that left no periodic _local_ dump
either. Recovery depended on someone remembering to run `pg_dump` by hand.
This is CS-25: a scheduled, host-native backup that dumps, proves the dump is
actually restorable, and only then keeps it.

## What every scheduled run does

1. **Dump** — `pg_dump`, custom format, captured on the host via
   `docker exec`.
2. **Verify** — restore that exact dump into a disposable scratch database
   inside the same container, run a real sanity query against it (row/table
   presence, not just "the command exited zero"), then drop the scratch
   database. This is what makes the restore **exercised, not documented**
   (the ticket's own AC2 wording) — every run proves its own dump works, not
   just that `pg_dump` didn't error.
3. **Promote** — only if both of the above succeed, atomically rename the
   verified dump into place and apply retention (default 14 days). A dump
   that fails step 1 or 2 is deleted, not promoted — the last known-good file
   is left exactly as it was, and `last-status` says `failed`, so a failed
   dump can never look like a current one (AC3).

## How it runs

[backup.sh](../../infra/v3/backup.sh) runs **on the host**, the same way
[monitor.sh](../../infra/v3/monitor.sh) does, via `careerscope-backup.timer`
(daily at 03:30, off-peak). Dumps contain private data — resumes, emails,
everything else in the database — so the backup directory and every file in
it are root-only (`0700`/`0600`), per this ticket's own `securityImpact`.

## Install

```sh
bash infra/v3/setup-backup.sh
```

Idempotent, same pattern as `setup-monitoring.sh`. A failed backup alerts to
`BACKUP_WEBHOOK_URL` in `/etc/careerscope-backup.env`, or reuses
`MONITOR_WEBHOOK_URL` (CS-24's webhook) if that's the only one configured —
one payload works for both Slack and Discord, and a non-`https://` URL is
refused rather than sent over in cleartext, same as `monitor.sh`.

## Restoring for real

```sh
# On the intended target (a fresh host, or the same one after data loss):
docker exec -i careerscope-postgres-1 pg_restore -U careerscope -d careerscope \
  --clean --if-exists --no-owner < /var/backups/careerscope/careerscope-<timestamp>.dump
```

Every scheduled run already proves a restore of that exact file succeeds
(see "Verify" above) — this command is the same operation, aimed at the real
database instead of a disposable scratch one.

## Verification

```sh
bash infra/v3/check-backup.sh
```

Unlike `check-monitoring.sh`, this is **not** stub-based: it starts a
disposable `postgres:17.6-alpine` container, seeds it with real tables and
rows, and runs the actual `pg_dump`/`pg_restore`/sanity-query pipeline
against it end to end — proving the restore really works, not just that the
bash control flow branches correctly. It also proves: a failing dump leaves
the last good file byte-identical and untouched; retention removes only
genuinely old dumps; and alerting fires exactly once per failure, never on
success. Runs in CI (GitHub-hosted runners have Docker preinstalled).

### A note on the two permission checks, if you run this on Windows

`check-backup.sh` asserts the backup directory is `0700` and each dump is
`0600`. Running the suite locally via Git Bash on Windows, both of these
checks fail (`755`/`644`) — verified independently to be an MSYS/NTFS
permission-reporting limitation of Git Bash itself (a bare `mkdir` + `chmod
0700` + `stat` round-trip shows the identical mismatch with no `backup.sh`
code involved at all), not a defect in `backup.sh`. On the real Ubuntu 24.04
production host, and on the GitHub-hosted Linux CI runner this suite actually
runs on, POSIX permissions are genuine and these checks are meaningful. They
were kept rather than weakened for a platform they were never meant to run on.

## Known limitation

Same as [MONITORING](MONITORING.md)'s "nothing watches the watcher": if
`careerscope-backup.timer` itself silently stops firing (not a failed dump,
but no dump attempt at all), nothing currently alerts on that absence. A true
fix needs an external, off-host dead-man's-switch service — new
infrastructure, out of scope here. `systemctl list-timers
careerscope-backup.timer` shows whether it last ran.
