#!/usr/bin/env bash
# Confirms the owner account can sign in and that the password-change path is
# reachable, then closes the session it opened. Does not change the password.
set -euo pipefail

origin=${1:?origin required}
email=${2:?email required}
password=${3:?password required}
jar=$(mktemp)

echo "== accounts present"
docker exec careerscope-postgres-1 psql -U careerscope -d careerscope -tAc \
  "SELECT count(*) || ' user(s); owner=' || coalesce(min(email),'none') FROM users"

echo "== login"
curl -s -c "$jar" -o /dev/null -w 'login=%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' -H "Origin: $origin" \
  -d "{\"email\":\"$email\",\"password\":\"$password\"}" "$origin/api/login"

echo "== session"
csrf=$(curl -s -b "$jar" "$origin/api/session" | sed -n 's/.*"csrf":"\([^"]*\)".*/\1/p')
[ -n "$csrf" ] && echo "authenticated=true" || echo "authenticated=false"

echo "== password change endpoint reachable (wrong current password must be refused)"
curl -s -b "$jar" -o /dev/null -w 'wrong_current=%{http_code}\n' -X POST \
  -H 'Content-Type: application/json' -H "Origin: $origin" -H "X-CSRF-Token: $csrf" \
  -d '{"currentPassword":"definitely-not-it","newPassword":"AnotherTempValue123"}' \
  "$origin/api/account/password"

echo "== logout"
curl -s -b "$jar" -c "$jar" -o /dev/null -w 'logout=%{http_code}\n' -X POST \
  -H "Origin: $origin" -H "X-CSRF-Token: $csrf" "$origin/api/logout"

rm -f "$jar"
