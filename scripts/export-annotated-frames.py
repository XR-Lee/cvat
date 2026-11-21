#!/usr/bin/env python3
"""Export a CVAT task as a dataset containing ONLY annotated frames.

CVAT's dataset export API has no "annotated frames only" switch: it always
writes every frame of the task (or every frame's annotation). This script
combines two cheap CVAT calls instead:

  1. annotations-only export in the target format (small: no images)
  2. per-frame fetch of just the frames that actually carry annotations

Supported formats:
  coco              COCO 1.0  -> annotations/instances_default.json + images/default/*
  segmentation-mask Segmentation mask 1.1 -> SegmentationClass/, SegmentationObject/, JPEGImages/

Usage:
  python3 export-annotated-frames.py --task 2 --format coco --out /tmp/task2
  python3 export-annotated-frames.py --task 2 --format coco --quality compressed --out /tmp/task2c
  python3 export-annotated-frames.py --project 1 --format segmentation-mask --out /tmp/project1

Credentials: /home/xinrun/cvat/.credentials by default (KEY=value lines).
"""
from __future__ import annotations

import argparse
import io
import json
import pathlib
import re
import sys
import time
import urllib.parse
import zipfile

import requests

DEFAULT_CREDENTIALS = "/home/xinrun/cvat/.credentials"
FORMATS = {
    "coco": "COCO 1.0",
    "segmentation-mask": "Segmentation mask 1.1",
}


def load_credentials(path: str) -> tuple[str, str]:
    values = {}
    for line in pathlib.Path(path).read_text().splitlines():
        if "=" in line and not line.strip().startswith("#"):
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    user = values.get("username") or values.get("user")
    password = values.get("password")
    if not user or not password:
        raise SystemExit(f"username/password not found in {path}")
    return user, password


class Client:
    def __init__(self, server: str, user: str, password: str):
        self.base = server.rstrip("/")
        self.session = requests.Session()
        self.session.headers.update({
            "Accept": "application/vnd.cvat+json",
            "Origin": self.base,
            "Referer": self.base + "/",
        })
        response = self.session.post(f"{self.base}/api/auth/login",
                                     json={"username": user, "password": password}, timeout=60)
        response.raise_for_status()
        self.session.headers["X-CSRFToken"] = self.session.cookies.get("csrftoken", "")

    def get(self, path: str, **kwargs):
        response = self.session.get(self.base + path, **kwargs)
        response.raise_for_status()
        return response

    def post(self, path: str, **kwargs):
        response = self.session.post(self.base + path, **kwargs)
        response.raise_for_status()
        return response


def annotation_frames(client: Client, kind: str, instance_id: int) -> tuple[set[int], list[int]]:
    """Frame numbers (task-absolute) that carry at least one shape/track keyframe."""
    jobs_response = client.get("/api/jobs", params={"task_id": instance_id} if kind == "task" else
                               {"project_id": instance_id, "page_size": 500})
    jobs = jobs_response.json()["results"]
    if kind == "project":
        raise SystemExit("project scope needs a per-task loop; use --task")

    frames: set[int] = set()
    annotation_jobs = [job for job in jobs if job["type"] == "annotation"]
    for job in annotation_jobs:
        payload = client.get(f"/api/jobs/{job['id']}/annotations").json()
        offset = job["start_frame"]
        for shape in payload.get("shapes", []):
            frames.add(shape["frame"] + offset)
        for track in payload.get("tracks", []):
            for keyframe in track.get("shapes", []):
                if not keyframe.get("outside"):
                    frames.add(keyframe["frame"] + offset)
    return frames, [job["id"] for job in annotation_jobs]


def export_annotations(client: Client, kind: str, instance_id: int, cvat_format: str) -> zipfile.ZipFile:
    endpoint = f"/api/{kind}s/{instance_id}/dataset/export"
    print(f"==> annotations-only export ({cvat_format})", flush=True)
    response = client.post(endpoint, params={"format": cvat_format, "save_images": False})
    rq_id = response.json()["rq_id"]
    while True:
        status = client.get("/api/requests/" + urllib.parse.quote(rq_id, safe="")).json()
        if status["status"] == "finished":
            break
        if status["status"] == "failed":
            raise SystemExit(f"export failed: {status.get('message')}")
        time.sleep(2)
    result_url = status["result_url"]
    if not result_url.startswith(client.base):
        result_url = client.base + urllib.parse.urlsplit(result_url).path + (
            "?" + urllib.parse.urlsplit(result_url).query if urllib.parse.urlsplit(result_url).query else "")
    download = client.get(result_url.replace(client.base, "", 1), timeout=600)
    return zipfile.ZipFile(io.BytesIO(download.content))


def fetch_frame(client: Client, kind: str, instance_id: int, frame: int, quality: str) -> bytes:
    response = client.get(f"/api/{kind}s/{instance_id}/data",
                          params={"type": "frame", "number": frame, "quality": quality}, timeout=120)
    return response.content


def sniff_extension(data: bytes) -> str:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if data[:2] == b"\xff\xd8":
        return ".jpg"
    return ".png"


