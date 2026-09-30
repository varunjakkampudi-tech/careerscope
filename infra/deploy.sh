#!/usr/bin/env bash
# Brings the CareerScope stack up on a host prepared by provision-host.sh.
# Secrets are generated on the host and never leave it.
#
# Usage: deploy.sh <domain> <acme-email|internal>
set -euo pipefail

domain=${1:?Usage: deploy.sh <domain> <acme-email|internal>}
tls=${2:?Usage: deploy.sh <domain> <acme-email|internal>}
root=$(cd "$(dirname "$0")" && pwd)
env_file="$root/.env"

if [ ! -f "$env_file" ]; then
  umask 077
  cat >"$env_file" <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 32)
EOF
  echo "==> Generated $env_file"
fi

# Non-secret settings are rewritten on every deploy so the running stack always
# matches the arguments, while the generated password is preserved.
grep -v -E '^(APP_ORIGIN|CAREERSCOPE_DOMAIN|CAREERSCOPE_TLS_MODE|REGISTRATION_ENABLED)=' "$env_file" >"$env_file.next"
cat >>"$env_file.next" <<EOF
APP_ORIGIN=https://$domain
CAREERSCOPE_DOMAIN=$domain
CAREERSCOPE_TLS_MODE=$tls
REGISTRATION_ENABLED=${REGISTRATION_ENABLED:-false}
EOF
chmod 600 "$env_file.next"
mv "$env_file.next" "$env_file"

cd "$root"
docker compose -f compose.production.yml --env-file .env up -d --remove-orphans
docker compose -f compose.production.yml --env-file .env ps
