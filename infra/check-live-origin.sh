#!/usr/bin/env bash
# Explicit operator smoke: never registers/deletes users or reads database data.
# Store the staging netrc outside Git with owner-only permissions.
set -euo pipefail
set +x
origin=${1:?Usage: check-live-origin.sh <https-origin>}
[[ "$origin" == https://* && "$origin" != */ ]] || exit 1
: "${CAREERSCOPE_STAGING_NETRC:?Private staging netrc file required}"
: "${CAREERSCOPE_TEST_EMAIL:?Existing test identity required}"
[[ -f "$CAREERSCOPE_STAGING_NETRC" ]] || exit 1
scratch=$(mktemp -d)
chmod 700 "$scratch"
trap 'rm -f -- "$scratch/headers" "$scratch/cookies" "$scratch/session"; rmdir -- "$scratch"' EXIT
client=(curl --silent --show-error --max-time 20 --netrc-file "$CAREERSCOPE_STAGING_NETRC")
payload=$(node -e 'process.stdout.write(JSON.stringify({email:process.env.CAREERSCOPE_TEST_EMAIL}))')
code=$("${client[@]}" -D "$scratch/headers" -c "$scratch/cookies" -o /dev/null -w '%{http_code}' \
  -H 'Content-Type: application/json' -H "Origin: $origin" -d "$payload" "$origin/api/login")
[[ "$code" == 200 ]] || { echo "Test selection failed: HTTP $code" >&2; exit 1; }
node -e 'const h=require("node:fs").readFileSync(process.argv[1],"utf8");const c=h.split(/\r?\n/).find(v=>/^set-cookie:/i.test(v));if(!c||!["httponly","secure","samesite=strict"].every(v=>c.toLowerCase().includes(v)))process.exit(1)' "$scratch/headers"
echo 'PASS secure HttpOnly SameSite=Strict session cookie'
for foreign in https://foreign.example ''; do
  code=$("${client[@]}" -o /dev/null -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' -H "Origin: $foreign" -d "$payload" "$origin/api/login")
  [[ "$code" == 403 ]] || { echo "Origin refusal failed: HTTP $code" >&2; exit 1; }
done
echo 'PASS foreign/missing Origin refused'
code=$(curl --silent --show-error --max-time 20 -o /dev/null -w '%{http_code}' "$origin/api/session")
[[ "$code" == 401 ]] || { echo "Staging password boundary failed: HTTP $code" >&2; exit 1; }
echo 'PASS anonymous staging access refused'
"${client[@]}" --fail -b "$scratch/cookies" -o "$scratch/session" "$origin/api/session"
csrf=$(node -e 'const s=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));if(!s.authenticated||typeof s.csrf!=="string")process.exit(1);process.stdout.write(s.csrf)' "$scratch/session")
code=$("${client[@]}" -b "$scratch/cookies" -o /dev/null -w '%{http_code}' -X POST \
  -H "Origin: $origin" -H "x-csrf-token: $csrf" "$origin/api/logout")
[[ "$code" == 200 ]] || { echo "Logout failed: HTTP $code" >&2; exit 1; }
echo 'PASS logout; temporary credential artifacts removed on exit'
