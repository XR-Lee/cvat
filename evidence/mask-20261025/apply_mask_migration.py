"""Apply the tested three-shape migration with backups and freshness guards."""
import json
from pathlib import Path
import requests

ROOT = Path(__file__).parent
BASE = 'https://cvat.lxrserver.xyz'
creds = dict(line.split('=', 1) for line in Path('/home/xinrun/cvat/.credentials').read_text().splitlines() if '=' in line)
session = requests.Session()
session.headers.update({'Accept': 'application/vnd.cvat+json', 'Origin': BASE,
                        'Referer': BASE + '/', 'User-Agent': 'Mozilla/5.0 CVAT-Mask-Migration'})


def req(method, path, **kwargs):
    if 'csrftoken' in session.cookies:
        session.headers['X-CSRFToken'] = session.cookies['csrftoken']
    response = session.request(method, BASE + path, timeout=180, **kwargs)
    if not response.ok:
        print('HTTP failure', method, path, response.status_code, response.text[:500], flush=True)
    response.raise_for_status()
    return response.json() if response.content else None


def read_json(name):
    return json.loads((ROOT / name).read_text())


smoke = read_json('smoke-result.json')
assert smoke['batch']['status'] == 'finished' and smoke['batch']['saved_new_masks'] > 0
assert smoke['polygon_to_mask_update_preserves_id']
req('POST', '/api/auth/login', json={'username': 'cvatadmin', 'password': creds['password']})
original = read_json('annotations-before.json')
labels_before = read_json('labels-before.json')['results']
assert req('GET', '/api/jobs/1/annotations') == original, 'Annotations changed since backup; stop'
assert req('GET', '/api/labels?task_id=2&page_size=100')['results'] == labels_before, 'Labels changed; stop'
assert req('GET', '/api/guides/1') == read_json('guide-before.json'), 'Guide changed; stop'
assert not req('GET', '/api/lambda/requests'), 'Inference active; stop'
proposed = read_json('proposed-mask-shapes.json')['shapes']
assert len(proposed) == len(original['shapes']) == 3
assert {x['id'] for x in proposed} == {x['id'] for x in original['shapes']}
for old, new in zip(original['shapes'], proposed):
    assert {k: v for k, v in old.items() if k not in ('type', 'points')} == {
        k: v for k, v in new.items() if k not in ('type', 'points')}

req('PATCH', '/api/jobs/1/annotations?action=update',
    json={'shapes': proposed, 'tags': [], 'tracks': []})
after = req('GET', '/api/jobs/1/annotations')
assert after['shapes'] == proposed, 'Server did not preserve proposed masks/metadata exactly'
for key in ('tags', 'tracks', 'intervals'):
    assert after.get(key, []) == original.get(key, [])
(ROOT / 'annotations-after.json').write_text(json.dumps(after, ensure_ascii=False, indent=2))
print('Converted 3 polygons to masks; IDs, labels, frames, other metadata unchanged', flush=True)

req('PATCH', '/api/tasks/2', json={'labels': [
    {'id': x['id'], 'name': x['name'], 'color': x['color'], 'type': 'mask'} for x in labels_before]})
labels_after = req('GET', '/api/labels?task_id=2&page_size=100')['results']
assert len(labels_after) == 14
assert all(x['type'] == 'mask' for x in labels_after)
for old, new in zip(labels_before, labels_after):
    assert {k: v for k, v in old.items() if k != 'type'} == {k: v for k, v in new.items() if k != 'type'}
(ROOT / 'labels-after.json').write_text(json.dumps(labels_after, ensure_ascii=False, indent=2))
print('All 14 labels are mask-only; names, IDs, colors and attributes unchanged', flush=True)

# The original guide was empty; do not overwrite a concurrently edited guide.
assert req('GET', '/api/guides/1') == read_json('guide-before.json'), 'Guide changed; stop'
guide = req('PATCH', '/api/guides/1', json={'markdown': (ROOT / 'mask-guide.md').read_text()})
assert guide['markdown'] == (ROOT / 'mask-guide.md').read_text().strip()
(ROOT / 'guide-after.json').write_text(json.dumps(guide, ensure_ascii=False, indent=2))
assert req('GET', '/api/jobs/1/annotations') == after
print('Task guide updated; final mask annotations verified', flush=True)
(ROOT / 'migration-result.json').write_text(json.dumps({
    'task': 2, 'job': 1, 'converted_shape_ids': [x['id'] for x in proposed],
    'mask_label_count': len(labels_after), 'all_checks_passed': True,
    'full_video_inference_started': False}, indent=2))
