#!/usr/bin/env bash
# Verifies the deployed origin's session cookie attributes, CSRF origin check and
# proxy header handling. Creates a throwaway account and removes it afterwards.
set -euo pipefail

origin=${1:?Usage: check-live-origin.sh <https-origin>}
email="verify-$(date +%s)-$RANDOM@careerscope.tech"
password="V$(openssl rand -hex 12)!q"

redact() { sed -E 's/(session=)[^;]+/\1<redacted>/I'; }

echo "== registration"
registration=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' -H "Origin: $origin" \
  -d "{\"email\":\"$email\",\"password\":\"$password\"}" "$origin/api/register")
echo "register=$registration"

# Without an account the cookie checks below cannot run. Say so rather than
# reporting a 401 as though it were a result.
if [ "$registration" != "202" ]; then
  echo "SKIPPED: registration is disabled, so session cookie attributes cannot be" >&2
  echo "         verified. Re-run with REGISTRATION_ENABLED=true bash deploy.sh ..." >&2
  exit 2
fi

echo "== login cookie attributes"
curl -sD - -o /dev/null -X POST \
  -H 'Content-Type: application/json' -H "Origin: $origin" \
  -d "{\"email\":\"$email\",\"password\":\"$password\"}" "$origin/api/login" \
  | grep -iE '^HTTP|^set-cookie' | redact

echo "== cross-origin write is refused"
curl -s -o /dev/null -w 'foreign_origin=%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' -H 'Origin: https://evil.example' \
  -d "{\"email\":\"$email\",\"password\":\"$password\"}" "$origin/api/login"

echo "== no-origin write is refused"
curl -s -o /dev/null -w 'no_origin=%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$email\",\"password\":\"$password\"}" "$origin/api/login"

echo "== spoofed forwarding headers are ignored"
curl -s -o /dev/null -w 'forwarded=%{http_code}\n' \
  -H 'X-Forwarded-For: 1.2.3.4' -H 'X-Forwarded-Host: evil.example' \
  -H 'X-Forwarded-Proto: http' "$origin/"

echo "== unauthenticated access is refused"
curl -s -o /dev/null -w 'anonymous_preparation=%{http_code}\n' "$origin/api/preparation"

echo "== throwaway account removed"
docker exec careerscope-postgres-1 \
  psql -U careerscope -d careerscope -tAc \
  "DELETE FROM sessions WHERE owner_id IN (SELECT id FROM users WHERE email = '$email');
   DELETE FROM users WHERE email = '$email';
   SELECT count(*) FROM users;" \
  | tail -1 | sed 's/^/remaining_users=/'
