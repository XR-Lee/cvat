# Multi-mask GPU propagation (deployed 2026-10-26)

## User workflow

Save annotations, refresh the job, and click the blue layered-mask icon labeled **Mask · GPU** in the top toolbar beside Save/Undo/Redo (tooltip/accessibility name: **多 Mask 跟踪 · GPU**). Select 1–7 saved, visible **Masks or Polygons** on the current frame, including different labels or different objects with the same label. Choose 1–100 following frames (default 10), run, inspect, then **Save**. Output is always saved as Masks; the seed shape is never converted. The dialog is modal so normal editor navigation stays unavailable during propagation. Cancel waits for the current request, releases the session, and adds no partial results.

The equivalent annotation action is **SAM2 Multi-Mask Video Propagation - GPU**. The older single-mask CPU action remains available as a fallback and was not renamed as GPU.

**Model selector (2026-10-27):** the dialog now has a Model drop-down. Default **SAM2.1 Large** (this document). Optional experimental **MedSAM2** (research/education-only weights) is documented in [MEDSAM2.md](MEDSAM2.md). Live UI image: `cvat/ui:sam2-multi-gpu-v5-polygon`, script cache version `polygon-1`. Seed shapes now carry the planned following-frame count as `frames`; the SAM2.1 handler ignores it.

**Default following frames (2026-11-13):** the temporal-tracking default changed from 20 to **10** following frames, in both the toolbar dialog input and the `Frames forward` annotation-action parameter, plus the older single-object CPU action (default 10, max 50). Limits are unchanged (GPU max 100). Rationale: a shorter default means less drift before the first review, and re-running from the last corrected mask is cheaper than inspecting ten frames of a bad tail. `init()` also falls back to 10 when the parameter is absent instead of producing `NaN`. Test: `frames-forward default is 10 and limits are unchanged`; browser check confirmed `10` in both entry points with `max=100` and no annotation writes. Live UI image `cvat/ui:sam2-multi-gpu-v7-frames10`, script cache `frames10-1`.

**Polygon seeds (2026-10-27):** `Convert masks to polygons` in the interactor produces polygon shapes, and CVAT accepts a polygon even on a mask-type label. The GPU trackers declared `supported_shape_types: mask`, so the server rejected those objects with `This function does not support shapes of type 'polygon'` and the UI filtered them out. Fixed on both sides:

- Both GPU `function.yaml`: `supported_shape_types: mask,polygon`; live UI image `cvat/ui:sam2-multi-gpu-v5-polygon`, script cache `polygon-1`.
- `decode_polygon()` rasterizes vertices with `PIL.ImageDraw` into a frame-sized bitmap (coordinates clamped, >=3 distinct vertices, non-empty, `MAX_PIXELS` cap); `shape_bitmap()` dispatches on `type`, so a polygon and a mask covering the same region give the same seed bitmap.
- The init response now echoes `encode_mask(bitmap)` rather than the raw seed points; previously a polygon seed was echoed back as `type: mask` with polygon coordinates.
- Frontend `SEED_TYPES = {mask, polygon}`: applicability, filtering, the dialog list (shows 多边形), bbox overlap protection and the area guard (shoelace for polygons) handle both; the request sends each seed's real type (it previously hard-coded `mask`).
- The older single-mask CPU action remains mask-only.
- Tests: frontend 18/18 (3 polygon cases), SAM2.1 GPU 8/8 (3 new), MedSAM2 GPU 4/4 (1 new). Public end-to-end: polygon seeds propagated through both GPU services (valid areas, output type mask, temp job unchanged); public browser run listed the polygon, produced 3 masks in one Group with the seed polygon untouched, saved 4 shapes; the object-menu **Run annotation action** now offers the GPU action for polygons. Temporary task deleted; Task 2 untouched. Evidence: `.diagnostics/polygon-gpu-20261027/`.

## Annotated-frame markers and navigation (2026-11-19)

Inside the annotation editor (injected by `components/sam2-video/annotated-frame-nav.js`):

- **Amber ticks** along the bottom edge of the frame slider mark every frame that carries at least one shape. Drawn on a canvas sized to the slider, so jobs with thousands of annotated frames stay cheap; adjacent annotated frames coalesce into the same 2 px tick.
- **Two transport buttons** (`<·` and `·▶`) appended to the player buttons jump to the previous / next annotated frame. They disable themselves at the ends and expose the target frame number in the tooltip/`aria-label`. Arrow buttons are keyboard operable (Enter/Space).
- Data comes from `job.annotations.export()` — the in-memory collection — so **unsaved edits are reflected** and no extra API requests are made. It refreshes every 3 s and on job switch. Job annotation frames are segment-relative, so `job.startFrame` is added to map them onto the player's absolute frame numbers.
- Frames that only appear inside tracks are included (keyframes with `outside: false`).
- Hidden automatically outside the editor or when there is no job.

Verification (`.diagnostics/annotated-frames-20261027/`, committed under `evidence/`):

