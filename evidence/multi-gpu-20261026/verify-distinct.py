import json,pathlib,time,requests,hashlib
P=pathlib.Path(__file__).parent
c=dict(l.split('=',1) for l in pathlib.Path('/home/xinrun/cvat/.credentials').read_text().splitlines() if '=' in l)
s=requests.Session();b='https://cvat.lxrserver.xyz';s.headers.update({'Accept':'application/vnd.cvat+json','Origin':b,'Referer':b+'/','User-Agent':'Mozilla/5.0 CVAT-Multi-GPU-Test'})
s.post(b+'/api/auth/login',json={'username':'cvatadmin','password':c['password']},timeout=30).raise_for_status();s.headers['X-CSRFToken']=s.cookies['csrftoken']
a=s.get(b+'/api/jobs/1/annotations',timeout=30).json();seed=a['shapes'][0]['points'];runs=list(map(int,seed[:-4]));x1,y1,x2,y2=map(int,seed[-4:]);w=x2-x1+1;h=y2-y1+1;flat=bytearray()
for i,n in enumerate(runs):flat.extend(bytes([i%2])*n)
def encode(pixels):
 counts=[];v=0;n=0
 for x in pixels:
  if x==v:n+=1
  else:counts.append(n);v=x;n=1
 counts.append(n);return counts+[x1,y1,x2,y2]
shapes=[]
for k in range(3):
 pixels=bytearray(v if (i%w)*3//w==k else 0 for i,v in enumerate(flat));shapes.append({'type':'mask','points':encode(pixels)})
state=None;stats=[];endpoint=b+'/api/lambda/functions/pth-facebookresearch-sam2-video-mask-gpu'
try:
 for f in range(21):
  data={'task':2,'job':1,'frame':f,'type':'track'}
  if state:data['states']=state
  else:data['shapes']=shapes
  t=time.monotonic();r=s.post(endpoint,json=data,timeout=180);r.raise_for_status();out=r.json()
  if out.get('error'):raise RuntimeError(out['error'])
  state=out['states'];assert out['device']=='cuda';assert len(out['shapes'])==3
  hashes=[];areas=[];boxes=[]
  for mask in out['shapes']:
   assert mask and mask['type']=='mask';p=mask['points'];cx1,cy1,cx2,cy2=p[-4:];assert sum(p[:-4])==(cx2-cx1+1)*(cy2-cy1+1);areas.append(sum(p[:-4][1::2]));assert areas[-1]>0;boxes.append(p[-4:]);hashes.append(hashlib.sha256(json.dumps(p).encode()).hexdigest())
  assert len(set(hashes))==3,'Objects collapsed to identical masks'
  stats.append({'frame':f,'seconds':round(time.monotonic()-t,3),'device':'cuda','areas':areas,'bboxes':boxes,'hashes':hashes});print(f,stats[-1]['seconds'],areas,flush=True)
finally:
 if state:s.post(endpoint,json={'task':2,'job':1,'frame':0,'type':'track','states':state,'shapes':[{'type':'mask','points':[]}]*3},timeout=60).raise_for_status()
assert s.get(b+'/api/jobs/1/annotations',timeout=30).json()==a
(P/'distinct-stats.json').write_text(json.dumps(stats,indent=2));print('PASS 3 distinct objects across 20 following frames; no production writes')
