#!/usr/bin/env python3
"""Generate an Aliyun OSS presigned GET URL (Signature V1).

Why this exists
---------------
CVAT's S3 client uses *path-style* addressing, but Aliyun OSS's S3-compatible
endpoint only accepts *virtual-hosted* style, so registering the bucket as a
CVAT Cloud Storage fails with `SecondLevelDomainForbidden`. Presigned URLs sidestep
the whole boto3 layer: CVAT's `remote_files` field accepts plain http(s) URLs and
`requests` follows them fine.

Usage
-----
    export OSS_ACCESS_KEY_ID=LTAI...
    export OSS_ACCESS_KEY_SECRET=...

    ./presign.py "已处理视频/P03-2-00h07m05s-00h12m09s.mp4"
    ./presign.py --bucket my-bucket --region cn-hangzhou --expires 3600 KEY

Notes
-----
* Signature V1 signs the VERB, so a URL signed for GET will 403 on HEAD.
  CVAT only issues GET (`session.get(url, stream=True)`), so that is fine.
* `--expires` is in seconds. Long enough to outlive a big download;
  a 2 GB video from cn-chengdu takes a few minutes.
"""

import argparse
import base64
import hashlib
import hmac
import os
import sys
import time
import urllib.parse

DEFAULT_BUCKET = "oss-pai-zcwendo-op-cq"
DEFAULT_REGION = "cn-chengdu"


def presign(key: str, *, bucket: str, region: str, expires: int,
            access_key_id: str, access_key_secret: str) -> str:
    deadline = int(time.time()) + expires
    string_to_sign = f"GET\n\n\n{deadline}\n/{bucket}/{key}"
    signature = base64.b64encode(
        hmac.new(
            access_key_secret.encode(), string_to_sign.encode(), hashlib.sha1
        ).digest()
    ).decode()
    query = urllib.parse.urlencode(
        {
            "OSSAccessKeyId": access_key_id,
            "Expires": deadline,
            "Signature": signature,
        }
    )
    return (
        f"https://{bucket}.oss-{region}.aliyuncs.com/"
        f"{urllib.parse.quote(key)}?{query}"
    )


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("key", help="object key, e.g. '已处理视频/clip.mp4'")
    p.add_argument("--bucket", default=os.getenv("OSS_BUCKET", DEFAULT_BUCKET))
    p.add_argument("--region", default=os.getenv("OSS_REGION", DEFAULT_REGION))
    p.add_argument("--expires", type=int, default=604800,
                   help="validity in seconds (default 7 days)")
    args = p.parse_args()

    ak = os.getenv("OSS_ACCESS_KEY_ID") or os.getenv("ALIYUN_ACCESS_KEY_ID")
    sk = os.getenv("OSS_ACCESS_KEY_SECRET") or os.getenv("ALIYUN_ACCESS_KEY_SECRET")
    if not ak or not sk:
        print("set OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET", file=sys.stderr)
        return 2

    print(presign(args.key, bucket=args.bucket, region=args.region,
                  expires=args.expires, access_key_id=ak,
                  access_key_secret=sk))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
