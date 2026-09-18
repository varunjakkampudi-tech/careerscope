#!/usr/bin/env bash
# Ships a build context to the deployed host.
#
# The generated database password lives in infra/v3/.env on the host and is the
# only copy. An earlier version of this procedure replaced the deployment
# directory wholesale and destroyed it, which would have made the next deploy
# generate a fresh password that the existing database volume rejects. The
# secret is therefore preserved explicitly and restored afterwards.
#
# The shipped revision is recorded here because nothing else did. build-images.sh
# and check-provenance.sh both read <target>/DEPLOYED_COMMIT, but no script ever
# wrote it, so provenance failed on a deployment that was otherwise correct.
# It lives at the deployment root, not in infra/v3, because that is where both
# readers look.
#
# Usage: ship.sh <archive> [revision] [target-dir]
set -euo pipefail

archive=${1:?Usage: ship.sh <archive> [revision] [target-dir]}
revision=${2:-}
target=${3:-/opt/careerscope}
secret="$target/infra/v3/.env"
preserved=""

if [ -f "$secret" ]; then
  preserved=$(mktemp)
  cp -p "$secret" "$preserved"
  echo "==> Preserved existing $secret"
fi

# Carried across the wipe below: the revision is the only record of what the
# previous deployment was, and losing it is how a rollback loses its target.
previous=""
if [ -f "$target/DEPLOYED_COMMIT" ]; then
  previous=$(cat "$target/DEPLOYED_COMMIT")
fi

rm -rf "$target"
mkdir -p "$target"
tar -xzf "$archive" -C "$target"

# A Windows checkout can carry CRLF, which breaks every shell script on Linux.
( cd "$target/infra/v3" && sed -i 's/\r$//' ./*.sh Caddyfile* ./*.yml Dockerfile* 2>/dev/null || true )

if [ -n "$revision" ]; then
  printf '%s\n' "$revision" >"$target/DEPLOYED_COMMIT"
  echo "==> Recorded DEPLOYED_COMMIT $revision"
  [ -n "$previous" ] && printf '%s\n' "$previous" >"$target/PREVIOUS_COMMIT"
elif [ -n "$previous" ]; then
  printf '%s\n' "$previous" >"$target/DEPLOYED_COMMIT"
  echo "==> No revision given; carried forward $previous"
else
  echo "==> WARNING: no revision recorded; provenance will fail until one is written" >&2
fi

if [ -n "$preserved" ]; then
  install -m 600 "$preserved" "$secret"
  rm -f "$preserved"
  echo "==> Restored $secret"
else
  echo "==> No existing environment file; deploy.sh will generate one"
fi

echo "==> Shipped to $target"
