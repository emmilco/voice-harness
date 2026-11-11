#!/bin/bash
# Renders design/mock.html with headless Chrome into design/out/<look>-<theme>.png.
#
#   design/screenshot.sh [harness|editor] [dark|light]   (default: both looks, both themes)
#
# Needs `npm run build -w extension` first (the mock loads the built stylesheets).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUT="$HERE/out"
mkdir -p "$OUT"
LOOKS="${1:-harness editor}"
THEMES="${2:-dark light}"
for look in $LOOKS; do
  for theme in $THEMES; do
    # A temporary copy of the mock with the body classes for this variant.
    tmp="$HERE/.mock-$look-$theme.html"
    sed -E "s/<body class=\"[^\"]*\">/<body class=\"vscode-$theme$([ "$look" = harness ] && echo ' look-harness')$([ "$look" = harness ] && [ "$theme" = dark ] && echo ' page-dark')\">/" "$HERE/mock.html" > "$tmp"
    "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
      --window-size=420,1000 --screenshot="$OUT/$look-$theme.png" "file://$tmp" 2>/dev/null
    rm -f "$tmp"
    echo "$OUT/$look-$theme.png"
  done
done
