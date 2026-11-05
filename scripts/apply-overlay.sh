#!/usr/bin/env bash
# Fetch pinned upstream CVAT and apply our customization layer on top.
#
#   ./scripts/apply-overlay.sh                 # -> ./cvat
#   TARGET=/opt/cvat ./scripts/apply-overlay.sh
#   UPSTREAM_TAG=v2.80.0 ./scripts/apply-overlay.sh
#
# Idempotent: re-downloads the tag into .upstream/ and rebuilds TARGET from scratch.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UPSTREAM_REPO="${UPSTREAM_REPO:-cvat-ai/cvat}"
UPSTREAM_TAG="${UPSTREAM_TAG:-v2.80.0}"
TARGET="${TARGET:-$ROOT/cvat}"
CACHE="${CACHE:-$ROOT/.upstream}"

TARBALL="$CACHE/cvat-$UPSTREAM_TAG.tar.gz"
SRC="$CACHE/src-$UPSTREAM_TAG"

echo "==> upstream $UPSTREAM_REPO @ $UPSTREAM_TAG"
mkdir -p "$CACHE"

if [ ! -s "$TARBALL" ]; then
    echo "    downloading tarball"
    curl -fL --retry 3 --retry-delay 2 -o "$TARBALL.part" \
        "https://codeload.github.com/$UPSTREAM_REPO/tar.gz/refs/tags/$UPSTREAM_TAG"
    mv "$TARBALL.part" "$TARBALL"
fi

if [ ! -d "$SRC" ]; then
    echo "    extracting"
    mkdir -p "$SRC"
    tar xzf "$TARBALL" -C "$SRC" --strip-components=1
fi

echo "==> staging into $TARGET"
if [ -d "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
    echo "    $TARGET exists and is not empty."
    echo "    refusing to overwrite. Remove it first, or set TARGET=<fresh dir>." >&2
    exit 1
fi
mkdir -p "$TARGET"
cp -a "$SRC/." "$TARGET/"

echo "==> copying overlay"
cp -a "$ROOT/overlay/." "$TARGET/"

echo "==> applying patches"
for p in "$ROOT"/patches/*.patch; do
    [ -e "$p" ] || continue
    echo "    $(basename "$p")"
    patch -p1 -d "$TARGET" --forward < "$p"
done

echo
echo "done. next:"
echo "  ./scripts/build-ui.sh"
echo "  ./scripts/build-nuclio.sh"
echo "  cd $TARGET && docker compose up -d"
