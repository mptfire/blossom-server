#!/bin/sh
# Regenerate public/tw.css (precompiled Tailwind). Requires the standalone
# CLI: https://github.com/tailwindlabs/tailwindcss/releases (v3.4.17, matches
# the removed cdn.tailwindcss.com/3.4.17 runtime). Usage: scripts/gen-css.sh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="${TAILWIND_BIN:-$DIR/.tailwindcss-linux-x64}"
[ -x "$BIN" ] || { echo "tailwind CLI not found at $BIN (set TAILWIND_BIN)"; exit 1; }
cd "$DIR/.."
printf '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n' > "$DIR/tw-input.css"
"$BIN" -c "$DIR/tailwind.config.js" -i "$DIR/tw-input.css" -o public/tw.css --minify
rm "$DIR/tw-input.css"
echo "public/tw.css regenerated"