| Case | Result |
|---|---|
| Task 2 / job 1 (13,632 frames, 77 annotated, all in 0–83) | 4 coalesced ticks at the left edge, positions match API |
| Task 15 / job 15 (15,660 frames, 240 annotated, span 1712–9758) | 28 ticks from x=38 to x=219 vs expected 38/218; next → 1712 → 1713, prev → 1712 |
| Disposable 3-frame task, shapes on frames 0 and 2 only | exactly 2 ticks (x=0, x=233); one jump 0→2; next disabled at the end; prev → 0 |

No page errors and no annotation or model writes during any of these runs; the disposable task was removed afterwards.

## Object identity and protection

- CVAT Group is generic grouping metadata, not a category, confidence score, or native interpolated Track ID. In this custom workflow it links one physical object's per-frame Masks. Group numbers are arbitrary; 0 means ungrouped. Different objects, even with the same label, need different groups. The dialog displays `对象组 N` or `未分组（运行后自动分组）` and explains this distinction.
- Each seed has its own model object index. All objects share a video session/visual encoding, while SAM2 keeps per-object temporal state.
- Generated Masks inherit their seed's label and attributes. Each object has a distinct CVAT Group. Ungrouped seeds receive separate groups when committing preview output. Different seed objects must not share a preexisting group.
- Existing shapes belonging to the same Group protect that object on that frame. Other known groups, including same-label objects, do not suppress it.
- Existing ungrouped, same-label Masks whose bounding boxes overlap the predicted mask are conservatively skipped. This is a safety heuristic, not verified object association. Assign consistent groups when continuing from manual corrections.
- Existing annotations are not deleted or overwritten. Source pixels/IDs/attributes stay unchanged; source group changes are intentional for previously ungrouped seeds.
- Lost masks or adjacent-frame area changes greater than a factor of three stop only the affected object; other objects continue. Earlier valid masks for the stopped object remain in preview and a warning identifies the stopping frame. All outputs require human review.
- Saved/editor annotation changes detected during a run cause an abort before preview commit. Normal CVAT save concurrency limits still apply; do not edit the same job from multiple clients simultaneously.

## Actual CUDA runtime

