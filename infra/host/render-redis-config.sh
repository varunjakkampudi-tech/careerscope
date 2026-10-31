#!/usr/bin/env bash
# Writes the Redis password into config files that compose.production.yml mounts as secrets, so the
# password is never a command-line argument or an environment variable of a Redis container (and so
# is absent from `docker inspect` and the process list). Run it before `docker compose up`;
# deploy.sh-style flows must call it after REDIS_PASSWORD exists in infra/.env. Idempotent.
#
# Usage: render-redis-config.sh [env-file]   (default: infra/.env next to this script's parent)
set -euo pipefail
umask 077

infra=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
env_file=${1:-$infra/.env}
out_dir=${CAREERSCOPE_SECRETS_DIR:-$infra/.env.secrets}

if [ ! -f "$env_file" ]; then
  echo "env file not found: $env_file" >&2
  exit 1
fi
password=$(sed -n 's/^REDIS_PASSWORD=//p' "$env_file" | tail -1)
# The value is written unquoted into a Redis config line, so only a plain token is accepted.
if [[ ! "$password" =~ ^[A-Za-z0-9._~-]{16,}$ ]]; then
  echo "REDIS_PASSWORD in $env_file is missing, shorter than 16 characters, or has characters outside A-Za-z0-9._~-" >&2
  exit 1
fi

mkdir -p "$out_dir"
chmod 0700 "$out_dir"
for name in redis redis-queue; do
  target="$out_dir/$name.conf"
  printf 'requirepass %s\n' "$password" >"$target.tmp"
  # The Redis user inside the image is uid 999 / gid 1000. As root hand it the file at 0400; otherwise
  # fall back to 0444, still unreachable to other host users because the directory is 0700.
  if [ "$(id -u)" = 0 ]; then
    chown 999:1000 "$target.tmp"
    chmod 0400 "$target.tmp"
  else
    chmod 0444 "$target.tmp"
  fi
  mv -f "$target.tmp" "$target"
done
echo "wrote Redis secret configs in $out_dir"
