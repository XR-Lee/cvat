# MedSAM2 experimental tracker (deployed 2026-10-27)

## User workflow

In the **Mask · GPU** dialog, choose **Model → MedSAM2（实验；权重仅限研究/教学）**. The default remains **SAM2.1 Large**. The choice is remembered per browser (`localStorage['cvat-multi-mask-gpu-model']`). Everything else (1–7 Masks, 1–100 following frames, default 20, Group identity, non-overwrite protection, per-object loss handling, cancellation, preview-before-Save, shared GPU lock) is identical to the SAM2.1 path. The equivalent annotation action exposes the same `Model` parameter.

**Point/box prompting (added 2026-10-27):** AI assistance → Prompting → model **MedSAM2 - Point & Box (Research)** (`pth-medsam2-interactor`, port 32775, `serverless/pytorch/bowang-lab/medsam2/nuclio-interactor/`). Official `SAM2ImagePredictor` with the same weights, multimask output, highest-score mask, CVAT RLE. Runs on CPU (Tiny/512): ≈0.44 s first image encoding, ≈14 ms per further prompt in-container, 0.16–0.6 s via the public gateway; independent of the research GPU lock. Masks were bit-identical to a direct official predictor call for box, point and box+points prompts. Help text recommends keeping “Start with a bounding box” on (MedSAM2 is mainly box-trained). Public browser test: model listed in Prompting, a canvas click produced and saved a mask. SAM 2.1 - Point & Box remains first/default.

**Auto-labeling / automatic annotation (added 2026-10-27):** detector **Grounding DINO + MedSAM2 - Masks (Experimental, Research)** (`pth-medsam2-auto`, port 32776, `serverless/pytorch/bowang-lab/medsam2/nuclio-auto/`). Available in AI assistance → Auto-labeling (current frame) and task Actions → Automatic annotation (batch). Same 14 mask labels as the SAM 2.1 detector, so default name mapping works.

- Detection code (`PROMPTS`, `_detect`, `_match_label`, threshold clamp, ≤2 per label, ≤12 total) and the mask wire format are verbatim copies of the SAM 2.1 detector; a contract test (`tests/test_medsam2_auto.py`, 4/4) asserts AST equality so they cannot drift silently. Grounding DINO is pinned to the same revision `a2bb814dd30d776dcf7e30523b00659f4f141c71`.
- Each box goes to MedSAM2 via the official `SAM2ImagePredictor` (`multimask_output=False`, no post-processing), one image encoding per frame. MedSAM2 never sees label text; classes come only from Grounding DINO.
- CPU only (10 threads), ~1 GB RAM; never takes the research GPU lock.
- Verification: 14 Task 2 frames across the video sent to both detectors: identical labels and order; confidences equal or differing by 0.0001 (PyTorch `+cpu` vs `+cu128` CPU kernels). Median 6.9 s/frame vs 12.9 s/frame for SAM 2.1 (both mostly Grounding DINO + encoder; CPU shared with research jobs). Public gateway: current-frame call 6.4 s, Task 2 unchanged; batch request on a disposable 3-frame task finished in 21 s and saved 7 auto masks. Public browser: model listed in both Auto-labeling and task-level Automatic annotation; Auto-labeling on a disposable task staged and saved 2 masks; no Task 2 writes; no page errors. Temporary tasks deleted.
- A/B finding (`.diagnostics/medsam2-auto-20261027/ab-result.json`, `ab-sheet.png`, `zoom.png`): 31 detections, median mask IoU 0.92, none below 0.5. Most detections are near-whole-field boxes (often labelled 髓核) where both segmenters return the whole endoscopic circle, which is why agreement is high. In the few local boxes SAM 2.1 tends to fill the box with blocky, checkerboard-like edges, while MedSAM2 follows tissue boundaries more closely; neither is verified as anatomically correct. **The limiting factor is Grounding DINO's detection/classification, not the segmenter.**

## Model and licence

