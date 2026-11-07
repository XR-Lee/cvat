"""Read-only conversion: emit proposed mask shapes from backed-up polygons."""
import copy
import hashlib
import json
import sys

import cv2
import numpy as np

payload = json.load(sys.stdin)
annotations = payload['annotations']
width, height = payload['width'], payload['height']
assert not annotations.get('tracks'), 'Tracks require a separate migration policy'
converted, stats = [], []
for shape in annotations['shapes']:
    if shape['type'] == 'mask':
        continue
    assert shape['type'] == 'polygon', shape['type']
    assert not shape['rotation'], 'Rotated shapes require a separate conversion'
    points = np.asarray(shape['points']).reshape(-1, 2)
    assert len(points) >= 3
    assert np.isfinite(points).all()
    bitmap = np.zeros((height, width), dtype=np.uint8)
    cv2.fillPoly(bitmap, [np.rint(points).astype(np.int32)], 1)
    ys, xs = bitmap.nonzero()
    assert len(xs), 'Refusing empty converted region'
    x1, y1, x2, y2 = int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())
    crop = bitmap[y1:y2 + 1, x1:x2 + 1]
    flat = crop.ravel()
    transitions = np.flatnonzero(flat[1:] != flat[:-1]) + 1
    counts = np.diff(np.r_[0, transitions, flat.size]).tolist()
    if flat[0]:
        counts.insert(0, 0)
    decoded = np.repeat(np.arange(len(counts)) % 2, counts).reshape(crop.shape)
    np.testing.assert_array_equal(decoded, crop)
    converted_shape = copy.deepcopy(shape)
    converted_shape['type'] = 'mask'
    converted_shape['points'] = counts + [x1, y1, x2, y2]
    converted.append(converted_shape)
    stats.append({'id': shape['id'], 'frame': shape['frame'], 'label_id': shape['label_id'],
                  'foreground_pixels': int(bitmap.sum()), 'bbox': [x1, y1, x2, y2],
                  'bitmap_sha256': hashlib.sha256(bitmap.tobytes()).hexdigest()})
json.dump({'shapes': converted, 'stats': stats}, sys.stdout)
