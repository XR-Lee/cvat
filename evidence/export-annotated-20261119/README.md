# Export format investigation (2026-11-19)

Why an export with images is ~20x the source video, and how to export only
annotated frames.

| File | Purpose |
|---|---|
| `export.py` | exports one tiny task in four formats (Segmentation mask, MOTS PNG, COCO, CVAT for video) |
| `inspect2.py` | inspects those archives: mask pixel histograms, instance vs semantic maps, COCO segmentation types |
| `rlecheck.py` | validates a CVAT RLE against `pycocotools.frPyObjects` (run inside a CVAT worker) |
| `measure_compress.py` | measures PNG -> JPEG/WebP size for real exported frames |
| `coco-summary.json`, `segmask-summary.json` | output of `scripts/export-annotated-frames.py` on task #2 |
| `verify-frames10.cjs`, `frames10-result.json` | browser check that the temporal-tracking default is 10 frames |

Not committed here (kept on the deployment host under
`/home/xinrun/cvat/.diagnostics/`): the exported archives themselves, because
they contain the surgical video's masks and polygon coordinates.
