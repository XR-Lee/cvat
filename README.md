# cvat

Customization layer over **[CVAT v2.80.0](https://github.com/cvat-ai/cvat)** for
annotating **endoscopic spine surgery video** (endoscopic discectomy), with
SAM2 / MedSAM2 assistive models running on GPU.

This repository holds **only our changes** — not the upstream source tree.
Upstream is pinned to `v2.80.0`; everything here is applied on top of it.

```
upstream cvat v2.80.0  +  this repo  =  the deployment at cvat.lxrserver.xyz
```

---

## What is actually custom

Verified by diffing the live deployment against a pristine `v2.80.0` tarball —
the whole delta is **6 items**:

| # | Path | Change |
|---|---|---|
| 1 | `docker-compose.yml` | traefik ports `8080/8090` → `18080` (see `patches/`) |
| 2 | `docker-compose.override.yml` | **new** — host name, CSRF origins, traefik routing, custom UI image, nuclio port |
| 3 | `production.public.py` | **new** — Django settings: nginx sendfile, uvicorn access log, CSRF origins from env |
| 4 | `components/sam2-video/` | **new** — browser plugins + Dockerfiles for the SAM2 UI actions |
| 5 | `serverless/pytorch/facebookresearch/sam2/` | **new** — 5 SAM2 nuclio functions + tests |
| 6 | `serverless/pytorch/bowang-lab/medsam2/` | **new** — 3 MedSAM2 nuclio functions + tests |

Everything else in the upstream tree is untouched.

---

## Layout

```
overlay/                     drop-in files, paths mirror upstream exactly
  docker-compose.override.yml
  production.public.py
  components/sam2-video/                 UI plugins + Dockerfiles
  serverless/pytorch/facebookresearch/sam2/
  serverless/pytorch/bowang-lab/medsam2/
patches/                     patch against upstream v2.80.0
  0001-traefik-ports.patch
build/medsam2/               Dockerfile for the MedSAM2 runtime image
scripts/                     apply / build / operate
  apply-overlay.sh           fetch upstream + apply overlay + patch
  build-ui.sh                build the two cvat/ui images
  build-nuclio.sh            build + deploy nuclio functions
  presign.py                 OSS presigned GET URL generator
  create-tasks-from-oss.py   bulk-create annotation tasks from OSS videos
docs/                        deployment, models, task inventory
evidence/                    verification artifacts (JSON/logs) per change
```

---

## Quick start

```bash
# 1. get upstream + apply our layer into ./cvat
./scripts/apply-overlay.sh            # -> ./cvat

# 2. build the custom images
./scripts/build-ui.sh                 # cvat/ui:sam2-video-v1, cvat/ui:sam2-multi-gpu-v4-medsam2
./scripts/build-nuclio.sh             # SAM2 / MedSAM2 functions

# 3. bring the stack up
cd cvat && docker compose up -d
```

`apply-overlay.sh` is idempotent: it re-downloads the pinned upstream tag into
`.upstream/` and re-applies the overlay.

---

## Deployment

| | |
|---|---|
| Public origin | `https://cvat.lxrserver.xyz` (Cloudflare → traefik) |
| Traefik HTTP port | `18080` (upstream default 8080/8090 conflicts) |
| Server image | `cvat/server:v2.80.0` |
| UI image | `cvat/ui:sam2-multi-gpu-v4-medsam2` |
| GPU | NVIDIA driver 595.71.05, CUDA 12.8, nuclio GPU functions |

Details: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)

## Models

| Function | Backend | Purpose |
|---|---|---|
| `pth-facebookresearch-sam2-1-hiera-large` | SAM 2.1 Hiera-L | single-click segmentation |
| `...-auto` | SAM 2.1 Hiera-L | automatic mask generation |
| `...-tracker` | SAM 2.1 Hiera-L | **rectangle-only** object tracking |
| `...-video-mask` / `...-video-mask-gpu` | SAM 2.1 | temporal mask propagation |
| `pth-medsam2-auto` | MedSAM2 | automatic mask generation |
| `pth-medsam2-interactor` | MedSAM2 | interactive prompts |
| `pth-medsam2-video-mask-gpu` | MedSAM2 | temporal mask propagation |

Details: [`docs/MODELS.md`](docs/MODELS.md)

## Annotation tasks

Project **1 — Endoscopic Discectomy**, 14 mask labels
(神经根 / 硬膜囊 / 黄韧带 / 纤维环 / 髓核 / 椎板 / 关节突 / 硬膜外脂肪 / 血管 /
抓钳 / 双极电凝 / 磨钻 / 咬骨钳 / 神经探钩).

10 tasks built from the processed surgical videos in Aliyun OSS
`oss-pai-zcwendo-op-cq` / `已处理视频/`, 1920×1080 @30 fps, 270,540 frames total.

Inventory and how they were created: [`docs/ANNOTATION-TASKS.md`](docs/ANNOTATION-TASKS.md)

---

## Operational notes

**OSS → CVAT transfer.** CVAT's S3 client uses path-style addressing, but Aliyun
OSS's S3-compatible endpoint requires virtual-hosted style, so registering the
bucket as a CVAT Cloud Storage fails with `SecondLevelDomainForbidden`.
The working path is **presigned GET URLs + `remote_files`** — see
`scripts/create-tasks-from-oss.py`. If you ever need a real Cloud Storage
(backing CS, exports), add to the container env:

```ini
# /home/django/.aws/config  + AWS_CONFIG_FILE=/home/django/.aws/config
[default]
s3 =
    addressing_style = virtual
```

**Disk.** Raw videos live under `data/<data_id>/raw/`. Chunks are served
through the `media` cache (kvrocks volume `cvat_cache_db`, TTL-bounded), so
opening a task does not permanently grow `data/`. Measured 1080p q70:
**53.7 KB/frame** compressed.

---

## License

Upstream CVAT is MIT — see [`LICENSE`](LICENSE).
Vendored model code: SAM 2 is Apache-2.0 (Meta), MedSAM2 is Apache-2.0
(bowang-lab); their weights are research/education-only per their model cards.
