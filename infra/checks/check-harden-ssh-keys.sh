#!/usr/bin/env bash
# Proves harden-ssh.sh counts usable authorized keys as exactly one integer, so the lockout
# guard cannot fail open. Sources the script without running hardening (S1-F042).
set -euo pipefail

dir="$(cd "$(dirname "$0")" && pwd)"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

export HARDEN_SSH_SOURCE_ONLY=1
# shellcheck source=../host/harden-ssh.sh
source "$dir/../host/harden-ssh.sh"

failures=0
check() {
  if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 :: expected '$3', got '$2'"; failures=$((failures + 1)); fi
}

printf 'ssh-ed25519 AAAAC3NzaC1 operator\n' >"$work/ed25519"
printf 'ecdsa-sha2-nistp256 AAAAE2VjZHNh host\n' >"$work/ecdsa"
printf 'sk-ssh-ed25519@openssh.com AAAAGnNr operator\n' >"$work/sk"
printf '# comment only\n\n' >"$work/none"
: >"$work/empty"

check "a single ssh-ed25519 key is counted" "$(count_authorized_keys "$work/ed25519")" "1"
check "an ecdsa-only file counts its key" "$(count_authorized_keys "$work/ecdsa")" "1"
check "a security-key file counts its key" "$(count_authorized_keys "$work/sk")" "1"
check "a file with no keys counts zero, as one line" "$(count_authorized_keys "$work/none")" "0"
check "an empty file counts zero, as one line" "$(count_authorized_keys "$work/empty")" "0"
check "a missing file counts zero, as one line" "$(count_authorized_keys "$work/missing")" "0"
check "the count is always one line" \
  "$(count_authorized_keys "$work/none" | wc -l | tr -d ' ')" "1"

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all harden-ssh key-count checks passed"
