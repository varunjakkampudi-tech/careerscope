# Operations — Backup

## Why this exists

Off-host backup was a deliberate decision (see [SECRETS](SECRETS.md) and
[HOSTINGER](HOSTINGER.md) for why), but that left no periodic _local_ dump
either. Recovery depended on someone remembering to run `pg_dump` by hand.
This is CS-25: a scheduled, host-native backup that dumps, proves the dump is
actually restorable, and only then keeps it.

## What is backed up

| Data                                                             | Artefact                                                                         | Location                                                                             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL (everything relational, including parsed resume text) | `careerscope-<stamp>.dump.age` or `.dump.gpg` (pg_dump custom format, encrypted) | `BACKUP_DIR` (default `/var/backups/careerscope`)                                    | Verified by a real restore on every run, then encrypted before it is promoted                                                                                                                                                                                                                                                                                                                                           |
| Resume objects (AES-256-GCM ciphertext)                          | `careerscope-resumes-<stamp>.tar.age` or `.tar.gpg` (encrypted tar)              | `BACKUP_DIR`                                                                         | Archive of `/private/objects` taken from the files container, then encrypted with the dump's backup encryption. Object names carry owner ids and plaintext hashes, so the tar and its listing are only readable with the backup secret                                                                                                                                                                                  |
| Resume encryption key                                            | `careerscope-resume-key-<fingerprint>.key.age` or `.key.gpg` (encrypted)         | `BACKUP_KEY_DIR` (default `/var/lib/careerscope/backup-keys`, owner root, mode 0700) | Encrypted with the backup encryption; no plaintext copy is retained. Named by the first 12 hex characters of the key's SHA-256 and written once per distinct key, not per run. Neither directory may be inside the other (compared with `realpath`). Owner and mode are read back with `stat`. A key directory on the same device as `BACKUP_DIR` fails the run unless `BACKUP_ALLOW_SAME_DEVICE_KEY_DIR=1` (see below) |
| Redis queue                                                      | Not backed up                                                                    |                                                                                      | Disposable by design: commands live in the PostgreSQL outbox and are republished (see [OUTBOX](../architecture/OUTBOX.md))                                                                                                                                                                                                                                                                                              |
| Secrets in `/etc/careerscope-*.env` and the host env files       | Not backed up here                                                               |                                                                                      | Held by the owner in the password manager; see [SECRETS](SECRETS.md)                                                                                                                                                                                                                                                                                                                                                    |

The resume key and the objects share the `private` Docker volume, so a volume
snapshot would put both in one place and defeat encryption at rest. The backup
therefore splits them. Never put the key directory in the same off-host copy as
`BACKUP_DIR`; keep the key in different custody from the archive.

Both artefacts are also encrypted with the same backup encryption as the dump
(`age` or `gpg`), so no owner id, resume hash or key byte is readable in either
directory without the backup secret, and no plaintext key copy sits in the
retained set. The object listing and `tar` stderr, which would expose names,
are written only to root-only staging files and the journal, never to the
backup set. Plaintext `.tar` and `.key` files from older versions are no longer
written; any that remain age out under normal retention (14 days by default),
and can be deleted by hand sooner once an encrypted set exists.

**Same-device placement fails closed.** If `BACKUP_DIR` and `BACKUP_KEY_DIR` are
on the same device (same `stat` device id), the run fails with `STATUS=failed`
and an alert, because one disk copy would then hold the archive beside its key
material. Put the key directory on a different mount. To accept the risk
knowingly (for example a single-disk host, with the backup secret held off the
host), set `BACKUP_ALLOW_SAME_DEVICE_KEY_DIR=1` in `/etc/careerscope-backup.env`;
the run then prints a warning on every run.

## What every scheduled run does

1. **Dump** - `pg_dump`, custom format, captured on the host via
   `docker exec`.
