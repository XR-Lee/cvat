#!/usr/bin/env python3
"""Bulk-create CVAT annotation tasks from videos in an Aliyun OSS bucket.

Why presigned URLs instead of a CVAT Cloud Storage
--------------------------------------------------
CVAT's boto3 client defaults to path-style addressing; Aliyun OSS's S3-compatible
endpoint requires virtual-hosted style, so CloudStorage registration fails with
`SecondLevelDomainForbidden` / "Access forbidden". CVAT's `remote_files` accepts
plain http(s) URLs, so presigned GET links are the shortest working path.

CVAT 2.80 API note
------------------
Task creation is two calls, not one:
    POST /api/tasks            -> task shell (name, project_id, segment_size)
    POST /api/tasks/{id}/data  -> data upload (remote_files, chunk_size, ...)
Passing `data` inline in the first call is silently ignored and yields a task
with no data.

Usage
-----
    export CVAT_URL=https://cvat.lxrserver.xyz
    export CVAT_TOKEN=<api token>
    export OSS_ACCESS_KEY_ID=... OSS_ACCESS_KEY_SECRET=...

    # 1. dry run: list what would be created
    ./create-tasks-from-oss.py --project-id 1 --prefix 已处理视频/ --dry-run

    # 2. create
    ./create-tasks-from-oss.py --project-id 1 --prefix 已处理视频/

Defaults mirror the reference task "Endoscopic Discectomy":
    chunk_size 72, image_quality 70, use_zip_chunks true
    -> original chunks = mp4, compressed chunks = JPEG imageset
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from presign import presign  # noqa: E402


# --------------------------------------------------------------------------- api
class Cvat:
    def __init__(self, base, token):
        self.base = base.rstrip("/") + "/api"
        self.token = token

    def call(self, path, data=None, method=None, timeout=600):
        body = json.dumps(data).encode() if data is not None else None
        req = urllib.request.Request(
            self.base + path,
            data=body,
            method=method or ("POST" if data is not None else "GET"),
        )
        req.add_header("Authorization", "Token " + self.token)
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode()
                return resp.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()[:800]

    def all_tasks(self):
        st, res = self.call("/tasks?page_size=500")
        return {t["name"]: t["id"] for t in (res or {}).get("results", [])}


# ----------------------------------------------------------------------- oss list
def list_videos(bucket, region, prefix, ak, sk):
    """List .mp4 objects under `prefix` using OSS Signature V1 + virtual-hosted style."""
    import base64
    import hashlib
    import hmac
    import email.utils
    import re

    host = f"{bucket}.oss-{region}.aliyuncs.com"
    date = email.utils.formatdate(usegmt=True)
    sts = f"GET\n\n\n{date}\n/{bucket}/"
    sig = base64.b64encode(
        hmac.new(sk.encode(), sts.encode(), hashlib.sha1).digest()
    ).decode()

    keys, token = [], None
    while True:
        q = {"prefix": prefix, "max-keys": "1000"}
        if token:
            q["marker"] = token
        url = f"https://{host}/?{urllib.parse.urlencode(q)}"
        req = urllib.request.Request(url)
        req.add_header("Date", date)
        req.add_header("Authorization", f"OSS {ak}:{sig}")
        xml = urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace")
        keys += re.findall(r"<Key>(.*?)</Key>", xml)
        truncated = re.search(r"<IsTruncated>(true|false)</IsTruncated>", xml)
        nxt = re.search(r"<NextMarker>(.*?)</NextMarker>", xml)
        if not truncated or truncated.group(1) != "true":
            break
        token = nxt.group(1) if nxt else keys[-1]

    return [k for k in keys if k.lower().endswith(".mp4")]


# -------------------------------------------------------------------------- main
def main():
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--project-id", type=int, required=True)
    p.add_argument("--prefix", default="已处理视频/", help="OSS key prefix")
    p.add_argument("--bucket", default=os.getenv("OSS_BUCKET", "oss-pai-zcwendo-op-cq"))
    p.add_argument("--region", default=os.getenv("OSS_REGION", "cn-chengdu"))
    p.add_argument("--chunk-size", type=int, default=72)
    p.add_argument("--image-quality", type=int, default=70)
    p.add_argument("--no-zip-chunks", action="store_true",
                   help="mp4 chunks instead of JPEG imageset (smaller, lossier)")
    p.add_argument("--segment-size", type=int, default=0)
    p.add_argument("--presign-expires", type=int, default=604800)
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()

    cvat_url = os.getenv("CVAT_URL", "http://localhost:8080")
    token = os.getenv("CVAT_TOKEN")
    ak = os.getenv("OSS_ACCESS_KEY_ID")
    sk = os.getenv("OSS_ACCESS_KEY_SECRET")
    for name, val in (("CVAT_TOKEN", token), ("OSS_ACCESS_KEY_ID", ak),
                      ("OSS_ACCESS_KEY_SECRET", sk)):
        if not val:
            print(f"missing env: {name}", file=sys.stderr)
            return 2

    api = Cvat(cvat_url, token)
    keys = list_videos(args.bucket, args.region, args.prefix, ak, sk)
    if args.limit:
        keys = keys[: args.limit]
    print(f"{len(keys)} video(s) under {args.prefix}")

    existing = {} if args.dry_run else api.all_tasks()

    for key in keys:
        name = os.path.basename(key)[:-4]
        if name in existing:
            print(f"  skip  {name}  (task {existing[name]})")
            continue
        if args.dry_run:
            print(f"  would create  {name}   <- {key}")
            continue

        st, res = api.call("/tasks", {
            "name": name,
            "project_id": args.project_id,
            "segment_size": args.segment_size,
        })
        if st not in (200, 201) or not isinstance(res, dict):
            print(f"  FAIL create {name}: {st} {res}")
            continue
        tid = res["id"]

        url = presign(key, bucket=args.bucket, region=args.region,
                      expires=args.presign_expires,
                      access_key_id=ak, access_key_secret=sk)
        st, res = api.call(f"/tasks/{tid}/data", {
            "remote_files": [url],
            "chunk_size": args.chunk_size,
            "image_quality": args.image_quality,
            "use_zip_chunks": not args.no_zip_chunks,
            "use_cache": True,
            "sorting_method": "lexicographical",
            "copy_data": False,
        })
        if st not in (200, 201, 202):
            print(f"  FAIL data {name}: {st} {res}")
            continue

        print(f"  task {tid}  {name}  downloading...", end="", flush=True)
        while True:
            time.sleep(10)
            _, s = api.call(f"/tasks/{tid}/status")
            if isinstance(s, dict) and s.get("state") in ("Finished", "Failed"):
                print(f" {s['state']} {s.get('message', '')[:100]}")
                break
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
