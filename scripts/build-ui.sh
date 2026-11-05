#!/usr/bin/env bash
# Build the two custom CVAT UI images.
#
#   cvat/ui:sam2-video-v1                base bundle + mask-video-action.js
#   cvat/ui:sam2-multi-gpu-v4-medsam2    that + multi-mask-gpu.js  (used in production)
#
# Both are plain "preserve the released bundle, inject a plugin <script>" images:
# the upstream bundle is never rebuilt, only a small JS file is added to the
# nginx html root and referenced from index.html.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${CVAT_SRC:-$ROOT/cvat}"
CTX="$SRC/components/sam2-video"

BASE_TAG="${BASE_TAG:-cvat/ui:sam2-video-v1}"
FINAL_TAG="${FINAL_TAG:-cvat/ui:sam2-multi-gpu-v4-medsam2}"
UPSTREAM_UI="${UPSTREAM_UI:-cvat/ui:v2.80.0}"

[ -d "$CTX" ] || { echo "missing build context: $CTX (run scripts/apply-overlay.sh first)" >&2; exit 1; }

echo "==> $UPSTREAM_UI -> $BASE_TAG   (mask-video-action.js)"
docker build -t "$BASE_TAG" -f "$CTX/Dockerfile.ui" "$CTX"

echo "==> $BASE_TAG -> $FINAL_TAG   (multi-mask-gpu.js)"
docker build -t "$FINAL_TAG" -f "$CTX/Dockerfile.ui.multi" "$CTX"

echo
echo "done. rollout:"
echo "  cd $SRC && docker compose up -d cvat_ui"
echo
echo "verify the served bundle contains the plugin:"
echo "  curl -s https://\$CVAT_HOST/ | grep -o 'multi-mask-gpu.js[^\"]*'"
