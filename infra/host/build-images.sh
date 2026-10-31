#!/usr/bin/env bash
# Builds both images from one source revision and records them in an immutable release record.
#
# Each image is tagged with the short revision (careerscope:<short> and careerscope:<short>-proxy).
# No mutable tag such as careerscope:v3 is produced. The build-time image IDs (content digests, sha256 of
# the image config) are written to RELEASE_RECORD at the deployment root; deploy.sh refuses to start
# the stack unless the tags still resolve to those IDs, so a retagged or rebuilt image cannot be
# deployed by accident.
#
# Usage: build-images.sh [revision]
# Defaults to the revision recorded by ship.sh.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
revision=${1:-$(cat "$root/DEPLOYED_COMMIT" 2>/dev/null || echo unknown)}

if [ "$revision" = "unknown" ] || ! [[ "$revision" =~ ^[0-9a-f]{12,40}$ ]]; then
  echo "Refusing to build without a hexadecimal revision (12-40 characters); pass one or write DEPLOYED_COMMIT" >&2
  exit 1
fi
short=${revision:0:12}
runtime_tag="careerscope:$short"
proxy_tag="careerscope:$short-proxy"

cd "$root"
echo "==> Building revision $revision"

DOCKER_BUILDKIT=1 docker build \
  -f infra/docker/Dockerfile --target runtime \
  --build-arg "CAREERSCOPE_REVISION=$revision" \
  -t "$runtime_tag" .

DOCKER_BUILDKIT=1 docker build \
  -f infra/docker/Dockerfile --target proxy \
  --build-arg "CAREERSCOPE_REVISION=$revision" \
  -t "$proxy_tag" .

runtime_id=$(docker image inspect "$runtime_tag" --format '{{.Id}}')
proxy_id=$(docker image inspect "$proxy_tag" --format '{{.Id}}')
for id in "$runtime_id" "$proxy_id"; do
  [[ "$id" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "Unexpected image id '$id'" >&2; exit 1; }
done

record="$root/RELEASE_RECORD"
{
  echo "REVISION=$revision"
  echo "CAREERSCOPE_IMAGE=$runtime_tag"
  echo "CAREERSCOPE_IMAGE_ID=$runtime_id"
  echo "CAREERSCOPE_PROXY_IMAGE=$proxy_tag"
  echo "CAREERSCOPE_PROXY_IMAGE_ID=$proxy_id"
} >"$record.tmp"
mv -f "$record.tmp" "$record"

echo "==> Recorded revision"
docker image inspect "$runtime_tag" \
  --format 'runtime {{index .Config.Labels "org.opencontainers.image.revision"}}'
docker image inspect "$proxy_tag" \
  --format 'proxy   {{index .Config.Labels "org.opencontainers.image.revision"}}'
echo "==> Wrote $record"
