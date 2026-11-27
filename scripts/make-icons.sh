#!/usr/bin/env bash
# Builds the extension icons from icons/source.png. macOS only: uses sips.
# 48 and 128 use the full portrait; 16 and 32 crop to the face so it stays readable in the toolbar.
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
side=$(sips -g pixelWidth -g pixelHeight icons/source.png | awk '/pixel/ {print $2}' | sort -n | head -1)
sips -s format png -c "$side" "$side" icons/source.png --out "$tmp/full.png" >/dev/null
sips -s format png -c 640 640 --cropOffset 150 380 icons/source.png --out "$tmp/face.png" >/dev/null
for size in 48 128; do sips -z "$size" "$size" "$tmp/full.png" --out "icons/icon${size}.png" >/dev/null; done
for size in 16 32; do sips -z "$size" "$size" "$tmp/face.png" --out "icons/icon${size}.png" >/dev/null; done
echo "icons written: 16 32 (face) 48 128 (full)"
