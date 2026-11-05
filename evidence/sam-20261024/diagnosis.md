# SAM prompting and auto-annotation diagnosis

## Confirmed point-prompt failure and repair

- Before repair, a CVAT POST to the interactor for Task 2 / Job 1 / frame 4544 returned HTTP 500.
- Nuclio traceback: `Input points must be a nested list with 4 levels ... Got 3 levels.`
- `_pairs()` in `serverless/pytorch/facebookresearch/sam2/nuclio/model_handler.py` returned coordinate tuples. Transformers 4.57.6's `_get_nesting_level()` counts lists, arrays, and tensors, but not tuples. Thus the logical coordinate dimension was not recognized.
- Changed coordinate pairs to lists. Added `serverless/pytorch/facebookresearch/sam2/tests/test_point_prompts.py` using the installed real Sam2Processor without loading model weights.
- Three regression tests passed: coordinate type, five point/box combinations, and mask RLE round trips.
- Rebuilt/redeployed the interactor. Public HTTPS CVAT calls returned valid nonempty masks for point-only (5.85 seconds), positive plus negative points (0.27 seconds), box-only (0.17 seconds), and box plus points (0.25 seconds). Same-frame embedding caching explains faster follow-ups.
- Mask run lengths were checked against bounding-box area. These checks validate encoding, not anatomical accuracy.

## Automatic annotation findings

- Before diagnostic requests, retained CVAT logs contained detector POSTs but no interactor POSTs or batch POSTs to `/api/lambda/requests`. This suggests the used UI path was current-frame Auto-labeling, not Prompting or task-wide Automatic annotation. It does not establish the user's exact UI actions or exclude missing logs.
- Local CVAT detector calls on frames 0 and 4544 took 11.07 and 10.74 seconds and returned two and three polygons respectively. Task labels matched returned label IDs.
- A temporary one-frame Task 3 was created using frame 4544 from Task 2. The test used public HTTPS and explicit same-name mappings.
- Batch request passed queued -> started -> finished, reached progress 100, and saved three polygons. End-to-end elapsed time was 12.04 seconds.
- The temporary inference request and Task 3 were deleted afterward. Existing Task 2 / Job 1 annotations were compared before/after and were unchanged.
- This proves a small batch's request/queue/save path, not full-video throughput or medical segmentation accuracy. No full 13,632-frame batch was started.

## Model names clarified

- Interactor: `SAM 2.1 - Point & Box` under AI assistance -> Prompting.
- Detector: `Grounding DINO + SAM 2.1 (Experimental)` under Auto-labeling or task-wide Automatic annotation.
- Tracker unchanged: `SAM 2.1 Tracker` (custom box propagation, not temporal mask tracking).
- All three Nuclio functions verified ready after deployment.

## Remaining limitations

- SAM 2.1 accepts spatial prompts, not anatomical class names as text prompts. Detector English prompts go to Grounding DINO; SAM receives the resulting boxes.
- Grounding DINO is a general zero-shot detector, not validated for this endoscopic medical taxonomy. Nonempty named polygons do not prove correct identification of nerves, dura, disc, or vessels.
- Detector still uses heuristic substring label matching, a capped internal threshold, per-label/total result limits, and largest-contour polygon output. These can reduce recall or mislabel regions; no accuracy claim is made and no semantic-quality changes were included in this repair.
- GPU remains unavailable: NVML driver/library mismatch. CPU-only deployment remains in effect; no driver or unrelated-service changes were made.
- Browser helper documented in the installed browser skill was absent on this host. Verification was through real CVAT APIs and the public HTTPS route, not a completed browser-click test. UI tab/button names were checked against the installed CVAT source.
- Python urllib's default public request received a 403; the browser-like diagnostic client succeeded through the same public domain. This is not evidence that the user's browser was blocked.

## Evidence

Private files in this directory include pre-repair function metadata/source, original annotation snapshot, deploy logs, four public interactor responses, two detector responses, and `batch-smoke-result.json`. No credentials or tokens were written into this report.
