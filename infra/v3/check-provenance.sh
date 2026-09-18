#!/usr/bin/env bash
# Verifies that every answer to "what is deployed" agrees.
#
# This exists because they once did not: DEPLOYED_COMMIT claimed one revision,
# the runtime image label carried an older one, the proxy image had no label at
# all, and the files on disk had been patched in by hand. Provenance that is not
# checked is decoration.
#
# Usage: check-provenance.sh [expected-sha]
set -euo pipefail

root=${CAREERSCOPE_ROOT:-/opt/careerscope}
recorded=$(cat "$root/DEPLOYED_COMMIT" 2>/dev/null || echo missing)
expected=${1:-$recorded}
failures=0

label() {
  docker image inspect "$1" \
    --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null ||
    echo missing
}

check() {
  if [ "$2" = "$3" ]; then
    printf 'PASS %-34s %s\n' "$1" "$2"
  else
    printf 'FAIL %-34s got %s, expected %s\n' "$1" "$2" "$3"
    failures=$((failures + 1))
  fi
}

echo "== expected revision: $expected"
check "DEPLOYED_COMMIT" "$recorded" "$expected"
check "runtime image label" "$(label careerscope:v3)" "$expected"
check "proxy image label" "$(label careerscope:v3-proxy)" "$expected"

# The running API reports the revision baked into its image at startup.
running=$(docker inspect careerscope-api-1 \
  --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null |
  grep '^CAREERSCOPE_REVISION=' | cut -d= -f2- || echo missing)
check "running api revision" "${running:-missing}" "$expected"

# A hand-patched file would make the tree disagree with the archive it came from.
echo "== deployment tree"
if [ -d "$root/.git" ]; then
  echo "WARN  deployment directory contains git metadata; it should be an archive"
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures provenance mismatch(es); the deployment is not traceable" >&2
  exit 1
fi
echo "provenance consistent at $expected"
