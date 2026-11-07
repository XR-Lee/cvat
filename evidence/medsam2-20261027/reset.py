import json, pathlib, requests
P = pathlib.Path(__file__).parent
t = json.loads((P / 'temp.json').read_text())
c = dict(l.split('=', 1) for l in pathlib.Path('/home/xinrun/cvat/.credentials').read_text().splitlines() if '=' in l)
s = requests.Session(); b = 'http://127.0.0.1:18080'
s.headers.update({'Accept': 'application/vnd.cvat+json', 'Origin': b, 'Referer': b + '/'})
s.post(b + '/api/auth/login', json={'username': 'cvatadmin', 'password': c['password']}).raise_for_status()
s.headers['X-CSRFToken'] = s.cookies['csrftoken']
a = s.get(b + f'/api/jobs/{t["job"]}/annotations').json(); ids = {x['id'] for x in t['before']['shapes']}
extra = [x for x in a['shapes'] if x['id'] not in ids]
if extra:
    s.patch(b + f'/api/jobs/{t["job"]}/annotations?action=delete', json={'shapes': extra}).raise_for_status()
s.patch(b + f'/api/jobs/{t["job"]}/annotations?action=update', json={'shapes': t['before']['shapes']}).raise_for_status()
assert s.get(b + f'/api/jobs/{t["job"]}/annotations').json()['shapes'] == t['before']['shapes']
print('fixture reset')
