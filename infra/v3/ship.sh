#!/usr/bin/env bash
# Ships a build context to the deployed host.
#
# The generated database password lives in infra/v3/.env on the host and is the
# only copy. An earlier version of this procedure replaced the deployment
# directory wholesale and destroyed it, which would have made the next deploy
# generate a fresh password that the existing database volume rejects. The
# secret is therefore preserved explicitly and restored afterwards.
#
# Usage: ship.sh <archive> [target-dir]
set -euo pipefail

archive=${1:?Usage: ship.sh <archive> [target-dir]}
target=${2:-/opt/careerscope}
secret="$target/infra/v3/.env"
preserved=""

if [ -f "$secret" ]; then
  preserved=$(mktemp)
  cp -p "$secret" "$preserved"
  echo "==> Preserved existing $secret"
fi

rm -rf "$target"
mkdir -p "$target"
tar -xzf "$archive" -C "$target"

# A Windows checkout can carry CRLF, which breaks every shell script on Linux.
( cd "$target/infra/v3" && sed -i 's/\r$//' ./*.sh Caddyfile* ./*.yml Dockerfile* 2>/dev/null || true )

if [ -n "$preserved" ]; then
  install -m 600 "$preserved" "$secret"
  rm -f "$preserved"
  echo "==> Restored $secret"
else
  echo "==> No existing environment file; deploy.sh will generate one"
fi

echo "==> Shipped to $target"