2. **Verify** - restore that exact dump into a disposable scratch database
   inside the same container, run a real sanity query against it (table
   presence, not just "the command exited zero"), then drop the scratch
   database. This is what makes the restore **exercised, not documented**
   (the ticket's own AC2 wording): every run proves its own dump works, not
   just that `pg_dump` did not error.
   **Encrypt** - the verified dump is encrypted before it is promoted: with
   `age` when it is installed and `BACKUP_AGE_RECIPIENT` (or
   `BACKUP_AGE_RECIPIENTS_FILE`) is set, otherwise with `gpg --symmetric`
   (AES-256) using `BACKUP_GPG_PASSPHRASE_FILE`. If neither is available the run
   fails closed (`STATUS=failed`) before it dumps anything. The plaintext copy
   only exists as a `.staging-*` file and is removed on every exit, including
   INT and TERM. Staging files older than 24 hours (left by a SIGKILL or power
   loss) are pruned from both directories at the start of each run.
3. **Resumes and key** - after the dump (so an upload that lands in between
   leaves a harmless orphan object rather than a database row with no object),
   archive `/private/objects` from the files container, confirm the archive
   lists end to end, encrypt it, read `/private/encryption.key`, confirm it is
   exactly 64 hex characters and encrypt a copy named by its fingerprint (skipped
   when that copy already exists). A missing container, unreadable archive or malformed key
   fails the whole run. An empty `BACKUP_FILES_CONTAINER` also fails the run
   (`STATUS=failed`) unless `BACKUP_ALLOW_SKIP_RESUMES=1` is set, which skips this
   step, prints a warning and records `RESUMES=skipped` with
   `STATUS=degraded` (not `ok`, because the backup is partial); it is never
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
refused rather than sent over in cleartext, same as `monitor.sh`. The URL is a
credential, so it is never on a command line: `curl` reads it from a config
passed through process substitution (`-K`) and the payload arrives on stdin, so
`ps` shows neither. A URL containing a double quote, a backslash or a line break
is refused because it could break out of the config value.

### Dump encryption settings

Set these in `/etc/careerscope-backup.env` (the unit loads it). Use one of:

- `age`: install `age` and set `BACKUP_AGE_RECIPIENT=age1...` (the public key;
  keep the identity file off the host) or `BACKUP_AGE_RECIPIENTS_FILE`.
- `gpg`: set `BACKUP_GPG_PASSPHRASE_FILE` to a file with mode 0600 or 0400 that
  is **outside** `BACKUP_DIR` (the run refuses a passphrase file inside it).
  `gpg` runs with a throwaway home inside the staging area, so it does not need
  a writable home directory under `ProtectHome=yes`.

`BACKUP_KEY_DIR` is optional (default `/var/lib/careerscope/backup-keys`). The unit has
`ProtectHome=yes`, so a passphrase file (or key directory) under `/root` or `/home`
is unreadable to the backup run: put the passphrase file somewhere such as
`/etc/careerscope-backup.pass` (mode 0600). `setup-backup.sh` checks these settings
before its immediate backup, prints what to fix, skips the immediate run when they are
wrong and exits non-zero instead of aborting silently.

Keep the age identity or the gpg passphrase with the owner, apart from both the
backup directory and the key directory: whoever holds the dump and its
decryption secret can read every resume and address in the database.

### Off-host copy

Copy **`BACKUP_DIR` only** off the host (the encrypted dumps and the resume
archive, which is already ciphertext). Never copy `BACKUP_KEY_DIR`, the
passphrase or the age identity in the same job: the key must stay in separate
custody from the archive it decrypts, and the dump is useless without its own
secret. An off-host copy of `BACKUP_DIR` is therefore ciphertext only. There is
still no automated off-host copy (see Recovery objectives).

### Status values

`last-status` holds `STATUS=` one of `ok`, `degraded` (resumes skipped by
opt-in), `failed`, or `locked`. A run that finds the lock held by another run
exits 0 on purpose (it is not a failure) and writes `STATUS=locked` with the
time. A lock that stays held leaves that status getting older, so
`bash infra/checks/check-backup.sh --status-only [DIR]` exits 1 for `failed`
and for a `locked` status older than **26 hours** (a hung run). It exits 0 for
`ok`, `degraded` and a recent `locked`.

A good status does not stay good forever. `--status-only` also exits 1 when an
`ok` or `degraded` status is older than the backup interval plus a grace
period: **24 hours + 6 hours = 30 hours** by default (the timer runs daily at
03:30, so a missed run is flagged the same day). Override with
`BACKUP_STATUS_INTERVAL_HOURS` and `BACKUP_STATUS_GRACE_HOURS` (whole numbers).
It also exits 1 for a missing or malformed `AT=` and for a stamp more than five
minutes in the future. Wire it into the scheduler-health check if you want that
alert; nothing calls it automatically today.

Any unexpected failure after the run starts (for example `mkdir` or `chmod` on
the key directory, before the first dump step) is caught by an `ERR` trap that
writes `STATUS=failed` and sends the alert, so it cannot leave yesterday's `ok`
in place. Still fail-closed: the run exits 1 and promotes nothing.

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
  `/var/backups/careerscope` elsewhere. Copy `BACKUP_DIR` (encrypted dumps and the
  resume archive) off-host regularly; keep the key and the dump passphrase in
  separate custody and out of that copy (see "Off-host copy").

## Restoring for real

Do these in order. Step 3 matters most: if the stack starts on an empty volume
before the key is restored, `bootstrap.mjs` creates a new random key, and the
restored resumes will not decrypt.

1. Pick the matching set from `last-status` (it names `FILE`, `RESUMES_FILE` and
   `RESUME_KEY_FILE`) or the directory listing: one
   `careerscope-<stamp>.dump.age` (or `.dump.gpg`), the
   `careerscope-resumes-<stamp>.tar.age` (or `.tar.gpg`) with the closest stamp,
   and the encrypted key `careerscope-resume-key-<fingerprint>.key.age` (or `.key.gpg`).
   Decrypt all three with the backup secret (commands below), to root-only
   temporary files.
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
   umask 077
   B=/var/backups/careerscope
   K=/var/lib/careerscope/backup-keys
   R=$(mktemp -d)   # root-only scratch directory; delete it when done
   # gpg:  gpg --batch --pinentry-mode loopback --passphrase-file /path/to/passphrase -o OUT --decrypt IN
   # age:  age -d -i /path/to/identity.txt -o OUT IN
   gpg --batch --pinentry-mode loopback --passphrase-file /path/to/passphrase \
     -o "$R/resumes.tar" --decrypt "$B/careerscope-resumes-<stamp>.tar.gpg"
   gpg --batch --pinentry-mode loopback --passphrase-file /path/to/passphrase \
     -o "$R/encryption.key" --decrypt "$K/careerscope-resume-key-<fingerprint>.key.gpg"
   docker run --rm -v careerscope_private:/private -v "$R":/restore:ro alpine:3.23 sh -ec '
     mkdir -p /private && umask 077
     tar -xf /restore/resumes.tar -C /private
     cp /restore/encryption.key /private/encryption.key
     chmod 600 /private/encryption.key && chmod 700 /private/objects
     chown -R 1000:1000 /private'
   shred -u "$R/encryption.key" "$R/resumes.tar"; rmdir "$R"
   ```

4. Decrypt and restore the database. Decrypt to a root-only temporary file and
   delete it afterwards:

   ```sh
   umask 077
   # age:  age -d -i /path/to/identity.txt -o /root/restore.dump "$B/careerscope-<stamp>.dump.age"
   gpg --batch --pinentry-mode loopback --passphrase-file /path/to/passphrase \
     -o /root/restore.dump --decrypt "$B/careerscope-<stamp>.dump.gpg"
   docker exec -i careerscope-postgres-1 pg_restore -U careerscope -d careerscope \
     --clean --if-exists --no-owner < /root/restore.dump
   shred -u /root/restore.dump
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
exactly once per failure, never on success. It also proves the promoted dump is
not a plaintext archive and decrypts to a restorable copy with the seeded rows;
that a missing `age` and passphrase fails closed, a group-readable passphrase
file and one inside `BACKUP_DIR` are refused, and a stub `age` is used when
present; that nesting in either direction, a missing `realpath` and a wrong key
directory owner are refused; that an allowed resume skip is `STATUS=degraded`;
that a held lock exits 0 with `STATUS=locked`; that `--status-only` flags
`failed` and a `locked` status older than 26 hours; that the webhook URL is
absent from curl's argv and from every `/proc/*/cmdline` while curl runs (with a
positive control that the process is visible), and that a URL with a quote,
backslash or newline is refused; that TERM removes every staging file; and that
stale staging files are pruned while fresh ones are kept. It also starts a second disposable
container standing in for the files container, with two objects and a key, and
proves: the resume archive and key copy are promoted as separate artefacts and
the archive does not contain the key; extracting the archive reproduces every
object byte for byte; a malformed key fails the whole run and promotes nothing
new; a missing files container fails the run instead of silently skipping
resumes; an empty files container fails closed unless `BACKUP_ALLOW_SKIP_RESUMES=1`;
a key directory inside the backup directory is refused with `STATUS=failed`; the
resume archive and key copy are encrypted, carry no readable object name or key
bytes, and an unchanged key keeps a single copy; a key directory on the same device
fails closed unless `BACKUP_ALLOW_SAME_DEVICE_KEY_DIR=1`; a failure before the first
dump step (an unusable key directory path) still records `STATUS=failed` and alerts;
`--status-only` flags a stale `ok`/`degraded` status (older than 30 hours by default)
and the configured grace period is honoured; and an allowed skip warns and is recorded as
`RESUMES=skipped`. Under Git Bash set `MSYS_NO_PATHCONV=1` (the script does)
so in-container paths are not rewritten. A failed backup is therefore
visible both in `last-status` and the oneshot systemd service result consumed
by scheduler health. Run it with a Linux shell and Docker. Hosted execution has
not been verified for the current commit: Actions is enabled, and the verification status
is recorded in [CI-CD](CI-CD.md) (pending until the run on this commit).

