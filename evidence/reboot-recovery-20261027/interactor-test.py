import io, json, sys, time
import numpy as np, torch
from PIL import Image
sys.path.insert(0, '/handler')
import model_handler as mh

raw = open('/eval/frames/00021.jpg', 'rb').read(); img = Image.open(io.BytesIO(raw)).convert('RGB')
ann = json.load(open('/eval/task2-annotations-snapshot.json'))
t = time.perf_counter(); H = mh.ModelHandler(); print('load s', round(time.perf_counter() - t, 2))

def dec(p):
    p = [int(v) for v in p]; c = p[:-4]; x1, y1, x2, y2 = p[-4:]; flat = np.repeat(np.arange(len(c)) % 2, c).astype(bool)
    m = np.zeros((544, 960), bool); m[y1:y2 + 1, x1:x2 + 1] = flat.reshape(y2 - y1 + 1, x2 - x1 + 1); return m

seed = next(x for x in ann['shapes'] if x['group'] == 4 and x['frame'] == 21)  # 抓钳 mask on frame 21
ref = dec(seed['points']); ys, xs = ref.nonzero(); box = [[int(xs.min()), int(ys.min())], [int(xs.max()), int(ys.max())]]
cy, cx = np.argwhere(ref)[len(ys) // 2]
cases = {'box': ([], [], box), 'point': ([[int(cx), int(cy)]], [], None), 'box+points': ([[int(cx), int(cy)]], [[50, 50]], box)}
out = {}
for name, (pos, neg, bb) in cases.items():
    times = []
    for _ in range(2):
        t = time.perf_counter(); pts = H.handle(img, raw, pos, neg, bb); times.append(time.perf_counter() - t)
    m = dec(pts); iou = (m & ref).sum() / (m | ref).sum()
    # Direct official call must match the handler bit for bit.
    pred = H.predictor
    with torch.inference_mode():
        kw = {}
        if pos or neg:
            kw = {'point_coords': np.array(pos + neg, np.float32), 'point_labels': np.array([1] * len(pos) + [0] * len(neg), np.int32)}
        if bb: kw['box'] = np.array([bb[0][0], bb[0][1], bb[1][0], bb[1][1]], np.float32)
        ms, sc, _ = pred.predict(multimask_output=True, **kw)
    direct = ms[int(np.argmax(sc))] > 0
    out[name] = {'first_s': round(times[0], 3), 'cached_s': round(times[1], 3), 'iou_vs_saved_sam_mask': round(float(iou), 3), 'fg': int(m.sum()), 'identical_to_direct_official_call': bool((direct == m).all())}
    print(name, out[name], flush=True)
json.dump(out, open('/out/interactor-test.json', 'w'), indent=2)