- Device: NVIDIA GeForce RTX 4090, 24 GB.
- `torch==2.9.0+cu128`, `torchvision==0.24.0+cu128`, Transformers 4.57.6, `Sam2VideoModel` and cached Hiera Large checkpoint.
- CUDA autocast uses bfloat16; per-process allocator budget is 35% of GPU memory. One active multi-object session, at most seven objects and 100 following frames (the seed frame is additional). These are application limits, not SAM2 hard limits. The earlier 3-object/50-frame bounds were conservative rollout limits. The function fails on missing CUDA instead of silently using CPU.
- Idle weights are kept on CPU, moved to CUDA only when a session owns the GPU lock. On release/expiry they return to CPU. The CUDA context may retain approximately 820 MiB even while idle.
- **Driver libraries (updated 2026-10-27 after reboot).** The host rebooted at 16:42 and loaded kernel module 595.99.02, now matching host user space (`nvidia-smi` works). The image-bundled 595.71.05 libraries then mismatched, so both GPU functions crash-looped (`CUDA required`). They now use the host's own libraries, whatever version is installed:
  - `/var/lib/snapd/hostfs/usr/lib/x86_64-linux-gnu` is bind-mounted read-only at `/host-nvidia-lib` (snap Docker's own `/usr` is the core base, so the host path must go through `hostfs`).
  - `host_nvidia.py`, run in `main.py` before CUDA initialises, symlinks only `libcuda*` / `libnvidia-*` into `/opt/nvidia-host`, the sole `LD_LIBRARY_PATH` entry; other host libraries never enter the search path. The directory is created at build time because glibc caches LD_LIBRARY_PATH directories that are missing at process start.
  - Links are recreated on every container start, so a future driver upgrade plus reboot is picked up without rebuilding. Startup logs report `host driver <version> (<n> libs)`.
  - `docker --gpus` (Nuclio's only GPU option) is rejected by this snap Docker (CDI hook mode requires `--runtime=nvidia`, which Nuclio cannot set), hence explicit device nodes plus mounted libraries.
- **Fixed host ports.** Two functions had random host ports; on reboot the rectangle tracker took 32768, so the SAM 2.1 point interactor failed to start and CVAT's recorded tracker port (32770) pointed at nothing. Every function now pins `triggers.myHttpTrigger.attributes.port`: interactor 32768, detector 32769, rectangle tracker 32770, CPU video 32771, SAM2.1 GPU video 32772, MedSAM2 GPU video 32774, MedSAM2 interactor 32775. Recovery evidence and backups: `.diagnostics/reboot-recovery-20261027/`.
- The GPU function honors `/home/xinrun/p1-full-experiments/data/models/locks/gpu.lock` with `flock`. The single file is mounted at `/gpu-lock`; no research dataset is mounted. It never truncates/deletes the lock or stops competing jobs. If held, the UI reports GPU busy and leaves annotations unchanged. Explicit release is attempted after every run; idle expiry is 90 seconds.

## Artifacts and rebuilding

- Function: `serverless/pytorch/facebookresearch/sam2/nuclio-video-gpu/`.
- Nuclio ID: `pth-facebookresearch-sam2-video-mask-gpu`; host port 32772.
- CUDA base recipe: `components/sam2-video/Dockerfile.gpu`.
- CUDA base image: `cvat.sam2-video-cuda:2.9-cu128-595.71.05`.
- Source driver package and extracted libraries: `.gpu-runtime/`; the official `.run` file was **extracted only**, never installed.
- CUDA build context: `.gpu-runtime/build/`, with `driver-libs/` containing `libcuda`, `libnvidia-ml`, `libnvidia-ptxjitcompiler`, and `libnvidia-gpucomp` version 595.71.05.
- Frontend: `components/sam2-video/multi-mask-gpu.js`, loaded via CVAT public plugin/action APIs and a top-toolbar button.
- UI recipe: `components/sam2-video/Dockerfile.ui.multi`, extending the previously verified CPU-plugin image.
- Live UI image: `cvat/ui:sam2-multi-gpu-v5-polygon`, pinned in `docker-compose.override.yml`. Script cache version: `polygon-1` (later section).
- Toolbar alignment update: native CVAT icon-above-caption structure, 48-pixel height, matching icon/caption positions at 1280- and 1600-pixel viewports. Public browser mouse/keyboard open, close, group explanation, and unchanged 7-mask/100-frame limits verified with zero annotation writes/inference calls. Evidence: `.diagnostics/toolbar-align-20261027/`.
- Private initial backups/evidence: `.diagnostics/multi-gpu-20261026/`.
- Limit-expansion backups/evidence: `.diagnostics/limits-7x100-20261026/`.

## Seven-object / 100-frame verification

- Twelve frontend contract tests and five backend state/codec tests pass. The new boundary tests cover seven independent object states through 100 steps, default is now 10 frames, and rejection of eight objects / 101 following frames.
- Real moving surgical video: seven spatial seed regions processed through all 100 following frames with CUDA. The service returned seven object slots on every frame without OOM. Whole-card peak usage was 4,111 MiB during this test; local CVAT API median was 0.40 seconds per frame. This is not per-process allocator telemetry or a universal performance claim.
- Of 700 requested object/frame outputs, 579 were nonempty in this deliberately subdivided-region stress test. Some seeds disappeared or changed substantially. **Passing the capacity test does not establish tracking accuracy.** The frontend still stops individual lost/unstable objects and reports warnings; users should review longer runs carefully.
- Staged and production public-domain browser tests: a 101-frame repeated-image fixture separates capacity/save correctness from motion quality. Seven selected masks propagated for 100 frames, one preexisting same-group shape was protected, 699 new masks were staged and saved, and all nine original shapes were preserved. Cancel and frontend rejection of eight masks / 101 frames passed with zero browser page errors. Default remains 20. The production verification respected competing research work by retrying GPU-busy responses; no research job was interrupted.
- The existing 35% GPU allocator cap, single-session shared GPU lock, 90-second idle expiry, cancellation, concurrency checks, group identity and non-overwrite policies are unchanged.

## Initial deployment verification (three-object / 50-frame configuration)

- Nine frontend contract tests: multi-object identity, same-label independent groups, protection, per-object loss, cancellation, remote-edit rejection, unsaved edits, duplicate groups, and assignment of separate groups.
- Four backend state/codec tests using mocked inference; actual CUDA validation is separate.
- Real CUDA service reported RTX 4090 and CUDA PyTorch. Three-object initialization and propagation passed through the CVAT gateway.
- Three distinct regions propagated for 20 following real video frames; all returned nonempty valid RLE with three distinct outputs per frame. Public per-frame latency approximately 0.2–0.4 seconds in this small test. This is integration evidence, not anatomical accuracy validation or a general benchmark.
- Public browser toolbar button → checkbox selection → GPU run → preview → Save passed on disposable Task 6 / Job 5. Three seeds included two objects with the same label, with independent groups; an existing correction for only one group was preserved. Eight new masks plus four original masks saved correctly. No browser page errors.
- Public Cancel test passed: no unsaved changes or server annotation writes. GPU lock released afterward.
- A further public browser run started from three ungrouped seeds and verified that each acquired a separate Group, with seed pixels and other metadata preserved.
- Task 2 original annotations were not modified by validation. During deployment the user added two masks (IDs 77 and 78 on frame 16); the freshness audit detected and preserved both additions rather than restoring the initial snapshot. All preexisting shapes still matched the backup. No whole-video automatic batch was started. Temporary task removed after verification.

## Rollback

Set the UI image override back to `cvat/ui:sam2-video-v1`, recreate only `cvat_ui`, then undeploy the GPU function if needed. Original single-mask CPU propagation remains available. Never restore stale annotation backups automatically.