def export_coco(client: Client, instance_id: int, quality: str, out: pathlib.Path) -> dict:
    archive = export_annotations(client, "task", instance_id, FORMATS["coco"])
    data = json.loads(archive.read("annotations/instances_default.json"))
    annotated_ids = {ann["image_id"] for ann in data["annotations"]}
    images = [image for image in data["images"] if image["id"] in annotated_ids]
    frame_by_id = {image["id"]: int(image["file_name"].rsplit("_", 1)[-1].split(".")[0]) for image in images}
    print(f"    {len(images)} annotated frames of {len(data['images'])}; {len(data['annotations'])} annotations", flush=True)

    out.mkdir(parents=True, exist_ok=True)
    (out / "annotations").mkdir(exist_ok=True)
    (out / "images" / "default").mkdir(parents=True, exist_ok=True)
    written = 0
    for image in images:
        frame = frame_by_id[image["id"]]
        payload = fetch_frame(client, "task", instance_id, frame, quality)
        extension = sniff_extension(payload)
        image["file_name"] = pathlib.Path(image["file_name"]).stem + extension
        (out / "images" / "default" / image["file_name"]).write_bytes(payload)
        written += 1
        if written % 20 == 0:
            print(f"    ... {written}/{len(images)} frames", flush=True)

    filtered = {
        "info": data.get("info", {}),
        "licenses": data.get("licenses", []),
        "categories": data["categories"],
        "images": images,
        "annotations": [ann for ann in data["annotations"] if ann["image_id"] in annotated_ids],
    }
    (out / "annotations" / "instances_default.json").write_text(
        json.dumps(filtered, ensure_ascii=False), encoding="utf-8")
    return {"format": "coco", "frames": written, "annotations": len(filtered["annotations"]),
            "categories": len(data["categories"])}


def export_segmentation_mask(client: Client, instance_id: int, quality: str, out: pathlib.Path) -> dict:
    archive = export_annotations(client, "task", instance_id, FORMATS["segmentation-mask"])
    names = archive.namelist()
    # annotation-only export still contains the mask images (they ARE the annotation)
    masks = [name for name in names if name.startswith(("SegmentationClass/", "SegmentationObject/"))]
    stems = sorted({pathlib.Path(name).stem for name in masks if name.startswith("SegmentationClass/")})
    print(f"    {len(stems)} annotated frames with masks; {len(masks)} mask files", flush=True)

    out.mkdir(parents=True, exist_ok=True)
    (out / "JPEGImages").mkdir(exist_ok=True)
    for name in masks:
        target = out / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(archive.read(name))
    if "labelmap.txt" in names:
        (out / "labelmap.txt").write_bytes(archive.read("labelmap.txt"))
    if "ImageSets/Segmentation/default.txt" in names:
        (out / "ImageSets" / "Segmentation").mkdir(parents=True, exist_ok=True)
        lines = [stem for stem in stems]
        (out / "ImageSets" / "Segmentation" / "default.txt").write_text("\n".join(lines) + "\n")

    # masks are named f<frame>.png; fetch the matching source frames only
    for index, stem in enumerate(stems):
        match = re.search(r"(\d+)$", stem)
        if not match:
            raise SystemExit(f"cannot derive a frame number from {stem!r}")
        frame = int(match.group(1))
        payload = fetch_frame(client, "task", instance_id, frame, quality)
        (out / "JPEGImages" / (stem + sniff_extension(payload))).write_bytes(payload)
        if (index + 1) % 20 == 0:
            print(f"    ... {index + 1}/{len(stems)} frames", flush=True)
    return {"format": "segmentation-mask", "frames": len(stems), "mask_files": len(masks)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    scope = parser.add_mutually_exclusive_group(required=True)
    scope.add_argument("--task", type=int, help="task id")
    scope.add_argument("--project", type=int, help="project id (not supported yet)")
    parser.add_argument("--format", choices=FORMATS, default="coco")
    parser.add_argument("--quality", choices=("original", "compressed"), default="compressed",
                        help="frame quality: original (PNG, large) or compressed (JPEG, small)")
    parser.add_argument("--out", required=True, type=pathlib.Path, help="output directory")
    parser.add_argument("--server", default="http://127.0.0.1:18080")
    parser.add_argument("--credentials", default=DEFAULT_CREDENTIALS)
    parser.add_argument("--zip", action="store_true", help="also write <out>.zip")
    args = parser.parse_args()

    if args.project is not None:
        raise SystemExit("--project is not implemented; export task by task")

    user, password = load_credentials(args.credentials)
    client = Client(args.server, user, password)
    frames, _ = annotation_frames(client, "task", args.task)
    print(f"task {args.task}: {len(frames)} annotated frames", flush=True)

    args.out.mkdir(parents=True, exist_ok=True)
    if args.format == "coco":
        summary = export_coco(client, args.task, args.quality, args.out)
    else:
        summary = export_segmentation_mask(client, args.task, args.quality, args.out)

    summary.update({"task": args.task, "quality": args.quality, "annotated_frames": len(frames)})
    (args.out / "export-summary.json").write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")

    if args.zip:
        archive_path = args.out.with_suffix(".zip")
        with zipfile.ZipFile(archive_path, "w", zipfile.ZIP_DEFLATED) as archive:
            for path in sorted(args.out.rglob("*")):
                if path.is_file():
                    archive.write(path, path.relative_to(args.out))
        summary["zip"] = str(archive_path)
        summary["zip_mb"] = round(archive_path.stat().st_size / 2 ** 20, 2)
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
