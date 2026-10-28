# Operations — Backup

## Why this exists

Off-host backup was a deliberate decision (see [SECRETS](SECRETS.md) and
[HOSTINGER](HOSTINGER.md) for why), but that left no periodic _local_ dump
either. Recovery depended on someone remembering to run `pg_dump` by hand.
This is CS-25: a scheduled, host-native backup that dumps, proves the dump is
actually restorable, and only then keeps it.

## What is backed up

| Data                                                             | Artefact                                           | Location                                                                 | Notes                                                                                                                      |
| ---------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL (everything relational, including parsed resume text) | `careerscope-<stamp>.dump` (pg_dump custom format) | `BACKUP_DIR` (default `/var/backups/careerscope`)                        | Verified by a real restore on every run                                                                                    |
| Resume objects (AES-256-GCM ciphertext)                          | `careerscope-resumes-<stamp>.tar`                  | `BACKUP_DIR`                                                             | Archive of `/private/objects` taken from the files container; unreadable without the key                                   |
| Resume encryption key                                            | `careerscope-resume-key-<stamp>.key`               | `BACKUP_KEY_DIR` (default `/var/lib/careerscope/backup-keys`, mode 0700) | Must resolve outside `BACKUP_DIR`: the run fails otherwise. Prefer a different mount                                       |
| Redis queue                                                      | Not backed up                                      |                                                                          | Disposable by design: commands live in the PostgreSQL outbox and are republished (see [OUTBOX](../architecture/OUTBOX.md)) |
| Secrets in `/etc/careerscope-*.env` and the host env files       | Not backed up here                                 |                                                                          | Held by the owner in the password manager; see [SECRETS](SECRETS.md)                                                       |

The resume key and the objects share the `private` Docker volume, so a volume
snapshot would put both in one place and defeat encryption at rest. The backup
therefore splits them. Keep copies of the key and of the archive in different
custody when you copy them off the host.

## What every scheduled run does

1. **Dump** - `pg_dump`, custom format, captured on the host via
   `docker exec`.
