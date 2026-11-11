#!/usr/bin/env bash
# Puts the on-phone picture engine into the APK: unpacks the stable-diffusion.cpp build from the
# "zenvqo-image-engine" release into app/src/main/jniLibs/<abi>/.   Usage: fetch-image-engine.sh <abi>...
# Needs GH_TOKEN (CI) or a logged-in gh. Without the release the APK is built without the engine.
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=${GITHUB_REPOSITORY:-T6chPath/voicebuddy}
tmp=$(mktemp -d)
for abi in "$@"; do
  if gh release download zenvqo-image-engine -R "$REPO" -p "image-engine-$abi.tar.gz" -D "$tmp" --clobber 2>"$tmp/err"; then
    dest="$HERE/../app/src/main/jniLibs/$abi"
    rm -rf "$dest" && mkdir -p "$dest"
    tar xzf "$tmp/image-engine-$abi.tar.gz" -C "$dest"
    echo "picture engine for $abi:"; ls -la "$dest"
  else
    echo "::warning title=No picture engine::image-engine-$abi.tar.gz isn't on the zenvqo-image-engine release yet ($(cat "$tmp/err")); building without it"
  fi
done
rm -rf "$tmp"
