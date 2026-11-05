#!/usr/bin/env bash
# Build + deploy our SAM2 / MedSAM2 nuclio functions into the running CVAT stack.
#
# Requires `nuctl` (nuclio CLI) on PATH. If you don't have it:
#   curl -s https://api.github.com/repos/nuclio/nuclio/releases/latest \
#     | grep -o 'https://[^"]*nuctl-[0-9.]*-linux-amd64' | head -1 | xargs curl -fL -o /tmp/nuctl
#   chmod +x /tmp/nuctl && sudo mv /tmp/nuctl /usr/local/bin/nuctl
#
# Usage:
#   ./scripts/build-nuclio.sh              # all custom functions
#   ./scripts/build-nuclio.sh sam2         # only paths matching 'sam2'
#   ./scripts/build-nuclio.sh medsam2
#   DOCKER_NETWORK=cvat_cvat ./scripts/build-nuclio.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${CVAT_SRC:-$ROOT/cvat}"
FILTER="${1:-}"

DOCKER_NETWORK="${DOCKER_NETWORK:-cvat_cvat}"
REDIS_HOST="${REDIS_HOST:-cvat_redis_ondisk}"
REDIS_PORT="${REDIS_PORT:-6666}"

command -v nuctl >/dev/null || { echo "nuctl not found on PATH" >&2; exit 1; }

# Our custom function roots (everything else in serverless/ is upstream)
FUNC_DIRS=(
    "$SRC/serverless/pytorch/facebookresearch/sam2/nuclio"
    "$SRC/serverless/pytorch/facebookresearch/sam2/nuclio-auto"
    "$SRC/serverless/pytorch/facebookresearch/sam2/nuclio-tracker"
    "$SRC/serverless/pytorch/facebookresearch/sam2/nuclio-video"
    "$SRC/serverless/pytorch/facebookresearch/sam2/nuclio-video-gpu"
    "$SRC/serverless/pytorch/bowang-lab/medsam2/nuclio-auto"
    "$SRC/serverless/pytorch/bowang-lab/medsam2/nuclio-interactor"
    "$SRC/serverless/pytorch/bowang-lab/medsam2/nuclio-video-gpu"
)

nuctl create project cvat --platform local >/dev/null 2>&1 || true

for dir in "${FUNC_DIRS[@]}"; do
    [ -d "$dir" ] || { echo "skip (missing): $dir"; continue; }
    if [ -n "$FILTER" ] && [[ "$dir" != *"$FILTER"* ]]; then
        continue
    fi

    echo "==> $(basename "$(dirname "$dir")")/$(basename "$dir")"

    # GPU functions live in *-gpu dirs; everything else is CPU.
    extra=()
    case "$(basename "$dir")" in
        *-gpu) extra+=(--resource-limit nvidia.com/gpu=1) ;;
    esac

    nuctl deploy \
        --project-name cvat \
        --path "$dir" \
        --file "$dir/function.yaml" \
        --platform local \
        --env CVAT_FUNCTIONS_REDIS_HOST="$REDIS_HOST" \
        --env CVAT_FUNCTIONS_REDIS_PORT="$REDIS_PORT" \
        --platform-config "{\"attributes\": {\"network\": \"$DOCKER_NETWORK\"}}" \
        "${extra[@]}"
done

echo
echo "==> deployed functions"
docker ps --format '{{.Names}}\t{{.Status}}' | grep '^nuclio-' || true
