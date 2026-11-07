"""Real video GPU limit test. Read-only Task 2; no annotation writes."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import statistics
import subprocess
import time
import requests

P=Path(__file__).parent
B='http://127.0.0.1:18080'
creds=dict(l.split('=',1) for l in Path('/home/xinrun/cvat/.credentials').read_text().splitlines() if '=' in l)
s=requests.Session();s.headers.update({'Accept':'application/vnd.cvat+json','Origin':B,'Referer':B+'/'})
s.post(B+'/api/auth/login',json={'username':'cvatadmin','password':creds['password']},timeout=30).raise_for_status();s.headers['X-CSRFToken']=s.cookies['csrftoken']
a=s.get(B+'/api/jobs/1/annotations',timeout=30).json();seed=next(x for x in a['shapes'] if x['id']==1)['points']
x1,y1,x2,y2=map(int,seed[-4:]);w=x2-x1+1;flat=bytearray()
for i,n in enumerate(seed[:-4]):flat.extend(bytes([i%2])*int(n))
def encode(pixels):
 counts=[];v=0;n=0
 for x in pixels:
  if x==v:n+=1
  else:counts.append(n);v=x;n=1
 counts.append(n);return counts+[x1,y1,x2,y2]
shapes=[{'type':'mask','points':encode(bytearray(v if (i%w)*7//w==k else 0 for i,v in enumerate(flat)))} for k in range(7)]
(P/'seven-seeds.json').write_text(json.dumps(shapes))
frames=P/'frames';frames.mkdir(exist_ok=True)
def getframe(n):
 target=frames/f'{n:03d}.jpg'
 if not target.exists():
  r=s.get(B+f'/api/tasks/2/data?type=frame&number={n}&quality=compressed',timeout=60);r.raise_for_status();target.write_bytes(r.content)
 return n
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:list(pool.map(getframe,range(101)))
print('101 real video frames cached',flush=True)
fn='pth-facebookresearch-sam2-video-mask-gpu-stage'
endpoint=B+'/api/lambda/functions/'+fn
body={'type':'track','task':2,'job':1,'frame':0,'shapes':shapes}
# Check the new boundary while the shared GPU may still be busy.
r=s.post(endpoint,json={**body,'shapes':shapes+[shapes[0]]},timeout=60);r.raise_for_status();d=r.json();assert '1–7' in d.get('error',''),d
print('8 masks correctly rejected',flush=True)
state=None;stats=[];start=time.monotonic()
try:
 for _ in range(240):
  t=time.monotonic();r=s.post(endpoint,json=body,timeout=180);r.raise_for_status();d=r.json()
  if 'busy' in d.get('error','').lower():
   print('Waiting cooperatively for GPU lock',flush=True);time.sleep(5);continue
  if d.get('error'):raise RuntimeError(d['error'])
  state=d['states'];print('7-object CUDA initialization',round(time.monotonic()-t,3),flush=True);break
 else:raise TimeoutError('GPU busy 20 minutes; research untouched')
 assert len(state)==7 and d['device']=='cuda'
 for f in range(1,101):
  t=time.monotonic();r=s.post(endpoint,json={'type':'track','task':2,'job':1,'frame':f,'states':state},timeout=180);r.raise_for_status();d=r.json()
  if d.get('error'):raise RuntimeError(d['error'])
  assert d['device']=='cuda' and d['objects']==list(range(1,8)) and len(d['shapes'])==len(d['states'])==7
  state=d['states'];areas=[];hashes=[]
  for sh in d['shapes']:
   if sh is None:areas.append(0);hashes.append(None);continue
   p=sh['points'];assert sh['type']=='mask';assert all(isinstance(v,int) for v in p);cx1,cy1,cx2,cy2=p[-4:]
   assert 0<=cx1<=cx2<960 and 0<=cy1<=cy2<544 and sum(p[:-4])==(cx2-cx1+1)*(cy2-cy1+1)
   areas.append(sum(p[:-4][1::2]));hashes.append(hashlib.sha256(json.dumps(p).encode()).hexdigest())
  seconds=round(time.monotonic()-t,3)
  env={**os.environ,'LD_LIBRARY_PATH':'/home/xinrun/cvat/.gpu-runtime/lib'}
  memory=subprocess.check_output(['/home/xinrun/cvat/.gpu-runtime/595.71.05/nvidia-smi','--query-gpu=memory.used','--format=csv,noheader,nounits'],env=env,text=True).strip()
  stats.append({'frame':f,'seconds':seconds,'gpu_total_mib':int(memory),'areas':areas,'hashes':hashes})
  if f%10==0:print('frame',f,'seconds',seconds,'gpu_mib',memory,'nonempty',sum(x>0 for x in areas),flush=True)
 (P/'stress-100-stats.json').write_text(json.dumps(stats,indent=2))
 r=s.post(endpoint,json={'type':'track','task':2,'job':1,'frame':101,'states':state},timeout=60);r.raise_for_status();assert '100-frame' in r.json().get('error',''),r.json();print('101st following frame correctly rejected',flush=True)
finally:
 if state:
  r=s.post(endpoint,json={'type':'track','task':2,'job':1,'frame':0,'states':state,'shapes':[{'type':'mask','points':[]}]*7},timeout=60);r.raise_for_status();assert not r.json().get('error'),r.json();print('GPU session released',flush=True)
result={'passed':True,'objects':7,'following_frames':100,'device':'cuda','max_total_gpu_mib':max(x['gpu_total_mib'] for x in stats),'median_seconds':statistics.median(x['seconds'] for x in stats),'nonempty_outputs':sum(n>0 for x in stats for n in x['areas']),'requested_outputs':700,'elapsed_including_wait_seconds':round(time.monotonic()-start,2),'reject_8_objects':True,'reject_101_frames':True,'annotation_writes':False}
(P/'stress-result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result),flush=True)
