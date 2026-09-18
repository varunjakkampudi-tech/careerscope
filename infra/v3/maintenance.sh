#!/usr/bin/env bash
# Controls the proxy-level maintenance page.
#
# The flag is a file rather than application state, so the page still serves
# while the stack is down or mid-deploy. Health stays reachable throughout.
#
#   maintenance.sh enable ["reason"] ["expected back"]
#   maintenance.sh disable
#   maintenance.sh status
set -euo pipefail

root=$(cd "$(dirname "$0")" && pwd)
target=${CAREERSCOPE_MAINTENANCE_DIR:-/srv/maintenance}
flag="$target/active"

# Operator text lands in an HTML attribute, so it is escaped rather than trusted.
escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'
}

case "${1:-status}" in
  enable)
    reason=${2:-}
    eta=${3:-}
    mkdir -p "$target"
    attributes=""
    [ -n "$reason" ] && attributes=" data-reason=\"$(escape "$reason")\""
    [ -n "$eta" ] && attributes="$attributes data-eta=\"$(escape "$eta")\""
    # Neither sed nor bash pattern substitution is safe here: in a sed
    # replacement '&' means the whole match, and bash 5.2 gave ${var/pat/repl}
    # the same behaviour. Escaped entities such as &quot; would expand back into
    # the matched text and tear the tag open. Splitting and printing avoids any
    # interpretation of the replacement.
    template=$(cat "$root/maintenance/index.html")
    before=${template%%<body>*}
    after=${template#*<body>}
    printf '%s<body%s>%s\n' "$before" "$attributes" "$after" >"$target/index.html"
    date -u +%Y-%m-%dT%H:%M:%SZ >"$flag"
    echo "maintenance=enabled since $(cat "$flag")"
    ;;
  disable)
    rm -f "$flag"
    echo "maintenance=disabled"
    ;;
  status)
    if [ -f "$flag" ]; then
      echo "maintenance=enabled since $(cat "$flag")"
    else
      echo "maintenance=disabled"
    fi
    ;;
  *)
    echo "Usage: maintenance.sh {enable [reason] [eta]|disable|status}" >&2
    exit 2
    ;;
esac
