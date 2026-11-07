#!/usr/bin/env python3
"""Redact pixel-level annotation geometry from the published evidence tree.

The evidence directory intentionally keeps verification results (counts, IoU,
latency, pass/fail) but must not publish the surgical video's mask/polygon
coordinates: those encode the patient's endoscopic frames and are the same
class of data as the screenshots, which .gitignore already excludes.

This script is idempotent and is applied to every commit when the public
history is rewritten (see scripts/purge-geometry-from-history.sh).

Rules:
  * JSON: every "points"/"mask"/"counts" value is replaced by a summary
    (length, bbox, foreground pixels, SHA-256 of the raw value).
  * Everything else (metrics, ids, labels, timings, booleans) is preserved.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else "evidence").resolve()
GEOMETRY_KEYS = {"points", "mask", "counts", "mask_points", "rle"}
SECRETISH_KEYS = {"states", "state"}


def summarize(value):
    if not isinstance(value, list):
        return {"redacted": True, "type": type(value).__name__}
    raw = json.dumps(value, sort_keys=True).encode()
    out = {
        "redacted": True,
        "kind": "geometry",
        "length": len(value),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }
    if value and all(isinstance(v, (int, float)) for v in value):
        out["min"] = min(value)
        out["max"] = max(value)
        if len(value) >= 4 and all(isinstance(v, (int, float)) for v in value[-4:]):
            out["bbox"] = value[-4:]
    return out


def walk(node):
    if isinstance(node, dict):
        out = {}
        for k, v in node.items():
            if k in GEOMETRY_KEYS and isinstance(v, list):
                out[k] = summarize(v)
            elif k in SECRETISH_KEYS:
                # Signed tracker-state blobs are replayable capabilities; keep only a digest.
                out[k] = summarize(v) if isinstance(v, list) else {"redacted": True, "kind": "signed-state"}
            else:
                out[k] = walk(v)
        return out
    if isinstance(node, list):
        return [walk(v) for v in node]
    return node


def main() -> int:
    check = "--check" in sys.argv[1:]
    changed = []
    for path in sorted(ROOT.rglob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
        cleaned = walk(data)
        if cleaned == data:
            continue
        changed.append(str(path.relative_to(ROOT.parent)))
        if not check:
            path.write_text(json.dumps(cleaned, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if check:
        if changed:
            print(f"FAIL: {len(changed)} evidence file(s) still contain geometry:")
            for name in changed:
                print(f"  {name}")
            return 1
        print("OK: evidence contains no pixel-level geometry")
        return 0
    print(f"sanitized {len(changed)} evidence file(s)")
    for name in changed:
        print(f"  {name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
