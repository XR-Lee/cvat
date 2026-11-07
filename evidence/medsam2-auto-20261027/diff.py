import base64,json,urllib.request
def call(u,raw):
    b=json.dumps({'image':base64.b64encode(raw).decode(),'threshold':0.25}).encode()
    return json.loads(urllib.request.urlopen(urllib.request.Request(u,data=b,headers={'Content-Type':'application/json'}),timeout=600).read())
for f in ('00021','03539','06031'):
    raw=open(f'/d/frames/{f}.png','rb').read()
    a=call('http://nuclio-nuclio-pth-facebookresearch-sam2-1-hiera-large-auto:8080',raw);b=call('http://nuclio-nuclio-pth-medsam2-auto:8080',raw)
    print(f,[(x['label'],x['confidence']) for x in a],'|',[(x['label'],x['confidence']) for x in b])
