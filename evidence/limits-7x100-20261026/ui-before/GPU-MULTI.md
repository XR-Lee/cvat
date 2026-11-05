# Multi-mask GPU propagation (deployed 2026-10-26)

## User workflow

Save annotations, refresh the job, and click **多 Mask 跟踪 · GPU** in the top toolbar beside Save/Undo/Redo. Select 1–3 saved, visible Masks on the current frame, including different labels or different objects with the same label. Choose 1–50 following frames (default 20), run, inspect, then **Save**. The dialog is modal so normal editor navigation stays unavailable during propagation. Cancel waits for the current request, releases the session, and adds no partial results.

The equivalent annotation action is **SAM2 Multi-Mask Video Propagation - GPU**. The older single-mask CPU action remains available as a fallback and was not renamed as GPU.

## Object identity and protection

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
- CUDA autocast uses bfloat16; per-process allocator budget is 35% of GPU memory. One active multi-object session, at most three objects and 50 steps. The function fails on missing CUDA instead of silently using CPU.
- Idle weights are kept on CPU, moved to CUDA only when a session owns the GPU lock. On release/expiry they return to CPU. The CUDA context may retain approximately 820 MiB even while idle.
- Host driver kernel is 595.71.05 while host user-space libraries are 595.99.02. No system driver replacement, module unload, reboot, or unrelated service restart was performed. The GPU image contains isolated 595.71.05 userspace libraries from NVIDIA's official installer. It exposes only the required NVIDIA device nodes through Docker and uses the standard runc runtime. This avoids the mismatched host library auto-injection.
- **This is a compatibility deployment, not a global host-driver repair.** Host `nvidia-smi` may still fail. After a host driver/kernel update, rebuild the isolated libraries to match the loaded kernel, or restore a normally matched NVIDIA container runtime.
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
- Live UI image: `cvat/ui:sam2-multi-gpu-v1`, pinned in `docker-compose.override.yml`.
- Private backups/evidence: `.diagnostics/multi-gpu-20261026/`.

## Verification

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