- Source: `bowang-lab/MedSAM2`, commit `332f30d420f1d1b08e2a79b3ae6a602458808383`, fetched as a tarball into `.medsam2/src/`.
- Weights: `wanglab/MedSAM2` → `MedSAM2_latest.pt` (the model card's recommended checkpoint), SHA-256 `c92743b99f00d078bf32a3afcc38aaa9faf1c1692dffe3eaa7a90938c1991060`, verified on download and again at image build.
- Architecture/config: SAM2.1 Hiera-Tiny, `configs/sam2.1_hiera_t512.yaml`, 512×512 input. The official strict checkpoint loader reported no missing or unexpected keys.
- Training data (paper): CT, PET, MRI 3D images plus ultrasound and endoscopy video; the evaluated endoscopy task is colonoscopy polyps. Spinal endoscopy is not represented.
- **Licence: code Apache-2.0; model weights are restricted to research and education use (Hugging Face model card).** Do not use for clinical or commercial purposes.
- The repository ships a prebuilt `sam2/_C.so` and CUDA sources for optional hole-filling post-processing. They were **excluded** from the image; the official video script disables post-processing by default, so they are not needed. `efficient_track_anything` (pure Python) is included because the official `sam2` modelling code imports it.

## Implementation

- Base image: `cvat.medsam2-cuda:332f30d` (recipe `.medsam2/build/Dockerfile`), built from the verified CUDA image `cvat.sam2-video-cuda:2.9-cu128-595.71.05` plus `hydra-core==1.3.2`, `iopath==0.1.10`, the reviewed Python package and weights.
- Function: `serverless/pytorch/bowang-lab/medsam2/nuclio-video-gpu/` → Nuclio ID `pth-medsam2-video-mask-gpu`, host port 32774. Same request/response protocol as the SAM2.1 GPU tracker, plus `model: MedSAM2_latest` in responses.
- The official `SAM2VideoPredictor` normally receives the whole video. CVAT delivers one frame per request, so the handler: feeds the untouched seed-frame bytes through official `init_state`; replaces `images` with a list-like container that receives later frames on demand; adds each seed via official `add_new_mask`; and advances the official `propagate_in_video` generator one frame per request. bf16 autocast, threshold 0 and no post-processing follow `medsam2_infer_video.py`. Objects are kept independent (`non_overlap_masks=false`) like CVAT objects and the SAM2.1 path.
- `num_frames` influences the object-pointer temporal encoding for clips shorter than 16 frames. The frontend therefore sends the planned following-frame count as `frames` on each seed shape (CVAT's tracker gateway forwards shape dicts unchanged); the handler sets `num_frames = frames + 1`, exactly like an official run on that clip, and refuses requests beyond it. SAM2.1 ignores the field.
- GPU: shared `flock` research lock, 35% per-process allocator cap, weights on CPU while idle, one session, 90-second idle expiry, explicit release, no CPU fallback.

## Verification

- **Bitwise parity**: streaming handler vs official whole-clip `vos_inference`-equivalent on real Task 2 frames — 4 objects × 20 frames and 2 objects × 5 frames (short-clip `num_frames` case): 0 differing pixels on every frame (`.medsam2/eval/parity.py`, `parity-result.json`). An earlier attempt differed by ~0.15% because `init_state` ran outside bf16 autocast; fixed before deployment.
- End-to-end through the public CVAT gateway: 41-frame propagation of the 神经根 seed reproduced the offline per-frame foreground areas exactly; the 42nd request was rejected; Task 2 unchanged.
- Contract tests: frontend 15/15 (`test-multi-action.cjs`, including default model, MedSAM2 routing incl. release, unknown/missing-service rejection, planned-frame field); backend 3/3 (`serverless/pytorch/bowang-lab/medsam2/tests/test_medsam2_video.py`).
- Public browser tests on a disposable task (8 real frames, two ungrouped seeds): MedSAM2 and SAM2.1 each staged 10 masks, saved 12 shapes, assigned distinct seed groups, routed all 7 GPU calls to the selected service, remembered the selection, kept toolbar alignment, zero page errors. Temporary task deleted.

## A/B review on Task 2 (read-only)

Five existing objects, each started from its earliest saved Mask, same original-quality frames, one object per run (`.medsam2/eval/compare.py`, `compare-result.json`, contact sheets in `.medsam2/eval/compare/`; white = saved, red = SAM2.1, green = MedSAM2).

| Group | Label | Following frames | IoU SAM2.1 vs MedSAM2 | Notes |
|---|---|---|---|---|
| 1 | 硬膜外脂肪 | 56 | 0.49 | after scene change MedSAM2 drifts onto instrument; final area 0.44× seed (SAM2.1 1.33×) |
| 2 | 血管 | 20 | 0.75 | |
| 3 | 神经根 | 41 | 0.83 | nearly identical thin strip |
| 4 | 抓钳 | 55 | 0.87 | MedSAM2 repeatedly truncates the lower instrument |
| 5 | 血管 | 60 | 0.69 | MedSAM2 empty by the last frame; SAM2.1 grows 6.4× |

- Saved Task 2 masks are all `semi-auto` and mostly SAM2.1 outputs (SAM2.1 re-run agreement 0.98–1.0 on three objects), so agreement with them is **not** accuracy. On the 54 frames where the saved result departed from the SAM2.1 re-run (possible corrections), MedSAM2 was closer on only 10.
- Model compute: MedSAM2 ≈22 ms/frame vs SAM2.1 Large ≈48 ms/frame (single object); peak allocator 1.9 GiB during the combined run. End-to-end UI latency is dominated by CVAT/network overhead (~0.3 s/frame).
- Conclusion: no evidence MedSAM2 is better on this spinal-endoscopy video; it is offered as an opt-in experiment and **not** the default. A real decision needs independent manual ground truth.

## Rollback

Set `cvat_ui` back to `cvat/ui:sam2-multi-gpu-v3-toolbar` (pre-MedSAM2 UI) and recreate only `cvat_ui`; then `nuctl delete function pth-medsam2-video-mask-gpu --namespace nuclio --platform local` if desired. No annotation data depends on this function.
