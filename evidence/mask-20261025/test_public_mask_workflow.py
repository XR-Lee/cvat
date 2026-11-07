"""Public CVAT smoke test in a disposable one-frame task; never edit Task 2."""
import copy
import hashlib
import json
from pathlib import Path
import time
from urllib.parse import quote

import requests

ROOT = Path(__file__).parent
BASE = 'https://cvat.lxrserver.xyz'
creds = dict(line.split('=', 1) for line in Path('/home/xinrun/cvat/.credentials').read_text().splitlines() if '=' in line)
session = requests.Session()
session.headers.update({'Accept': 'application/vnd.cvat+json', 'Origin': BASE,
                        'Referer': BASE + '/', 'User-Agent': 'Mozilla/5.0 CVAT-Mask-Diagnostics'})


def req(method, path, **kwargs):
    if 'csrftoken' in session.cookies:
        session.headers['X-CSRFToken'] = session.cookies['csrftoken']
    response = session.request(method, BASE + path, timeout=180, **kwargs)
    if not response.ok:
        print('HTTP failure', method, path, response.status_code, response.text[:500], flush=True)
    response.raise_for_status()
    return response


def validate_mask(shape, width=960, height=544):
    assert shape['type'] == 'mask', shape['type']
    values = shape['points']
    assert all(int(x) == x for x in values)
    counts = [int(x) for x in values[:-4]]
    x1, y1, x2, y2 = map(int, values[-4:])
    assert 0 <= x1 <= x2 < width and 0 <= y1 <= y2 < height
    assert all(x >= 0 for x in counts)
    assert sum(counts) == (x2 - x1 + 1) * (y2 - y1 + 1)
    assert sum(counts[1::2]) > 0


req('POST', '/api/auth/login', json={'username': 'cvatadmin', 'password': creds['password']})
original = req('GET', '/api/jobs/1/annotations').json()
assert original == json.loads((ROOT / 'annotations-before.json').read_text()), 'Source changed; stop'
labels = req('GET', '/api/labels?task_id=2&page_size=100').json()['results']
models = req('GET', '/api/lambda/functions').json()
detector = next(x for x in models if x['id'].endswith('large-auto'))
assert all(x['type'] == 'mask' for x in detector['labels_v2'])
print('MODEL', detector['name'], 'all labels are mask', flush=True)
task_id = inference_id = None
report = {'model': detector['name']}
try:
    frame = req('GET', '/api/tasks/2/data?type=frame&number=4544&quality=original').content
    task = req('POST', '/api/tasks', json={'name': 'TEMP Mask workflow verification',
               'labels': [{'name': x['name'], 'type': 'any', 'color': x['color']} for x in labels]}).json()
    task_id = task['id']
    upload = req('POST', f'/api/tasks/{task_id}/data', data={'image_quality': '90'},
                 files={'client_files[0]': ('mask-test.jpg', frame, 'image/jpeg')}).json()
    for _ in range(60):
        status = req('GET', '/api/requests/' + quote(upload['rq_id'], safe='')).json()
        if status['status'] == 'finished':
            break
        assert status['status'] != 'failed', status
        time.sleep(1)
    else:
        raise TimeoutError('Task initialization')
    temporary_labels = req('GET', f'/api/labels?task_id={task_id}&page_size=100').json()['results']
    temporary_label = next(x for x in temporary_labels if x['name'] == '髓核')
    source_polygon = copy.deepcopy(original['shapes'][0])
    source_polygon.pop('id')
    source_polygon['frame'] = 0
    source_polygon['label_id'] = temporary_label['id']
    created = req('PATCH', f'/api/tasks/{task_id}/annotations?action=create',
                  json={'shapes': [source_polygon], 'tags': [], 'tracks': []}).json()['shapes'][0]
    converted = copy.deepcopy(json.loads((ROOT / 'proposed-mask-shapes.json').read_text())['shapes'][0])
    converted.update(id=created['id'], frame=0, label_id=temporary_label['id'])
    req('PATCH', f'/api/tasks/{task_id}/annotations?action=update',
        json={'shapes': [converted], 'tags': [], 'tracks': []})
    migrated = req('GET', f'/api/tasks/{task_id}/annotations').json()['shapes'][0]
    validate_mask(migrated)
    assert migrated['id'] == created['id'], 'Update changed shape ID'
    assert migrated['points'] == converted['points']
    assert migrated['label_id'] == converted['label_id']
    req('PATCH', f'/api/tasks/{task_id}', json={'labels': [
        {'id': x['id'], 'name': x['name'], 'color': x['color'], 'type': 'mask'} for x in temporary_labels]})
    assert all(x['type'] == 'mask' for x in req('GET', f'/api/labels?task_id={task_id}&page_size=100').json()['results'])
    report['polygon_to_mask_update_preserves_id'] = True
    print('PASS polygon -> mask update and mask-only labels', flush=True)

    start = time.monotonic()
    detection = req('POST', '/api/lambda/functions/' + detector['id'],
                    json={'task': task_id, 'frame': 0, 'type': 'detect', 'threshold': 0.25,
                          'conv_mask_to_poly': False}).json()
    assert detection['shapes']
    for shape in detection['shapes']:
        validate_mask(shape)
    report['sync'] = {'seconds': round(time.monotonic() - start, 2), 'masks': len(detection['shapes'])}
    print('PASS synchronous masks', report['sync'], flush=True)
    point = req('POST', '/api/lambda/functions/pth-facebookresearch-sam2-1-hiera-large',
                json={'task': task_id, 'frame': 0, 'type': 'interact', 'pos_points': [[480, 272]],
                      'neg_points': [[300, 100]]}).json()
    assert point['shapes']
    for shape in point['shapes']:
        validate_mask(shape)
    report['point_prompt'] = 'valid nonempty masks'

    start = time.monotonic()
    inference = req('POST', '/api/lambda/requests', json={
        'function': detector['id'], 'task': task_id, 'threshold': 0.25, 'cleanup': False,
        'conv_mask_to_poly': False,
        'mapping': {x['name']: {'name': x['name'], 'attributes': {}} for x in temporary_labels}}).json()
    inference_id = inference['id']
    for _ in range(120):
        status = req('GET', '/api/lambda/requests/' + quote(inference_id, safe='')).json()
        if status['status'] == 'finished':
            break
        assert status['status'] != 'failed', status
        time.sleep(1)
    else:
        raise TimeoutError('Batch inference')
    saved = req('GET', f'/api/tasks/{task_id}/annotations').json()
    assert len(saved['shapes']) > 1
    for shape in saved['shapes']:
        validate_mask(shape)
    assert next(x for x in saved['shapes'] if x['id'] == created['id'])['points'] == converted['points']
    report['batch'] = {'seconds': round(time.monotonic() - start, 2), 'status': status['status'],
                       'saved_new_masks': len(saved['shapes']) - 1, 'existing_mask_preserved': True}
    print('PASS batch masks', report['batch'], flush=True)
finally:
    if inference_id:
        req('DELETE', '/api/lambda/requests/' + quote(inference_id, safe=''))
    if task_id:
        req('DELETE', f'/api/tasks/{task_id}')
        print('Temporary task deleted', task_id, flush=True)
    report['original_annotations_unchanged'] = original == req('GET', '/api/jobs/1/annotations').json()
    assert report['original_annotations_unchanged']
    (ROOT / 'smoke-result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