2. **Verify** - restore that exact dump into a disposable scratch database
   inside the same container, run a real sanity query against it (table
   presence, not just "the command exited zero"), then drop the scratch
   database. This is what makes the restore **exercised, not documented**
   (the ticket's own AC2 wording): every run proves its own dump works, not
   just that `pg_dump` did not error.
3. **Resumes and key** - after the dump (so an upload that lands in between
   leaves a harmless orphan object rather than a database row with no object),
   archive `/private/objects` from the files container, confirm the archive
   lists end to end, read `/private/encryption.key` and confirm it is exactly 64
   hex characters. A missing container, unreadable archive or malformed key
   fails the whole run. An empty `BACKUP_FILES_CONTAINER` also fails the run
   (`STATUS=failed`) unless `BACKUP_ALLOW_SKIP_RESUMES=1` is set, which skips this
   step, prints a warning and records `RESUMES=skipped`; it is never
   skipped by default.
4. **Promote** - only if every step above succeeded, move the dump, archive and
   key into place together and apply retention (default 14 days). Anything
   that fails is deleted, not promoted, the last known-good files are left
   exactly as they were, and `last-status` says `failed`, so a failed backup
   can never look like a current one (AC3).

## How it runs

[backup.sh](../../infra/host/backup.sh) runs **on the host**, the same way
[monitor.sh](../../infra/host/monitor.sh) does, via `careerscope-backup.timer`
(daily at 03:30, off-peak). Dumps contain private data — resumes, emails,
everything else in the database — so the backup directory and every file in
it are root-only (`0700`/`0600`), per this ticket's own `securityImpact`.

## Install

```sh
bash infra/host/setup-backup.sh
```

Idempotent, same pattern as `setup-monitoring.sh`. A failed backup alerts to
`BACKUP_WEBHOOK_URL` in `/etc/careerscope-backup.env`, or reuses
`MONITOR_WEBHOOK_URL` (CS-24's webhook) if that's the only one configured —
one payload works for both Slack and Discord, and a non-`https://` URL is
refused rather than sent over in cleartext, same as `monitor.sh`.

## Recovery objectives

| Objective                      | Value                                                               | Basis                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| RPO (data you can lose)        | Up to 24 hours plus run time for both the database and resume files | One run per day at 03:30; a failed run alerts and leaves yesterday as the latest, so one missed run means up to about 48 hours |
| RTO (time to be serving again) | Target 4 hours from a decision to restore                           | Host provisioning and image build dominate; the data restore itself is minutes at the current data size                        |

What is measured and what is assumed:

- Measured: `check-backup.sh` restores a fixture dump and archive and compares
  checksums; the extraction of the fixture archive takes under one second.
- Assumed, not measured: restore time at production size (it grows linearly
  with database size) and host rebuild time. Re-time the procedure below on a
  scratch host once real data exists and update this table.
- These objectives cover loss of data or of the Docker volumes. They do **not**
  cover loss of the host itself: backups are written to the same host, and
  there is no automated off-host copy (a deliberate, recorded decision). If the
  host disk is lost, the RPO is unbounded unless someone copied
  `/var/backups/careerscope` elsewhere. Copy the dump, the archive and the key
  off-host regularly and in separate custody.

## Restoring for real

Do these in order. Step 3 matters most: if the stack starts on an empty volume
before the key is restored, `bootstrap.mjs` creates a new random key, and the
restored resumes will not decrypt.

1. Pick the matching set from `last-status` or the directory listing: one
   `careerscope-<stamp>.dump`, the `careerscope-resumes-<stamp>.tar` with the
   closest stamp, and the key file `careerscope-resume-key-*.key`.
2. On the target host, bring up only PostgreSQL and make sure the application
   services (`api`, `publisher`, `search`, `files`, `web`) are stopped:

   ```sh
   docker compose -f infra/docker/compose.production.yml up -d postgres
   docker compose -f infra/docker/compose.production.yml stop api publisher search files web
   ```

3. Restore the key and the objects into the `private` volume before anything
   else writes to it (the volume is `careerscope_private` under the default
   project name):

   ```sh
   B=/var/backups/careerscope
   K=/var/lib/careerscope/backup-keys
   docker run --rm -v careerscope_private:/private -v "$B":/backup:ro -v "$K":/keys:ro alpine:3.23 sh -ec '
     mkdir -p /private && umask 077
     tar -xf /backup/careerscope-resumes-<stamp>.tar -C /private
     cp /keys/careerscope-resume-key-<stamp>.key /private/encryption.key
     chmod 600 /private/encryption.key && chmod 700 /private/objects
     chown -R 1000:1000 /private'
   ```

4. Restore the database:

   ```sh
   docker exec -i careerscope-postgres-1 pg_restore -U careerscope -d careerscope \
     --clean --if-exists --no-owner < "$B/careerscope-<stamp>.dump"
   ```

   Every scheduled run already proves a restore of that exact file succeeds
   (see "Verify" above); this is the same operation aimed at the real database.

5. Start the stack and apply any migrations newer than the dump:
   `bash infra/host/restart-stack.sh` then `bash infra/host/apply-migrations.sh`.
6. Verify before announcing recovery:
   - `/api/health` returns 200 and an owner can sign in.
   - Open a known resume (or let a new upload parse). A decryption error
     means the wrong key was restored: stop and redo step 3 with the key copy
     whose stamp matches.
   - `SELECT count(*) FROM outbox_events WHERE published_at IS NULL OR id IN
(SELECT id FROM command_executions WHERE status = 'running')` drains to
     zero: the publisher republishes anything the lost Redis queue held.
7. Expect two harmless effects from restoring a snapshot: resume objects with
   no database row (uploads that landed after the dump) can be removed by the
   storage sweep, and work committed after the dump is gone (the RPO).

Redis needs no restore. If the queue volume is lost, commands are recovered from
the PostgreSQL outbox after the two-minute republish window.

## Verification

```sh
bash infra/checks/check-backup.sh
```

Unlike `check-monitoring.sh`, this is **not** stub-based: it starts a
disposable `postgres:17.6-alpine` container, seeds it with real tables and
rows, and runs the actual `pg_dump`/`pg_restore`/sanity-query pipeline
against it end to end — proving the restore really works, not just that the
bash control flow branches correctly. It also proves: failed dumps and invalid
retention configuration return nonzero; a failing dump leaves the last good
file byte-identical and untouched; invalid retention settings do not change
backup state; retention removes only genuinely old dumps; and alerting fires
exactly once per failure, never on success. It also starts a second disposable
container standing in for the files container, with two objects and a key, and
proves: the resume archive and key copy are promoted as separate artefacts and
the archive does not contain the key; extracting the archive reproduces every
object byte for byte; a malformed key fails the whole run and promotes nothing
new; a missing files container fails the run instead of silently skipping
resumes; an empty files container fails closed unless `BACKUP_ALLOW_SKIP_RESUMES=1`;
a key directory inside the backup directory is refused with `STATUS=failed`; and an
allowed skip warns and is recorded as
`RESUMES=skipped`. Under Git Bash set `MSYS_NO_PATHCONV=1` (the script does)
so in-container paths are not rewritten. A failed backup is therefore
visible both in `last-status` and the oneshot systemd service result consumed
by scheduler health. Run it with a Linux shell and Docker. Hosted execution has
not been verified in this checkout because GitHub Actions is disabled.

### A note on the two permission checks, if you run this on Windows

`check-backup.sh` asserts the backup directory is `0700` and each dump and key
copy is `0600`. Running the suite locally via Git Bash on Windows, these three
checks fail (`755`/`644`/`644`) — verified independently to be an MSYS/NTFS
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
