#!/bin/sh
#
# Container entrypoint: bring the database up to date, then hand off.
#
# Migration runs on every boot rather than as a one-off deploy step. It is
# idempotent — `runMigration` checks the schema version and returns early when
# there is nothing to do — and doing it here means a fresh volume, a restarted
# container and a rolled-forward image all reach the same state without anyone
# remembering to run a command.
#
# `exec` on the last line so the server replaces this shell as PID 1 and
# receives SIGTERM directly. apps/api/src/index.ts installs its own handlers
# and drains in-flight requests; a wrapper shell would swallow the signal and
# leave Docker to SIGKILL after the grace period.
set -eu
umask 077

echo "[entrypoint] migrating database in ${DATA_DIR:-/app/data}"
node /app/apps/api/dist/db/migrate.js

# Seeded from /app/seed, not /app/data: the data directory is a mounted volume
# and would hide the files the image shipped. Failure here is not fatal — an
# empty companies table costs enrichment quality, not correctness — so a bad
# seed file must not stop the API from starting.
if [ -f /app/seed/companies.json ]; then
  echo "[entrypoint] seeding company directory"
  node /app/apps/api/dist/db/seed.js /app/seed/companies.json || \
    echo "[entrypoint] seed failed; continuing without it"
fi

echo "[entrypoint] starting: $*"
exec "$@"
