"""A/B: production SAM 2.1 detector vs Grounding DINO + MedSAM2 detector, same frames, same threshold."""
import base64, json, os, time, urllib.request
import cv2, numpy as np

D = '/d'
ENDPOINTS = {'sam21': 'http://nuclio-nuclio-pth-facebookresearch-sam2-1-hiera-large-auto:8080',
             'medsam2': 'http://nuclio-nuclio-pth-medsam2-auto:8080'}

def call(url, raw):
    body = json.dumps({'image': base64.b64encode(raw).decode(), 'threshold': 0.25}).encode()
    t = time.perf_counter()
    with urllib.request.urlopen(urllib.request.Request(url, data=body, headers={'Content-Type': 'application/json'}), timeout=600) as r:
        out = json.loads(r.read())
    return out, time.perf_counter() - t

def bitmap(det, h, w):
    p = det['mask']; x1, y1, x2, y2 = p[-4:]
    m = np.zeros((h, w), bool); m[y1:y2 + 1, x1:x2 + 1] = np.asarray(p[:-4], np.uint8).reshape(y2 - y1 + 1, x2 - x1 + 1) > 0
    return m

def draw(canvas, m, color):
    cs, _ = cv2.findContours(m.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE); cv2.drawContours(canvas, cs, -1, color, 2)

frames = sorted(f for f in os.listdir(f'{D}/frames') if f.endswith('.png'))
report = {'frames': []}; tiles = []
for name in frames:
    raw = open(f'{D}/frames/{name}', 'rb').read(); img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR); h, w = img.shape[:2]
    a, ta = call(ENDPOINTS['sam21'], raw); b, tb = call(ENDPOINTS['medsam2'], raw)
    same = [(x['label'], x['confidence']) for x in a] == [(x['label'], x['confidence']) for x in b]
    dets = []
    canvas = img.copy()
    for da, db in zip(a, b):
        ma, mb = bitmap(da, h, w), bitmap(db, h, w)
        u = (ma | mb).sum(); iou = float((ma & mb).sum() / u) if u else 1.0
        dets.append({'label': da['label'], 'confidence': da['confidence'], 'iou': round(iou, 3), 'sam21_area': int(ma.sum()), 'medsam2_area': int(mb.sum())})
        draw(canvas, ma, (40, 40, 255)); draw(canvas, mb, (40, 220, 40))
        ys, xs = np.nonzero(ma | mb)
        if len(xs): cv2.putText(canvas, f"{da['label'][:0]}{da['confidence']}", (int(xs.min()) + 4, int(ys.min()) + 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
    row = {'frame': int(name[:5]), 'same_detections': same, 'n_sam21': len(a), 'n_medsam2': len(b), 'sec_sam21': round(ta, 2), 'sec_medsam2': round(tb, 2), 'detections': dets}
    report['frames'].append(row); print(json.dumps(row, ensure_ascii=False), flush=True)
    cv2.putText(canvas, f"frame {row['frame']}  n={len(a)}", (12, 34), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 2)
    tiles.append(cv2.resize(canvas, (480, 272)))
while len(tiles) % 4: tiles.append(np.zeros_like(tiles[0]))
cv2.imwrite(f'{D}/ab-sheet.png', np.vstack([np.hstack(tiles[i:i + 4]) for i in range(0, len(tiles), 4)]))
ious = [d['iou'] for f in report['frames'] for d in f['detections']]
report['summary'] = {'frames': len(frames), 'detections': len(ious), 'all_detections_identical': all(f['same_detections'] for f in report['frames']),
                     'median_iou': float(np.median(ious)) if ious else None, 'iou_below_0_5': sum(i < 0.5 for i in ious),
                     'median_sec_sam21': float(np.median([f['sec_sam21'] for f in report['frames']])), 'median_sec_medsam2': float(np.median([f['sec_medsam2'] for f in report['frames']]))}
json.dump(report, open(f'{D}/ab-result.json', 'w'), ensure_ascii=False, indent=2); print(json.dumps(report['summary']))
