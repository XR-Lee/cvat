# Models

All functions are nuclio functions in `overlay/serverless/pytorch/`. Upstream
ships none of these; `detectron2/` and `sam/` in the same tree are untouched
upstream functions.

| Function | Dir | Device | Shape types | Purpose |
|---|---|---|---|---|
| `pth-facebookresearch-sam2-1-hiera-large` | `sam2/nuclio` | CPU | box, points, polygon | single-prompt segmentation |
| `pth-facebookresearch-sam2-1-hiera-large-auto` | `sam2/nuclio-auto` | CPU | — | automatic mask generation |
| `pth-facebookresearch-sam2-1-hiera-large-tracker` | `sam2/nuclio-tracker` | CPU | **box only** | object tracking (see caveat) |
| `pth-facebookresearch-sam2-video-mask` | `sam2/nuclio-video` | CPU | mask | temporal mask propagation |
| `pth-facebookresearch-sam2-video-mask-gpu` | `sam2/nuclio-video-gpu` | CUDA | mask | temporal propagation, 1–7 objects |
| `pth-medsam2-auto` | `medsam2/nuclio-auto` | CPU | — | automatic mask generation |
| `pth-medsam2-interactor` | `medsam2/nuclio-interactor` | CPU | box, points | interactive prompts |
| `pth-medsam2-video-mask-gpu` | `medsam2/nuclio-video-gpu` | CUDA | mask | temporal propagation |

## Known constraints

**The tracker is rectangle-only.** `sam2/nuclio-tracker` prompts an image
segmenter with the previous *rectangle* and returns another rectangle — it does
not use SAM2 video memory. Initialising it with a saved mask returns HTTP 400:
`This function does not support shapes of type 'mask'`. The stock
*AI assistance → Tracking* sidebar path has the same restriction. This is
unrelated to manual tracks or interpolation.

**Point prompts must be lists, not tuples.** In `model_handler.py`, `_pairs()`
must return coordinate *lists*. Transformers' SAM2 nesting validator does not
count tuple coordinates, producing
`Input points must be a nested list with 4 levels ... Got 3 levels`.
Contract: `input_points` shaped `(batch, object, point, 2)`, `input_labels`
shaped `(batch, object, point)`. Covered by
`sam2/tests/test_point_prompts.py`, which runs against the real cached processor
without loading weights.

**GPU functions use host driver libraries.** The image-bundled CUDA userspace
broke on a host driver upgrade. `host_nvidia.py` (present in every `*-gpu`
function) relinks `libcuda` / `libnvidia-ml` / `libnvidia-ptxjitcompiler` /
`libnvidia-gpucomp` from `/opt/nvidia-595.71.05` at container start-up.
`NVIDIA_VISIBLE_DEVICES=void` keeps the container from mounting host libs.

**GPU serialisation.** Video-propagation functions take a cooperative GPU lock
(`GPU_LOCK_PATH=/gpu-lock`) and return *busy* instead of queueing. There is no
CPU fallback. Limits: 1–7 independent mask objects per run; maximum 100
following frames, default 20.

## Tests

```bash
# point-prompt contract, no weights needed
docker run --rm -v "$PWD/serverless/pytorch/facebookresearch/sam2:/src" \
  cvat.pth.facebookresearch.sam2_1_hiera_large \
  python -m pytest /src/tests/test_point_prompts.py

# video propagation smoke tests (need a running nuclio + a task)
python serverless/pytorch/facebookresearch/sam2/tests/test_video_masks.py
python serverless/pytorch/bowang-lab/medsam2/tests/test_medsam2_video.py
```

## Licences

SAM 2 — Apache-2.0 (Meta). MedSAM2 — Apache-2.0 (bowang-lab), pinned to
`332f30d420f1d1b08e2a79b3ae6a602458808383`. Model **weights are
research/education-only** per their model cards; they are never committed here
(`.gitignore` excludes them).
