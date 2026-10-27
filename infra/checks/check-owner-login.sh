#!/usr/bin/env bash
# Confirms the owner account can sign in, then closes the session it opened.
# Does not change the password.
#
# Usage: printf '%s' "$PASSWORD" | infra/checks/check-owner-login.sh <origin> <email>
# Or run it in a terminal and type the password when prompted (input is not echoed).
# The password is read from stdin so it never appears in the process list or shell history.
set -euo pipefail

origin=${1:?origin required}
email=${2:?email required}
if [ -t 0 ]; then
  IFS= read -rsp 'Password: ' password
  echo
else
  IFS= read -r password
fi
[ -n "$password" ] || { echo 'password required on stdin' >&2; exit 2; }
jar=$(mktemp)
trap 'rm -f "$jar"' EXIT

# Escape for a JSON string: backslash first, then double quote.
json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

echo "== accounts present"
docker exec careerscope-postgres-1 psql -U careerscope -d careerscope -tAc \
  "SELECT count(*) || ' user(s); owner=' || coalesce(min(email),'none') FROM users"

echo "== login"
# printf is a shell builtin and curl reads the body from stdin, so the password is never an argument.
printf '{"email":"%s","password":"%s"}' "$(json_escape "$email")" "$(json_escape "$password")" |
  curl -s -c "$jar" -o /dev/null -w 'login=%{http_code}\n' -X POST \
    -H 'Content-Type: application/json' -H "Origin: $origin" \
    --data-binary @- "$origin/api/login"

echo "== session"
csrf=$(curl -s -b "$jar" "$origin/api/session" | sed -n 's/.*"csrf":"\([^"]*\)".*/\1/p')
[ -n "$csrf" ] && echo "authenticated=true" || echo "authenticated=false"

echo "== logout"
curl -s -b "$jar" -c "$jar" -o /dev/null -w 'logout=%{http_code}\n' -X POST \
  -H "Origin: $origin" -H "X-CSRF-Token: $csrf" "$origin/api/logout"
