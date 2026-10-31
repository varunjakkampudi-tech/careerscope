#!/usr/bin/env bash
# Writes the email OTP HMAC secret and the Resend API key into files that compose.production.yml
# mounts as Docker file secrets into the api service only. The values are never printed, never a
# command-line argument and never a container environment variable, so they are absent from
# `docker inspect` and the process list. Run it before `docker compose up` (deploy.sh does). Idempotent.
#
# EMAIL_OTP_HMAC_SECRET is generated into the env file on first run when missing (openssl rand -hex 32).
# RESEND_API_KEY must be set in the env file by the operator; the script refuses to continue without it.
#
# Usage: render-otp-secrets.sh [env-file]   (default: infra/.env next to this script's parent)
set -euo pipefail
umask 077

infra=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
env_file=${1:-$infra/.env}
out_dir=${CAREERSCOPE_SECRETS_DIR:-$infra/.env.secrets}

if [ ! -f "$env_file" ]; then
  echo "env file not found: $env_file" >&2
  exit 1
fi

hmac=$(sed -n 's/^EMAIL_OTP_HMAC_SECRET=//p' "$env_file" | tail -1)
if [ -z "$hmac" ]; then
  printf 'EMAIL_OTP_HMAC_SECRET=%s\n' "$(openssl rand -hex 32)" >>"$env_file"
  hmac=$(sed -n 's/^EMAIL_OTP_HMAC_SECRET=//p' "$env_file" | tail -1)
  echo "generated EMAIL_OTP_HMAC_SECRET in $env_file"
fi
# A cheap first screen so a bad value stops the deploy here; the API applies the full check
# (isRandomSecret in packages/core) at startup. 64+ hex characters, at least 24 distinct bytes, and
# not digits-only or letters-only.
distinct=$(printf '%s' "$hmac" | fold -w2 | sort -u | wc -l | tr -d ' ')
if [[ ! "$hmac" =~ ^[0-9a-fA-F]{64,}$ ]] || [ $((${#hmac} % 2)) -ne 0 ] || [ "$distinct" -lt 24 ] \
  || [[ "$hmac" =~ ^[0-9]+$ ]] || [[ "$hmac" =~ ^[a-fA-F]+$ ]]; then
  echo "EMAIL_OTP_HMAC_SECRET in $env_file must be at least 64 random hex characters (openssl rand -hex 32)" >&2
  exit 1
fi
# A constant step between consecutive bytes (the counter 00 01 02 ..., constant fill) is not random.
steps=$(printf '%s' "$hmac" | fold -w2 | while read -r pair; do printf '%d\n' "0x$pair"; done \
  | awk 'NR > 1 { print (($1 - prev) + 256) % 256 } { prev = $1 }' | sort -u | wc -l | tr -d ' ')
if [ "$steps" -le 1 ]; then
  echo "EMAIL_OTP_HMAC_SECRET in $env_file looks like a sequence; generate it with openssl rand -hex 32" >&2
  exit 1
fi
resend=$(sed -n 's/^RESEND_API_KEY=//p' "$env_file" | tail -1)
if [[ ! "$resend" =~ ^[A-Za-z0-9._~-]{16,}$ ]]; then
  echo "RESEND_API_KEY in $env_file is missing or malformed (one token of at least 16 characters)" >&2
  exit 1
fi

mkdir -p "$out_dir"
chmod 0700 "$out_dir"
write_secret() {
  local name=$1 value=$2 target="$out_dir/$1"
  printf '%s\n' "$value" >"$target.tmp"
  # The app user is uid 1000 / gid 1000. As root hand the file to group 1000 at 0440; otherwise fall
  # back to 0444, still unreachable to other host users because the directory is 0700.
  if [ "$(id -u)" = 0 ]; then
    chown 999:1000 "$target.tmp"
    chmod 0440 "$target.tmp"
  else
    chmod 0444 "$target.tmp"
  fi
  mv -f "$target.tmp" "$target"
}
write_secret email-otp-hmac-secret "$hmac"
write_secret resend-api-key "$resend"
echo "wrote OTP secret files in $out_dir"
