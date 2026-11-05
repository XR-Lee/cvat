# SAM2 Mask Video Propagation for this CVAT Community deployment

## User workflow

1. Save the seed Mask in the job. Refresh once after this deployment.
2. Open the Mask's object menu (three dots) → **Run annotation action**.
3. Select **SAM2 Mask Video Propagation**.
4. Set **Frames forward** (default 20, permitted 1–50).
5. Run and keep the tab open. CPU takes roughly 6 seconds per frame here.
6. Inspect subsequent frames. Results remain unsaved until **Save**. Cancel or a failed run adds no partial output. Undo removes the generated collection; seed grouping is a separate undo step if a new group was assigned.
7. For a longer sequence, correct and save the last good propagated Mask, then run from that frame.

This is a custom Community annotation action, not a CVAT Enterprise/native AI-agent feature. Use the object action, not the sidebar's rectangle **Tracking** selector. It is also distinct from **Propagate shapes**, which copies geometry without following image content.

## Behavior and limits

- Uses `Sam2VideoModel` with temporal memory and `Sam2VideoProcessor` from Transformers 4.57.6, loading the cached `facebook/sam2.1-hiera-large` weights.
- The full binary source Mask initializes the conditioning-frame memory; future frames do not reuse bounding-box image prompts.
- One selected, saved, non-outside Mask per action. CPU only, forward direction, at most 50 following available frames per run. Deleted or resized frames abort the run.
- Source mask pixels, label, attributes, and server ID are preserved. Generated masks inherit the label and attributes. A shared CVAT **group** links the seed and generated masks; each frame still has its own shape ID. This is not a CVAT interpolated track.
- Conservative non-overwrite policy: skip adding output on any frame already containing the same label, or an active same-label track. Inference still processes these frames for temporal continuity. Existing corrections are NOT automatically injected into the model; explicitly start another run from a corrected Mask.
- Detects concurrent saved/editor changes before committing. CVAT save semantics are still subject to the usual brief read/check/write concurrency window; avoid concurrent editing of the same job.
- Missing masks, invalid RLE, or adjacent-frame area changes beyond a factor of three abort without committing partial output. This is a guardrail, not an anatomical quality metric.
- Sessions are capability-randomized, held in process memory, and referenced by CVAT-signed state strings. Completion/cancel/error attempts explicit release; 180-second idle expiry is a fallback. Service restart loses sessions. At most two sessions, one inference worker, four Torch CPU threads.
- Model predictions require review. No medically validated tracking accuracy or full-video reliability claim is made.

## Deployment artifacts

- Video function: `serverless/pytorch/facebookresearch/sam2/nuclio-video/`.
- Function ID: `pth-facebookresearch-sam2-video-mask`.
- Browser plugin: `components/sam2-video/mask-video-action.js`.
- UI image: `cvat/ui:sam2-video-v1`; original released UI assets are unchanged, with one extra same-origin script loaded using CVAT's public plugin/action APIs.
- `docker-compose.override.yml` pins the custom UI image. Do not edit the running container as a substitute for rebuilding.
- Diagnostic/backup directory: `.diagnostics/video-20261026/` (private).

Build UI:

```bash
sg docker -c '/snap/bin/docker build -f /home/xinrun/cvat/components/sam2-video/Dockerfile.ui -t cvat/ui:sam2-video-v1 /home/xinrun/cvat/components/sam2-video'
```

Recreate only UI using the standard three Compose files and `up -d --no-deps cvat_ui`. Deploy the video function with the same Nuclio namespace/project/network settings as the existing SAM functions, using an explicit `--path`, `TMPDIR=/home/xinrun/cvat/.nuclio-tmp`, and `--no-pull` when cached base images are desired.

## Tests and evidence

- `node --test components/sam2-video/test-action.cjs`: six plugin contract tests covering defaults/bounds, skip/group behavior, cancellation, concurrent-edit rejection, unsaved edits, and disappearing masks.
- `serverless/pytorch/facebookresearch/sam2/tests/test_video_masks.py`: five model-independent tests covering RLE round trips/validation, real cached video-processor output dimensions, retry/release/expiry state handling, and limits. Run inside the model image with `VIDEO_HANDLER_PATH` if copying files to a temporary location.
- Real Task 2 frames 0–20: initialized from saved shape 1, propagated 20 following masks with valid RLE. Results stored privately, not added to Task 2.
- Disposable Task 5 / Job 4: real browser menu/action/run/save test through the public HTTPS domain. Frames 1 and 3 were created; existing frame 2 was preserved; source/new masks shared a group. Cancel produced no changes. No browser page errors. Temporary task removed after verification.
- Production Task 2 annotation data was independently compared to the initial backup and left unchanged. No full-video batch was started.

## Rollback

Change only the `cvat_ui` image override back to `cvat/ui:v2.80.0` and recreate only `cvat_ui`. This removes the custom action without changing annotations. The video Nuclio function can then be undeployed separately. Do not restore old annotation backups unless explicitly requested; users may have created newer annotations.
