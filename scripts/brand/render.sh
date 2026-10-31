#!/usr/bin/env bash
# Renders favicon PNGs/ICO and Open Graph cards from public/favicon.svg and
# scripts/brand/og.html. Needs Google Chrome (macOS path below, or set CHROME)
# and ImageMagick. Run from anywhere: scripts/brand/render.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

shot() { # url width height out
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars \
    --allow-file-access-from-files --default-background-color=00000000 \
    --window-size="$2,$3" --screenshot="$4" "$1" 2>/dev/null
}

printf '<body style="margin:0"><img src="file://%s/public/favicon.svg" width="512" height="512">' \
  "$PWD" >"$TMP/fav.html"
shot "file://$TMP/fav.html" 512 512 "$TMP/fav512.png"
magick "$TMP/fav512.png" -resize 512x512 public/icon-512.png
magick "$TMP/fav512.png" -resize 192x192 public/icon-192.png
# Apple ignores transparency; give the touch icon a solid brand background.
magick "$TMP/fav512.png" -background "#154b3a" -flatten -resize 180x180 public/apple-touch-icon.png
magick "$TMP/fav512.png" -define icon:auto-resize=48,32,16 public/favicon.ico

shot "file://$PWD/scripts/brand/og.html" 1200 630 public/og.png
shot "file://$PWD/scripts/brand/og.html?m=compras" 1200 630 public/og-compras.png
echo "Rendered icons and Open Graph cards into public/"