### Running the suite on Windows

`check-backup.sh` asserts the backup directory is `0700`, each dump and key copy is `0600`, and
the key directory is `0700` with the expected owner. Git Bash on NTFS does not keep POSIX permissions
(a bare `mkdir`, `chmod 0700` and `stat` round trip shows the same mismatch with no `backup.sh` code
involved), so on Windows the permission checks fail and, worse, the group-readable passphrase run
succeeds and promotes an extra dump. Every later absolute dump count is then one too high: on
2026-10-28 a Git Bash run gave 96 passes and 11 failures, including "TERM promotes nothing" (expected
1, got 2) and "both real dumps survive retention" (expected 2, got 3). Those are consequences, not
retention or promotion defects: the same suite in an `ubuntu:24.04` container with the Docker socket
passed 124 of 124 checks (124 PASS, 0 FAIL, exit 0) in a run on 2026-10-28. The script now probes `chmod` first and exits with a clear message instead of reporting those
cascades. Run it on Linux or in such a container; the GitHub-hosted Linux runner does the same.

The same script also runs `infra/checks/check-production-config.mjs` when `node`
is installed (CI has it): Go modules pinned to exact versions, no apt upgrade,
required image variables, no Redis password on a command line or in the
environment, `render-redis-config.sh`, and the resume-key bootstrap (atomic
create, no overwrite, clear error for an empty or truncated key). The key file is
written to a temporary file, fsynced and linked into place, so a crash leaves no
key or a whole key; if a truncated key from an earlier version exists, the
bootstrap container stops with a message naming the file and the restore step.

## Known limitation

Same as [MONITORING](MONITORING.md)'s "nothing watches the watcher": if
`careerscope-backup.timer` itself silently stops firing (not a failed dump,
but no dump attempt at all), nothing currently alerts on that absence. A true
fix needs an external, off-host dead-man's-switch service — new
infrastructure, out of scope here. `systemctl list-timers
careerscope-backup.timer` shows whether it last ran.
