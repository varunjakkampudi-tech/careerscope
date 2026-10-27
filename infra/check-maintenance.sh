#!/usr/bin/env bash
# Proves the maintenance page cannot be broken open by operator-supplied text.
# The reason and expected-return strings land in HTML attributes, so a quote or
# an angle bracket must not terminate the attribute or the tag.
#
# Counts occurrences, not matching lines: the generated tag is a single line, so
# `grep -c` would report 1 no matter how badly the document was mangled.
set -euo pipefail

cd "$(dirname "$0")"
dir=${CAREERSCOPE_MAINTENANCE_DIR:-/srv/maintenance}
page="$dir/index.html"
failures=0

count() { grep -o -- "$1" "$page" | wc -l | tr -d ' '; }

check() {
  if [ "$2" = "$3" ]; then
    echo "PASS $1"
  else
    echo "FAIL $1 :: expected '$3', got '$2'"
    failures=$((failures + 1))
  fi
}

echo "== hostile reason and expected-return text"
bash maintenance.sh enable 'bad" onload="alert(1)' '</title><script>alert(2)</script>' >/dev/null

check "document has exactly one body tag" "$(count '<body')" "1"
check "quote escaped in reason" "$(count 'data-reason="bad&quot;')" "1"
check "angle brackets escaped in eta" "$(count 'data-eta="&lt;/title&gt;')" "1"
# An unescaped quote would close the attribute and leave a live handler.
check "no live event handler" "$(count 'onload="')" "0"
check "no raw script tag" "$(count '<script>alert')" "0"

echo "== ampersand is not re-expanded into the matched text"
bash maintenance.sh enable 'R&D systems upgrade' >/dev/null
check "ampersand escaped once" "$(count 'data-reason="R&amp;D systems upgrade"')" "1"
check "no body tag duplication" "$(count '<body')" "1"

echo "== benign text still renders"
bash maintenance.sh enable 'Deploying an update.' 'About 10 minutes' >/dev/null
check "reason preserved" "$(count 'data-reason="Deploying an update."')" "1"
check "eta preserved" "$(count 'data-eta="About 10 minutes"')" "1"

echo "== toggle"
bash maintenance.sh disable >/dev/null
check "disabled" "$(bash maintenance.sh status)" "maintenance=disabled"

if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all maintenance checks passed"
