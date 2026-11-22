# In-UI export of annotated frames (2026-11-21)

CVAT's export dialog has only *Export format*, *Save images*, *Name template*
and the export API accepts `format / filename / location / cloud_storage_id /
save_images` (`cvat/apps/engine/mixins.py`). There is **no frame filter**, and
`save_images=true` always writes every frame at original quality.

`components/sam2-video/export-annotated.js` adds the missing option in the
browser, without touching the server image:

1. click **导出已标注帧** next to the task page **Actions** button, or the
   **只导出已标注帧…** link inside CVAT's own *Export task as a dataset*
   dialog (bottom-left of its footer);
2. pick the format (COCO 1.0 / Segmentation mask 1.1) and frame quality
   (compressed JPEG or original PNG);
3. the plugin asks CVAT for an annotations-only export (small, authoritative),
   reads that zip in the page with the native `DecompressionStream`, fetches
   only the frames that carry annotations, repacks them with a built-in
   stored-zip writer and downloads `task-<id>-annotated-<format>.zip`.

Nothing is written server-side and the task is never modified.

Verified (`.diagnostics/export-annotated-20261119/`, scripts committed under
`evidence/`):

| Case | Result |
|---|---|
| Disposable 4-frame task, shapes on frames 0 and 2 only | COCO zip: 3 entries, exactly frames 0 and 2, 2 annotations, every annotation references a kept image, zip integrity ok. Segmentation-mask zip: masks and JPEGs for 0/2 only, `default.txt` lists them, labelmap colours intact |
| Real task #2 (13,632 frames, 77 annotated, 238 annotations) | 4 seconds, **2.0 MB**, 78 entries, zip integrity ok, Task 2 annotations byte-identical before/after |
| Entry inside the stock export dialog | link rendered in the footer; clicking closes the stock modal (React teardown, wrap removed) and opens ours with the same task, then produced the same 2.0 MB export |

Limitations:

- Frames are filtered by *presence of any annotation*; per-label frame
  filtering is not offered (a kept frame keeps all of its annotations).
- Packing happens in the browser, so very large annotated sets (tens of
  thousands of frames) need time and memory; the zip entries are stored, not
  deflated.
- Requires `DecompressionStream` (Chrome/Edge 103+, Safari 16.4+).
- `--project` scope is not offered in the UI; export task by task. The CLI
  alternative is `scripts/export-annotated-frames.py` (same result, streams to
  disk).

The in-dialog link is injected into the compiled React dialog's footer, so it
is an additional action, not a real form field: it closes that dialog through
its own Cancel button and opens the plugin's dialog. The stock dialog itself
still cannot filter frames.
