#!/usr/bin/env bash
# Builds both images and records the source revision in each, so a running
# container can always be traced back to a commit.
#
# Usage: build-images.sh [revision]
# Defaults to the revision recorded by ship.sh.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
revision=${1:-$(cat "$root/DEPLOYED_COMMIT" 2>/dev/null || echo unknown)}

if [ "$revision" = "unknown" ]; then
  echo "Refusing to build without a revision; pass one or write DEPLOYED_COMMIT" >&2
  exit 1
fi

cd "$root"
echo "==> Building revision $revision"

DOCKER_BUILDKIT=1 docker build \
  -f infra/v3/Dockerfile --target runtime \
  --build-arg "CAREERSCOPE_REVISION=$revision" \
  -t careerscope:v3 .

DOCKER_BUILDKIT=1 docker build \
  -f infra/v3/Dockerfile --target proxy \
  --build-arg "CAREERSCOPE_REVISION=$revision" \
  -t careerscope:v3-proxy .

echo "==> Recorded revision"
docker image inspect careerscope:v3 \
  --format 'runtime {{index .Config.Labels "org.opencontainers.image.revision"}}'
docker image inspect careerscope:v3-proxy \
  --format 'proxy   {{index .Config.Labels "org.opencontainers.image.revision"}}'
