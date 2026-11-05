#!/usr/bin/env bash
# Build the MedSAM2 nuclio runtime image.
#
#   cvat.pth.bowang-lab.medsam2:latest
#
# Layer chain:
#   cvat.pth.facebookresearch.sam2_1_hiera_large   (CVAT's SAM2.1 Hiera-L image)
#     -> cvat.sam2-video-cuda:2.9-cu128-595.71.05  (torch 2.9/cu128 + host driver libs)
#       -> MedSAM2 image                          (this script)
#
# The host-driver-libs layer exists because the image-bundled CUDA libraries broke
# when the host driver was upgraded to 595.71.05. host_nvidia.py in each *-gpu
# function relinks these at container start-up.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SRC="${CVAT_SRC:-$ROOT/cvat}"
WORK="${WORK:-$ROOT/.build/medsam2}"

MEDSAM2_REPO="${MEDSAM2_REPO:-bowang-lab/MedSAM2}"
MEDSAM2_COMMIT="${MEDSAM2_COMMIT:-332f30d420f1d1b08e2a79b3ae6a602458808383}"
CKPT_URL="${CKPT_URL:-https://huggingface.co/wanglab/MedSAM2/resolve/main/MedSAM2_latest.pt}"
CKPT_SHA256="${CKPT_SHA256:-c92743b99f00d078bf32a3afcc38aaa9faf1c1692dffe3eaa7a90938c1991060}"

BASE_IMAGE="${BASE_IMAGE:-cvat.sam2-video-cuda:2.9-cu128-595.71.05}"
CUDA_TAG="${CUDA_TAG:-cvat.sam2-video-cuda:2.9-cu128-595.71.05}"
OUT_TAG="${OUT_TAG:-cvat.pth.bowang-lab.medsam2:latest}"

mkdir -p "$WORK"
cd "$WORK"

# ------------------------------------------------------------------ 1. cuda base
if ! docker image inspect "$CUDA_TAG" >/dev/null 2>&1; then
    echo "==> building CUDA base $CUDA_TAG"
    CTX="$WORK/cuda-base"
    rm -rf "$CTX"; mkdir -p "$CTX/driver-libs"

    # Host NVIDIA userspace libraries, versioned to the running driver.
    DRV_VER="$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1 | tr -d ' ')"
    echo "    host driver $DRV_VER"
    for lib in libcuda libnvidia-ml libnvidia-ptxjitcompiler libnvidia-gpucomp; do
        found="$(ldconfig -p | awk -v L="$lib.so.$DRV_VER" '$1==L {print $NF; exit}')"
        [ -n "$found" ] || { echo "missing $lib.so.$DRV_VER on host" >&2; exit 1; }
        cp -L "$found" "$CTX/driver-libs/"
    done

    cp "$SRC/components/sam2-video/Dockerfile.gpu" "$CTX/Dockerfile"
    docker build -t "$CUDA_TAG" -f "$CTX/Dockerfile" "$CTX"
else
    echo "==> CUDA base $CUDA_TAG already present"
fi

# ---------------------------------------------------------------- 2. medsam2 src
if [ ! -d "$WORK/src/.git" ]; then
    echo "==> fetching $MEDSAM2_REPO @ ${MEDSAM2_COMMIT:0:7}"
    rm -rf "$WORK/src"
    git clone --quiet "https://github.com/$MEDSAM2_REPO.git" "$WORK/src"
fi
git -C "$WORK/src" fetch --quiet origin "$MEDSAM2_COMMIT" || true
git -C "$WORK/src" checkout --quiet "$MEDSAM2_COMMIT"

# ------------------------------------------------------------------ 3. weights
mkdir -p "$WORK/medsam2/weights"
CKPT="$WORK/medsam2/weights/MedSAM2_latest.pt"
if [ ! -f "$CKPT" ]; then
    echo "==> downloading checkpoint"
    curl -fL --retry 3 -o "$CKPT.part" "$CKPT_URL"
    mv "$CKPT.part" "$CKPT"
fi
echo "==> verifying checkpoint sha256"
echo "$CKPT_SHA256  $CKPT" | sha256sum -c -

# The image only needs the inference package + its vendored tracker.
cp -a "$WORK/src/sam2" "$WORK/medsam2/" 2>/dev/null || true
cp -a "$WORK/src/efficient_track_anything" "$WORK/medsam2/" 2>/dev/null || true
cp "$WORK/src/COMMIT" "$WORK/medsam2/COMMIT" 2>/dev/null || true
cp "$WORK/src/LICENSE" "$WORK/medsam2/LICENSE" 2>/dev/null || true

# ------------------------------------------------------------------- 4. build
echo "==> building $OUT_TAG from $BASE_IMAGE"
docker build -t "$OUT_TAG" -f "$HERE/Dockerfile" "$WORK"

echo
echo "done. redeploy the MedSAM2 functions:"
echo "  ./scripts/build-nuclio.sh medsam2"
