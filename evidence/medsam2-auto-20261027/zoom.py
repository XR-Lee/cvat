import base64,json,urllib.request,cv2,numpy as np
def call(u,raw):
    b=json.dumps({'image':base64.b64encode(raw).decode(),'threshold':0.25}).encode()
    return json.loads(urllib.request.urlopen(urllib.request.Request(u,data=b,headers={'Content-Type':'application/json'}),timeout=600).read())
def bm(d,h,w):
    p=d['mask'];x1,y1,x2,y2=p[-4:];m=np.zeros((h,w),np.uint8);m[y1:y2+1,x1:x2+1]=np.asarray(p[:-4],np.uint8).reshape(y2-y1+1,x2-x1+1);return m
rows=[]
for f,k in (('00000',1),('01500',1),('02993',1),('08000',1)):
    raw=open(f'/d/frames/{f}.png','rb').read();img=cv2.imdecode(np.frombuffer(raw,np.uint8),cv2.IMREAD_COLOR);h,w=img.shape[:2]
    a=call('http://nuclio-nuclio-pth-facebookresearch-sam2-1-hiera-large-auto:8080',raw)[k];b=call('http://nuclio-nuclio-pth-medsam2-auto:8080',raw)[k]
    tiles=[]
    for d,color,name in ((a,(60,60,255),'SAM2.1'),(b,(60,220,60),'MedSAM2')):
        m=bm(d,h,w);c=img.copy();ov=c.copy();ov[m>0]=color;c=cv2.addWeighted(ov,0.35,c,0.65,0)
        cs,_=cv2.findContours(m,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_NONE);cv2.drawContours(c,cs,-1,color,2)
        cv2.putText(c,f'frame {int(f)} {name}: {d["label"] and "label"} {d["confidence"]}',(10,30),cv2.FONT_HERSHEY_SIMPLEX,0.8,(255,255,255),2)
        tiles.append(c[:,180:780])
    rows.append(np.hstack(tiles))
cv2.imwrite('/d/zoom.png',np.vstack(rows))
