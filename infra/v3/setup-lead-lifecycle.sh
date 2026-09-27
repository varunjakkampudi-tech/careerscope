#!/usr/bin/env bash
# Installs CS-27's two timers: lead liveness checking and search-results
# retention. Idempotent - safe to re-run.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root" >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is not present; refusing to install these timers" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not present; refusing to install these timers" >&2
  exit 1
fi

dir="$(cd "$(dirname "$0")" && pwd)"

echo "== installing systemd units"
for unit in careerscope-liveness.service careerscope-liveness.timer \
  careerscope-retention.service careerscope-retention.timer; do
  install -o root -g root -m 0644 "$dir/$unit" "/etc/systemd/system/$unit"
done

echo "== enabling timers"
systemctl daemon-reload
systemctl enable --quiet careerscope-liveness.timer careerscope-retention.timer
systemctl restart careerscope-liveness.timer careerscope-retention.timer

echo "== timer status"
systemctl list-timers careerscope-liveness.timer careerscope-retention.timer --no-pager

echo "CS-27 timers installed"
