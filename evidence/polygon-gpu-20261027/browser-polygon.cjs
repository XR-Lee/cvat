const {chromium}=require('/home/xinrun/pi-web/node_modules/playwright');const fs=require('fs'),assert=require('node:assert/strict');
const ROOT=__dirname,base='https://cvat.lxrserver.xyz',MODEL=process.env.MODEL||'SAM2.1 Large',ENDPOINT={MedSAM2:'pth-medsam2-video-mask-gpu','SAM2.1 Large':'pth-facebookresearch-sam2-video-mask-gpu'}[MODEL];
const c=Object.fromEntries(fs.readFileSync('/home/xinrun/cvat/.credentials','utf8').trim().split('\n').map(l=>l.split('=')));
const tmp=JSON.parse(fs.readFileSync(ROOT+'/temp.json'));
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'/home/xinrun/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',args:['--no-sandbox']});try{
 const ctx=await browser.newContext({viewport:{width:1600,height:1000}});
 assert.ok((await ctx.request.post(base+'/api/auth/login',{data:{username:'cvatadmin',password:c.password},headers:{Accept:'application/vnd.cvat+json'}})).ok());
 const csrf=(await ctx.cookies()).find(x=>x.name==='csrftoken').value,headers={'X-CSRFToken':csrf,Origin:base,Referer:base+'/',Accept:'application/vnd.cvat+json'};
 const cur=await(await ctx.request.get(base+`/api/jobs/${tmp.job}/annotations`)).json();
 const poly=cur.shapes.find(s=>s.type==='polygon');assert.ok(poly,'fixture polygon missing');
 const extra=cur.shapes.filter(s=>s.id!==poly.id);if(extra.length)assert.ok((await ctx.request.patch(base+`/api/jobs/${tmp.job}/annotations?action=delete`,{headers,data:{shapes:extra}})).ok());
 const before=await(await ctx.request.get(base+`/api/jobs/${tmp.job}/annotations`)).json();
 const page=await ctx.newPage(),errors=[],calls=[];page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{if(r.method()==='POST'&&/lambda\/functions\//.test(r.url()))calls.push(r.url().split('/functions/')[1].split('?')[0]);});
 await page.addInitScript(()=>window.addEventListener('plugins.ready',()=>window.cvatUI.registerComponent(({store})=>{window.__store=store;return{name:'obs',destructor(){}}}),{once:true}));
 await page.goto(`${base}/tasks/${tmp.task}/jobs/${tmp.job}`);await page.locator('#cvat-multi-mask-gpu-button').waitFor({timeout:90000});
 // The annotation action must now be offered for a polygon object.
 const objStates=await page.evaluate(async()=>{const j=__store.getState().annotation.job.instance;const st=await j.annotations.get(0);const acts=await __store.getState().annotation.job.instance.constructor?[]:[];return st.map(s=>({type:s.shapeType,label:s.label.name}));});
 await page.locator('#cvat-multi-mask-gpu-button').click();const d=page.locator('#cvat-multi-mask-gpu-dialog');await d.locator('[data-role=objects] label').first().waitFor();
 const listText=await d.locator('[data-role=objects]').innerText();assert.match(listText,/多边形/,'polygon listed: '+listText);
 assert.equal(await d.locator('[data-role=objects] input').count(),1);
 await d.locator('[data-role=model]').selectOption(MODEL);await d.locator('[data-role=frames]').fill('3');await page.screenshot({path:ROOT+'/polygon-dialog.png'});
 let msg;for(let i=0;i<120;i++){await d.locator('[data-role=run]').click();await page.waitForFunction(()=>{const x=document.querySelector('#cvat-multi-mask-gpu-dialog');return !x.querySelector('[data-role=run]').disabled&&x.querySelector('[data-role=status]').textContent;},undefined,{timeout:180000});msg=await d.locator('[data-role=status]').innerText();if(/GPU is busy/.test(msg)){await page.waitForTimeout(3000);continue;}break;}
 assert.ok(msg.startsWith('完成'),msg);
 const staged=await page.evaluate(async()=>(await __store.getState().annotation.job.instance.annotations.export()).shapes.map(s=>({frame:s.frame,type:s.type,group:s.group,label:s.label_id})));
 assert.equal(staged.length,4,'polygon + 3 propagated');assert.equal(staged[0].type,'polygon','seed stays a polygon');assert.ok(staged.slice(1).every(s=>s.type==='mask'),JSON.stringify(staged));assert.equal(new Set(staged.map(s=>s.group)).size,1,'one object group');
 assert.ok(calls.filter(x=>/video-mask-gpu/.test(x)).every(x=>x===ENDPOINT),JSON.stringify(calls));
 await d.locator('[data-role=close]').click();await page.getByText('Save',{exact:true}).click();
 await page.waitForFunction(()=>!__store.getState().annotation.job.instance.annotations.hasUnsavedChanges(),undefined,{timeout:60000});
 const saved=await(await ctx.request.get(base+`/api/jobs/${tmp.job}/annotations`)).json();
 assert.equal(saved.shapes.length,4);assert.deepEqual(saved.shapes.find(s=>s.id===poly.id),before.shapes[0],'seed polygon untouched');
 assert.deepEqual(errors,[]);
 const r={passed:true,model:MODEL,message:msg,polygon_listed:true,staged,saved_count:saved.shapes.length,gpu_calls:calls,errors};
 fs.writeFileSync(ROOT+`/browser-result-${MODEL.replace(/\W+/g,'')}.json`,JSON.stringify(r,null,2));console.log(JSON.stringify(r));
}finally{await browser.close();}})().catch(e=>{console.error(e.stack);process.exit(1)});
