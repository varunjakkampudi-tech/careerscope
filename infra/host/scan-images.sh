#!/usr/bin/env bash
# Scans the built images for fixable CRITICAL/HIGH CVEs and prints the package,
# installed version and fix, so a finding can be traced rather than guessed at.
# Uses a clean cache: a stale Trivy cache previously reported versions that were
# not the ones actually present in the image.
set -euo pipefail

# Scans the images of the current release, never a mutable tag.
runtime=${CAREERSCOPE_IMAGE:?CAREERSCOPE_IMAGE is not set (see the release record or infra/.env)}
proxy=${CAREERSCOPE_PROXY_IMAGE:?CAREERSCOPE_PROXY_IMAGE is not set (see the release record or infra/.env)}

rm -rf /root/.cache/trivy

scan() {
  echo "== $1"
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
    aquasec/trivy:latest image --scanners vuln --severity CRITICAL,HIGH \
    --ignore-unfixed --quiet --format json "$1" 2>/dev/null >/tmp/scan.json
  docker run --rm -v /tmp/scan.json:/tmp/scan.json:ro --entrypoint node "$runtime" -e '
    const report = require("/tmp/scan.json");
    let count = 0;
    for (const result of report.Results || []) {
      for (const item of result.Vulnerabilities || []) {
        count += 1;
        console.log(`  ${item.PkgName} ${item.InstalledVersion} -> ${item.FixedVersion} (${item.VulnerabilityID})`);
      }
    }
    console.log(`  fixable critical/high: ${count}`);
  '
}

scan "$runtime"
scan "$proxy"
