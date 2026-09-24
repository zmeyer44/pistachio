#!/bin/sh
# Regenerates production and dev icons from the SVGs in this directory.
# macOS only (iconutil); needs librsvg and imagemagick from brew. The filled
# hex-nut mark uses the same geometry at every size.
set -eu
cd "$(dirname "$0")"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# macOS: every iconset slot.
mkdir "$tmp/icon.iconset"
for entry in 16:icon_16x16 32:icon_16x16@2x 32:icon_32x32 64:icon_32x32@2x \
             128:icon_128x128 256:icon_128x128@2x 256:icon_256x256 \
             512:icon_256x256@2x 512:icon_512x512 1024:icon_512x512@2x; do
  size=${entry%%:*}
  src=icon-macos.svg
  rsvg-convert -w "$size" -h "$size" "$src" -o "$tmp/icon.iconset/${entry#*:}.png"
done
iconutil -c icns "$tmp/icon.iconset" -o icon.icns

# Windows: the full-bleed artwork at every classic ico size.
for size in 16 24 32 48 64 128 256; do
  src=icon-square.svg
  [ "$size" -le 32 ] && src=icon-small.svg
  rsvg-convert -w "$size" -h "$size" "$src" -o "$tmp/$size.png"
done
magick "$tmp/16.png" "$tmp/24.png" "$tmp/32.png" "$tmp/48.png" \
  "$tmp/64.png" "$tmp/128.png" "$tmp/256.png" icon.ico

# Linux (and the dev window icon): one 512 png, plus the margined artwork
# as a png for the dev dock on macOS (main/index.ts sets it at startup).
rsvg-convert -w 512 -h 512 icon-square.svg -o icon.png
rsvg-convert -w 512 -h 512 icon-macos.svg -o icon-macos.png
# Cryo Circuit identifies every dev run, independently of the release color.
rsvg-convert -w 512 -h 512 icon-macos-dev.svg -o icon-macos-dev.png

# Both selectable styles ship as runtime PNGs. The unsuffixed files above
# remain the white default baked into app bundles and installer shortcuts.
rsvg-convert -w 512 -h 512 icon-square-green.svg -o icon-green.png
rsvg-convert -w 512 -h 512 icon-macos-green.svg -o icon-macos-green.png
# Window icons use the same artwork without the macOS outer margin.
sed 's/viewBox="0 0 1024 1024"/viewBox="100 100 824 824"/' icon-macos-dev.svg > "$tmp/icon-dev.svg"
rsvg-convert -w 512 -h 512 "$tmp/icon-dev.svg" -o icon-dev.png
