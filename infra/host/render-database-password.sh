#!/usr/bin/env bash
# Writes the database password into a file that compose.production.yml mounts as a secret. Postgres reads it
# through POSTGRES_PASSWORD_FILE and the app services read it through DATABASE_PASSWORD_FILE, so the password
# is never an environment value and is absent from `docker inspect` and the process list. Run it before
# `docker compose up` (deploy.sh does). Idempotent.
#
# Usage: render-database-password.sh [env-file]   (default: infra/.env next to this script's parent)
set -euo pipefail
umask 077

infra=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
env_file=${1:-$infra/.env}
out_dir=${CAREERSCOPE_SECRETS_DIR:-$infra/.env.secrets}

if [ ! -f "$env_file" ]; then
  echo "env file not found: $env_file" >&2
  exit 1
fi
password=$(sed -n 's/^POSTGRES_PASSWORD=//p' "$env_file" | tail -1)
# The value is read as one plain token, the same rule DATABASE_PASSWORD_FILE applies at startup.
if [[ ! "$password" =~ ^[A-Za-z0-9._~-]{16,}$ ]]; then
  echo "POSTGRES_PASSWORD in $env_file is missing, shorter than 16 characters, or has characters outside A-Za-z0-9._~-" >&2
  exit 1
fi

mkdir -p "$out_dir"
chmod 0700 "$out_dir"
target="$out_dir/database-password"
printf '%s\n' "$password" >"$target.tmp"
# Postgres (uid 70) and the app (uid 1000) both read this file, so it is world-readable inside the
# 0700 secrets directory, which no other host user can enter.
chmod 0444 "$target.tmp"
mv -f "$target.tmp" "$target"
echo "wrote database secret in $out_dir"
