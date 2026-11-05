# Annotation tasks

## Project

**Project 1 — `Endoscopic Discectomy`** (sandbox, owner `cvatadmin`)

14 mask labels, colours carried over verbatim from the original reference task:

| Label | Colour | Label | Colour |
|---|---|---|---|
| 神经根 | `#e74c3c` | 血管 | `#c0392b` |
| 硬膜囊 | `#e67e22` | 抓钳 | `#1abc9c` |
| 黄韧带 | `#f1c40f` | 双极电凝 | `#16a085` |
| 纤维环 | `#3498db` | 磨钻 | `#2ecc71` |
| 髓核 | `#9b59b6` | 咬骨钳 | `#27ae60` |
| 椎板 | `#95a5a6` | 神经探钩 | `#2980b9` |
| 关节突 | `#7f8c8d` | | |
| 硬膜外脂肪 | `#d35400` | | |

## Tasks

Source: Aliyun OSS `oss-pai-zcwendo-op-cq` (cn-chengdu), prefix `已处理视频/`.
All clips 1920×1080 @ 30 fps.

| Task | Clip | Duration | Frames |
|---|---|---|---|
| 12 | `P02-1-00h21m33s-00h27m25s` | 5m52s | 10,560 |
| 13 | `P02-2-00h00m00s-00h27m25s` | 27m25s | 49,380 |
| 14 | `P03-2-00h07m05s-00h12m09s` | 5m04s | 9,120 |
| 15 | `P03-2-00h13m00s-00h21m42s` | 8m42s | 15,660 |
| 16 | `P03-2-00h23m40s-00h27m25s` | 3m45s | 6,750 |
| 17 | `P03-3-00h00m00s-00h27m25s` | 27m25s | 49,380 |
| 18 | `P03-4-00h00m00s-00h13m20s` | 13m20s | 24,000 |
| 19 | `P03-4-00h21m39s-00h27m25s` | 5m46s | 10,380 |
| 20 | `P03-5-00h01m54s-00h27m25s` | 25m31s | 45,930 |
| 21 | `P03-6-00h00m00s-00h27m25s` | 27m25s | 49,380 |

**Total 270,540 frames ≈ 2h30m, 10.84 GB source video.**

## Task configuration

Mirrors the reference task exactly:

| Setting | Value | Why |
|---|---|---|
| `mode` | `interpolation` | video task |
| `segment_size` | 0 → whole clip as one job | matches reference |
| `chunk_size` | 72 | reference |
| `image_quality` | 70 | reference |
| `use_zip_chunks` | `true` | reference: `original_chunk_type=video`, `compressed_chunk_type=imageset` |
| `use_cache` | `true` | chunks cached in kvrocks |
| `sorting_method` | `lexicographical` | reference |

Passing `use_zip_chunks=false` silently changes the compressed chunks to mp4
(`DataChoice.VIDEO`), which is *not* what the reference task uses — this is how
you tell the two configurations apart when inspecting a task.

## Recreating / extending

```bash
export CVAT_URL=https://cvat.lxrserver.xyz
export CVAT_TOKEN=<token>
export OSS_ACCESS_KEY_ID=... OSS_ACCESS_KEY_SECRET=...

./scripts/create-tasks-from-oss.py --project-id 1 --prefix 已处理视频/ --dry-run
./scripts/create-tasks-from-oss.py --project-id 1 --prefix 已处理视频/
```

The script is idempotent — it skips any task whose name already exists, so it can
be re-run after a partial failure or to pick up newly uploaded clips.

## Differences from the reference task

| | Reference (`Endoscopic Discectomy`) | New tasks |
|---|---|---|
| Resolution | 960×544 | 1920×1080 |
| Jobs | 2 (annotation + ground truth) | 1 (annotation only) |
| Labels | task-level | inherited from project 1 |

The ground-truth job was not reproduced. To add one:

```bash
# via UI: task -> Actions -> Create ground truth job
# or via API: POST /api/jobs with type=ground_truth
```

## Cost of loading them

| Item | Value |
|---|---|
| OSS egress (one full read of all clips) | 10.84 GB × ¥0.5/GB ≈ **¥5.4** |
| OSS GET requests | ~0.01 ¥/10k — negligible |
| Local raw video | **11 GB** (`data/<data_id>/raw/`) |
| Chunk cache | ~53.7 KB/frame × 270,540 ≈ 13.8 GB worst case, TTL-bounded |
