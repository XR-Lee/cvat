"""Background CUDA verification of both GPU trackers; waits politely for the research GPU lock."""
import json, pathlib, time, requests
D = pathlib.Path(__file__).parent
ann = json.load(open('/home/xinrun/cvat/.medsam2/eval/task2-annotations-snapshot.json'))
c = dict(l.split('=', 1) for l in pathlib.Path('/home/xinrun/cvat/.credentials').read_text().splitlines() if '=' in l)
s = requests.Session(); b = 'https://cvat.lxrserver.xyz'
s.headers.update({'Accept': 'application/vnd.cvat+json', 'Origin': b, 'Referer': b + '/', 'User-Agent': 'Mozilla/5.0 CVAT-Recovery-GPU'})
s.post(b + '/api/auth/login', json={'username': 'cvatadmin', 'password': c['password']}, timeout=30).raise_for_status()
s.headers['X-CSRFToken'] = s.cookies['csrftoken']
before = s.get(b + '/api/jobs/1/annotations', timeout=30).json()
seed = min((x for x in ann['shapes'] if x['group'] == 4), key=lambda x: x['frame'])
def call(fid, body):
    r = s.post(b + '/api/lambda/functions/' + fid, json={'task': 2, 'job': 1, **body}, timeout=120); r.raise_for_status(); return r.json()
result = {}
deadline = time.monotonic() + 3 * 3600
for fid in ('pth-facebookresearch-sam2-video-mask-gpu', 'pth-medsam2-video-mask-gpu'):
    st, waited = None, 0
    while time.monotonic() < deadline:
        d = call(fid, {'type': 'track', 'frame': seed['frame'], 'shapes': [{'type': 'mask', 'points': seed['points'], 'frames': 3}]})
        if 'busy' in d.get('error', '').lower():
            waited += 1; time.sleep(1); continue
        assert not d.get('error'), d; st = d['states']; break
    if st is None:
        result[fid] = {'passed': False, 'reason': 'GPU lock never free within 3 h'}; continue
    areas = []
    try:
        for i in range(1, 4):
            d = call(fid, {'type': 'track', 'frame': seed['frame'] + i, 'states': st}); assert not d.get('error'), d
            assert d['device'] == 'cuda'; st = d['states']; areas.append(sum(d['shapes'][0]['points'][:-4][1::2]))
    finally:
        call(fid, {'type': 'track', 'frame': seed['frame'], 'states': st, 'shapes': [{'type': 'mask', 'points': []}]})
    result[fid] = {'passed': all(a > 0 for a in areas), 'areas': areas, 'busy_retries': waited, 'utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    print(fid, result[fid], flush=True)
result['task2_unchanged'] = s.get(b + '/api/jobs/1/annotations', timeout=30).json() == before
(D / 'gpu-verify-result.json').write_text(json.dumps(result, indent=2)); print(json.dumps(result), flush=True)
