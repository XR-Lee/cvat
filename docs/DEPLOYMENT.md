# Deployment

## Topology

```
                        Cloudflare (TLS)
                              |
                        cvat.lxrserver.xyz
                              |
                    traefik:v3.6   host port 18080 -> 8080
                    /                         \
              cvat_server                 cvat_ui
           cvat/server:v2.80.0      cvat/ui:sam2-multi-gpu-v5-polygon
                    |
      postgres 15 | redis-inmem | kvrocks (chunk cache) | clickhouse
                    |
            rq workers: annotation / import / export / chunks / utils /
                        quality_reports / webhooks / consensus
                    |
                  nuclio 1.16.3  (SAM2 / MedSAM2 GPU functions)
```

## Ports

| Service | Published | Notes |
|---|---|---|
| traefik | `18080 -> 8080` | our patch: upstream publishes `8080` + `8090`, which collide with other services on this host |
| nuclio dashboard | `127.0.0.1:8070` | loopback only |

### Nuclio function ports (pinned)

| Function | Host port |
|---|---|
| SAM 2.1 point/box interactor | 32768 |
| Grounding DINO + SAM 2.1 auto-labeling | 32769 |
| SAM 2.1 rectangle tracker | 32770 |
| SAM2.1 CPU single-mask video | 32771 |
| SAM2.1 GPU multi-mask video | 32772 |
| MedSAM2 GPU multi-mask video | 32774 |
| MedSAM2 point/box interactor | 32775 |
| Grounding DINO + MedSAM2 auto-labeling | 32776 |

Ports are pinned in each `function.yaml` (`triggers.myHttpTrigger.attributes.port`).
Nuclio otherwise assigns random host ports, which collided after the
2026-10-27 reboot (the rectangle tracker took 32768 and the point interactor
could not start).

## Images

| Image | Built from | Purpose |
|---|---|---|
| `cvat/server:v2.80.0` | upstream | unchanged |
| `cvat/ui:sam2-video-v1` | `overlay/components/sam2-video/Dockerfile.ui` | upstream bundle + `mask-video-action.js` |
| `cvat/ui:sam2-multi-gpu-v5-polygon` | `.../Dockerfile.ui.multi` | above + `multi-mask-gpu.js` (script cache `polygon-1`) |
| `cvat.sam2-video-cuda:2.9-cu128-595.71.05` | `.../Dockerfile.gpu` | torch 2.9/cu128 + host driver libs |
| `cvat.pth.bowang-lab.medsam2:latest` | `build/medsam2/Dockerfile` | MedSAM2 runtime |

### GPU driver libraries

The GPU functions do **not** ship a fixed driver version at runtime.
`host_nvidia.py` runs before CUDA initialises, symlinks the host's own
`libcuda*` / `libnvidia-*` from `/host-nvidia-lib` (the host root exposed
through snap's `/var/lib/snapd/hostfs`) into `/opt/nvidia-host`, and sets
`LD_LIBRARY_PATH` to that directory only. The links are recreated on every
container start, so a host driver upgrade is picked up without rebuilding.
`--gpus`/`--resource-limit nvidia.com/gpu=1` cannot be used here: snap Docker
uses CDI hooks and rejects them.

The UI images never rebuild the upstream bundle — they copy one JS file into
`/usr/share/nginx/html/` and inject a `<script defer>` tag into `index.html`.
That keeps upgrades cheap: a new upstream UI tag only needs a re-run of
`build-ui.sh` with `UPSTREAM_UI=<new tag>`.

## Bring-up

```bash
./scripts/apply-overlay.sh                    # upstream v2.80.0 + our layer -> ./cvat
./scripts/build-ui.sh
./scripts/build-nuclio.sh
cd cvat && docker compose up -d
```

## Restart / rollback

```bash
cd cvat
docker compose up -d cvat_ui          # UI-only change
docker compose restart cvat_server    # settings change (production.public.py is bind-mounted)
docker compose down && docker compose up -d   # full
```

`production.public.py` and `docker-compose.override.yml` are the only files that
affect the running stack without an image rebuild. Both are plain bind mounts /
compose config, so rollback is `git checkout` + `docker compose up -d`.

## Verification after deploy

```bash
# UI plugin actually served
curl -s https://cvat.lxrserver.xyz/ | grep -o 'multi-mask-gpu.js[^"]*'

# server settings loaded
docker exec cvat_server python -c "from django.conf import settings; print(settings.CSRF_TRUSTED_ORIGINS)"

# functions healthy
docker ps --format '{{.Names}}\t{{.Status}}' | grep '^nuclio-'

# GPU visible inside a function (host libraries are linked at start-up)
docker exec nuclio-nuclio-pth-facebookresearch-sam2-video-mask-gpu \
  python3 -c 'import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))'

# functions report the host driver version they picked up
docker logs nuclio-nuclio-pth-medsam2-video-mask-gpu 2>&1 | grep 'host driver'
```

## Aliyun OSS integration

**Reading videos.** `remote_files` + presigned GET URLs. Do *not* try to register
the bucket as a CVAT Cloud Storage: CVAT's boto3 client uses path-style addressing
and OSS's S3-compatible endpoint only accepts virtual-hosted style, so the
credential probe fails (`SecondLevelDomainForbidden` → "Access forbidden").
See `scripts/presign.py` and `scripts/create-tasks-from-oss.py`.

**If you do need a real Cloud Storage** (backing CS, export targets), the fix is a
botocore shared-config file, which botocore merges into the `Config(...)` that CVAT
constructs explicitly:

```ini
# mount at /home/django/.aws/config in cvat_server + workers
[default]
s3 =
    addressing_style = virtual
```

```yaml
# docker-compose.override.yml
environment:
  AWS_CONFIG_FILE: /home/django/.aws/config
volumes:
  - ./oss-aws-config:/home/django/.aws:ro
```

With that, `head_bucket`, `list_objects_v2` and ranged `get_object` all succeed
against `https://s3.oss-cn-chengdu.aliyuncs.com`.

**Backing cloud storage.** `CVAT_DEFAULT_BACKING_CS_ID` moves a task's raw media
off local disk after creation; video needs an existing `data/manifest.jsonl`.
Existing tasks: `python manage.py movetasktobackingcs <task_ids> <cs_id>`.

## Disk

- Raw videos: `data/<data_id>/raw/` — permanent
- Chunks: served through the `media` cache (kvrocks volume `cvat_cache_db`), TTL-bounded,
  so browsing a task does not permanently grow `data/`
- Measured 1080p / image_quality 70: **53.7 KB per frame** compressed
  (3.87 MB per 72-frame chunk)
