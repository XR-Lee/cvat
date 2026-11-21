"""Export the same tiny task in the candidate segmentation formats and inspect them."""
import json
import pathlib
import time
import urllib.parse

import requests

P = pathlib.Path('/home/xinrun/cvat/.diagnostics/export-formats-20261027')
P.mkdir(parents=True, exist_ok=True)
B = 'http://127.0.0.1:18080'
creds = dict(l.split('=', 1) for l in pathlib.Path('/home/xinrun/cvat/.credentials').read_text().splitlines() if '=' in l)
s = requests.Session()
s.headers.update({'Accept': 'application/vnd.cvat+json', 'Origin': B, 'Referer': B + '/'})
s.post(B + '/api/auth/login', json={'username': 'cvatadmin', 'password': creds['password']}, timeout=30).raise_for_status()
s.headers['X-CSRFToken'] = s.cookies['csrftoken']
E = pathlib.Path('/home/xinrun/cvat/.medsam2/eval/frames')
W, H = 960, 544


def rle(rects, hole=None):
    grid = bytearray(W * H)
    for x1, y1, x2, y2 in rects:
        for y in range(y1, y2 + 1):
            grid[y * W + x1:y * W + x2 + 1] = b'\x01' * (x2 - x1 + 1)
    if hole:
        x1, y1, x2, y2 = hole
        for y in range(y1, y2 + 1):
            grid[y * W + x1:y * W + x2 + 1] = b'\x00' * (x2 - x1 + 1)
    xs = [i % W for i, v in enumerate(grid) if v]
    ys = [i // W for i, v in enumerate(grid) if v]
    x1, x2, y1, y2 = min(xs), max(xs), min(ys), max(ys)
    rows = [bytes(grid[y * W + x1:y * W + x2 + 1]) for y in range(y1, y2 + 1)]
    flat = b''.join(rows)
    counts, prev, n = [], flat[0], 0
    for v in flat:
        if v == prev:
            n += 1
        else:
            counts.append(n); prev = v; n = 1
    counts.append(n)
    if flat[0]:  # CVAT RLE always starts with a background run
        counts.insert(0, 0)
    return counts + [x1, y1, x2, y2]


tid = s.post(B + '/api/tasks', json={'name': 'TEMP export format check',
                                    'labels': [{'name': 'structure', 'type': 'mask'}, {'name': 'tool', 'type': 'mask'}]}).json()['id']
files = {f'client_files[{i}]': (f'f{i}.png', (E / f'{i:05d}.jpg').read_bytes(), 'image/png') for i in range(3)}
rid = s.post(B + f'/api/tasks/{tid}/data', data={'image_quality': '100', 'sorting_method': 'lexicographical'}, files=files).json()['rq_id']
for _ in range(60):
    st = s.get(B + '/api/requests/' + urllib.parse.quote(rid, safe='')).json()
    if st['status'] == 'finished':
        break
    assert st['status'] != 'failed', st
    time.sleep(1)
labels = {x['name']: x['id'] for x in s.get(B + f'/api/labels?task_id={tid}').json()['results']}
jid = s.get(B + f'/api/jobs?task_id={tid}').json()['results'][0]['id']
shapes = []
for rects, lb, hole in (([(100, 100, 400, 300)], 'structure', (180, 150, 240, 200)),
                        ([(500, 120, 800, 340)], 'structure', None),
                        ([(300, 350, 650, 450)], 'tool', None)):
    shapes.append({'label_id': labels[lb], 'type': 'mask', 'points': rle(rects, hole), 'frame': 0,
                   'group': 0, 'occluded': False, 'outside': False, 'z_order': 0, 'rotation': 0,
                   'attributes': [], 'source': 'manual'})
s.patch(B + f'/api/jobs/{jid}/annotations?action=create', json={'shapes': shapes}).raise_for_status()
(P / 'task.json').write_text(json.dumps({'task': tid, 'job': jid, 'labels': labels}))
print('task', tid, 'job', jid, 'shapes', [(x['label_id'], len(x['points'])) for x in s.get(B + f'/api/jobs/{jid}/annotations').json()['shapes']], flush=True)
for fmt in ('Segmentation mask 1.1', 'MOTS PNG 1.0', 'COCO 1.0', 'CVAT for video 1.1'):
    r = s.post(B + f'/api/tasks/{tid}/dataset/export', params={'format': fmt, 'save_images': True})
    print('  enqueue', r.status_code, r.text[:120], flush=True); r.raise_for_status()
    rid = r.json()['rq_id']
    for _ in range(240):
        st = s.get(B + '/api/requests/' + urllib.parse.quote(rid, safe='')).json()
        if st['status'] in ('finished', 'failed'):
            break
        time.sleep(1)
    print(fmt, '->', st['status'], flush=True)
    if st['status'] == 'finished':
        r = s.get(B + '/api/requests/' + urllib.parse.quote(rid, safe='') + '/download')
        print('  download', r.status_code, len(r.content), flush=True)
        (P / (fmt.replace(' ', '_').replace('.', '_') + '.zip')).write_bytes(r.content)
