#!/usr/bin/env bash
# Brings the CareerScope stack up on a host prepared by provision-host.sh.
# Secrets are generated on the host and never leave it.
#
# Usage: deploy.sh [--first-deploy] <domain> <acme-email|internal>
#
# A missing DEPLOYED_COMMIT stops the deploy unless --first-deploy is passed (the very first deploy
# on a new host, before host/ship.sh has recorded a revision).
set -euo pipefail
# Every file this script creates holds secrets: nothing is ever group- or world-readable.
umask 077

first_deploy=""
positional=()
for arg in "$@"; do
  case "$arg" in
    --first-deploy) first_deploy="--first-deploy" ;;
    *) positional+=("$arg") ;;
  esac
done
set -- "${positional[@]+"${positional[@]}"}"

domain=${1:?Usage: deploy.sh [--first-deploy] <domain> <acme-email|internal>}
tls=${2:?Usage: deploy.sh [--first-deploy] <domain> <acme-email|internal>}
infra=$(cd "$(dirname "$0")/.." && pwd)
env_file="$infra/.env"
root=$(cd "$infra/.." && pwd)

# shellcheck source=release-env.sh
. "$(dirname "$0")/release-env.sh"

if [ ! -f "$env_file" ]; then
  umask 077
  cat >"$env_file" <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 32)
EOF
  echo "==> Generated $env_file"
fi

# compose.production.yml requires REDIS_PASSWORD for both Redis instances and for
# every Redis URL. Generate it once on the host and keep it across deploys.
if ! grep -q '^REDIS_PASSWORD=.' "$env_file"; then
  umask 077
  printf 'REDIS_PASSWORD=%s\n' "$(openssl rand -hex 32)" >>"$env_file"
  echo "==> Generated REDIS_PASSWORD in $env_file"
fi

# The images come only from the release record written by build-images.sh (immutable revision tags
# plus the digests recorded at build time). A missing record, a missing value or a tag that no longer
# matches its recorded digest stops the deploy before anything is started.
load_release "$root" $first_deploy || exit 1
[ -n "${CAREERSCOPE_IMAGE:-}" ] && [ -n "${CAREERSCOPE_PROXY_IMAGE:-}" ] || {
  echo "CAREERSCOPE_IMAGE and CAREERSCOPE_PROXY_IMAGE must both be set" >&2
  exit 1
}

# Non-secret settings are rewritten on every deploy so the running stack always
# matches the arguments, while the generated password is preserved.
# The temporary file is created empty and restricted to the owner before any secret is written to it.
rm -f "$env_file.next"
: >"$env_file.next"
chmod 600 "$env_file.next"
# grep exits 1 when no line is left, which is not an error here.
grep -v -E '^(APP_ORIGIN|CAREERSCOPE_DOMAIN|CAREERSCOPE_TLS_MODE|REGISTRATION_ENABLED|CAREERSCOPE_IMAGE|CAREERSCOPE_PROXY_IMAGE)=' "$env_file" >>"$env_file.next" || [ $? -eq 1 ]
cat >>"$env_file.next" <<EOF
APP_ORIGIN=https://$domain
CAREERSCOPE_DOMAIN=$domain
CAREERSCOPE_TLS_MODE=$tls
REGISTRATION_ENABLED=${REGISTRATION_ENABLED:-false}
CAREERSCOPE_IMAGE=$CAREERSCOPE_IMAGE
CAREERSCOPE_PROXY_IMAGE=$CAREERSCOPE_PROXY_IMAGE
EOF
chmod 600 "$env_file.next"
mv "$env_file.next" "$env_file"

# Redis password reaches the containers as mounted files, never as an environment variable.
bash "$(dirname "$0")/render-redis-config.sh" "$env_file"
# The OTP HMAC secret (generated on first run) and the Resend key reach only the api, as files.
bash "$(dirname "$0")/render-otp-secrets.sh" "$env_file"

docker compose -f "$infra/docker/compose.production.yml" --env-file "$env_file" up -d --remove-orphans
docker compose -f "$infra/docker/compose.production.yml" --env-file "$env_file" ps
