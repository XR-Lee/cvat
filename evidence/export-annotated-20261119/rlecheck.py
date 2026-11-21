import sys, json
from pycocotools import mask as mask_utils
frPyObjects = mask_utils.frPyObjects
pts = json.load(sys.stdin)
for p in pts:
    counts = p[:-4]; left, top, right, bottom = p[-4:]
    h = bottom - top + 1; w = right - left + 1
    print("bbox", left, top, right, bottom, "runs", len(counts), "sum", sum(counts), "expect", h*w, "even", len(counts) % 2)
    try:
        r = frPyObjects([{"counts": counts, "size": [w, h]}], h=h, w=w)[0]
        print("  ok", type(r))
    except Exception as e:
        print("  FAIL", type(e).__name__, e)
