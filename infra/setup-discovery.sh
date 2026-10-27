#!/usr/bin/env bash
# Installs the CS-26 scheduled-discovery timer. Idempotent - safe to re-run.
#
# The timer always fires on schedule (that is infrastructure, and is correct
# to always run, matching CS-24/CS-25). Whether it actually *does* anything
# is gated inside run-scheduled-discovery.ts by each owner's own
# scheduledDiscoveryEnabled flag, which defaults false - so installing this
# timer does not, by itself, turn unattended discovery on for anyone.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root" >&2
  exit 1
fi

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemd is not present; refusing to install the discovery timer" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not present; refusing to install the discovery timer" >&2
  exit 1
fi

dir="$(cd "$(dirname "$0")" && pwd)"

echo "== installing systemd units"
install -o root -g root -m 0644 "$dir/careerscope-discovery.service" /etc/systemd/system/careerscope-discovery.service
install -o root -g root -m 0644 "$dir/careerscope-discovery.timer" /etc/systemd/system/careerscope-discovery.timer

echo "== enabling timer"
systemctl daemon-reload
systemctl enable --quiet careerscope-discovery.timer
systemctl restart careerscope-discovery.timer

echo "== timer status"
systemctl list-timers careerscope-discovery.timer --no-pager

echo "discovery timer installed (scheduled discovery is still off for every owner until they enable it)"
