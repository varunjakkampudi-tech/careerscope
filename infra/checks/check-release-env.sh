#!/usr/bin/env bash
# Proves host/release-env.sh fails closed on a missing DEPLOYED_COMMIT (deploy and apply-migrations
# both use it) unless --first-deploy is passed, and that host/deploy.sh leaves the env file at 0600
# even when it started group-readable. Runs against a stub docker in a temporary tree.
set -euo pipefail

dir="$(cd "$(dirname "$0")" && pwd)"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

rev=0123456789abcdef0123456789abcdef01234567
short=${rev:0:12}
id_runtime="sha256:$(printf 'a%.0s' $(seq 64))"
id_proxy="sha256:$(printf 'b%.0s' $(seq 64))"

mkdir -p "$work/bin" "$work/root/infra/host" "$work/root/infra/docker"
cat >"$work/bin/docker" <<STUB
#!/usr/bin/env bash
if [ "\$1" = image ] && [ "\$2" = inspect ]; then
  case "\$3" in
    careerscope:$short) echo "$id_runtime" ;;
    careerscope:$short-proxy) echo "$id_proxy" ;;
    *) exit 1 ;;
  esac
  exit 0
fi
exit 0
STUB
chmod +x "$work/bin/docker"
cp "$dir"/../host/*.sh "$work/root/infra/host/"
touch "$work/root/infra/docker/compose.production.yml"
cat >"$work/root/RELEASE_RECORD" <<RECORD
REVISION=$rev
CAREERSCOPE_IMAGE=careerscope:$short
CAREERSCOPE_IMAGE_ID=$id_runtime
CAREERSCOPE_PROXY_IMAGE=careerscope:$short-proxy
CAREERSCOPE_PROXY_IMAGE_ID=$id_proxy
RECORD

failures=0
check() {
  if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 :: expected '$3', got '$2'"; failures=$((failures + 1)); fi
}
load() { # <args...> -> exit status; stderr in $work/err
  ( export PATH="$work/bin:$PATH"; . "$work/root/infra/host/release-env.sh"; load_release "$work/root" "$@" ) 2>"$work/err" >/dev/null && echo 0 || echo 1
}

echo "== load_release"
rm -f "$work/root/DEPLOYED_COMMIT"
check "a missing DEPLOYED_COMMIT is refused" "$(load)" "1"
check "the refusal says what to do" "$(grep -c 'DEPLOYED_COMMIT.*--first-deploy' "$work/err")" "1"
check "--first-deploy allows a missing DEPLOYED_COMMIT" "$(load --first-deploy)" "0"
echo "$rev" >"$work/root/DEPLOYED_COMMIT"
check "a matching DEPLOYED_COMMIT is accepted" "$(load)" "0"
echo "fedcba9876543210fedcba9876543210fedcba98" >"$work/root/DEPLOYED_COMMIT"
check "a mismatched DEPLOYED_COMMIT is refused" "$(load)" "1"
check "--first-deploy does not excuse a mismatch" "$(load --first-deploy)" "1"

echo "== apply-migrations.sh and deploy.sh refuse a missing DEPLOYED_COMMIT"
rm -f "$work/root/DEPLOYED_COMMIT"
# apply-migrations.sh has a fixed deployment path, so read its call rather than run it on this host.
check "apply-migrations.sh passes its arguments to load_release" \
  "$(grep -c 'load_release /opt/careerscope "\$@"' "$dir/../host/apply-migrations.sh")" "1"
{
  umask 022
  printf 'POSTGRES_PASSWORD=x\nREDIS_PASSWORD=%s\nEMAIL_OTP_HMAC_SECRET=%s\nRESEND_API_KEY=re_%s\n' \
    "$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')" "$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')" \
    "$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')" >"$work/root/infra/.env"
  chmod 644 "$work/root/infra/.env"
}
deploy() { PATH="$work/bin:$PATH" bash "$work/root/infra/host/deploy.sh" "$@" >/dev/null 2>"$work/err" && echo 0 || echo 1; }
check "deploy.sh without DEPLOYED_COMMIT is refused" "$(deploy example.test internal)" "1"
check "the refusal names DEPLOYED_COMMIT" "$(grep -c 'DEPLOYED_COMMIT' "$work/err")" "1"

if chmod 600 "$work/root/infra/.env" && [ "$(stat -c '%a' "$work/root/infra/.env")" = 600 ]; then
  chmod 644 "$work/root/infra/.env"
  check "deploy.sh --first-deploy succeeds" "$(deploy --first-deploy example.test internal)" "0"
  check "the env file is 0600 after a deploy that started at 0644" "$(stat -c '%a' "$work/root/infra/.env")" "600"
  check "no .next temporary is left behind" "$([ -e "$work/root/infra/.env.next" ] && echo yes || echo no)" "no"
else
  echo "SKIP env file mode checks (this filesystem does not keep POSIX modes)"
fi

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all release-env checks passed"
