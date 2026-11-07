const {chromium}=require('/home/xinrun/pi-web/node_modules/playwright');const fs=require('fs'),assert=require('node:assert/strict');
const ROOT=__dirname,prod=process.env.PROD==='1',base='https://cvat.lxrserver.xyz';
const tmp=JSON.parse(fs.readFileSync(ROOT+'/temp.json'));const creds=Object.fromEntries(fs.readFileSync('/home/xinrun/cvat/.credentials','utf8').trim().split('\n').map(l=>l.split('=')));
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'/home/xinrun/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',args:['--no-sandbox']});try{
const ctx=await browser.newContext({viewport:{width:1600,height:1000}});const login=await ctx.request.post(base+'/api/auth/login',{data:{username:'cvatadmin',password:creds.password},headers:{Accept:'application/vnd.cvat+json'}});assert.ok(login.ok(),'login');
const csrf=(await ctx.cookies()).find(c=>c.name==='csrftoken').value,headers={'X-CSRFToken':csrf,Origin:base,Referer:base+'/',Accept:'application/vnd.cvat+json'};
const before=await(await ctx.request.get(base+`/api/jobs/${tmp.job}/annotations`)).json();const extras=before.shapes.filter(s=>!tmp.before.shapes.some(x=>x.id===s.id));if(extras.length){const r=await ctx.request.patch(base+`/api/jobs/${tmp.job}/annotations?action=delete`,{headers,data:{shapes:extras}});assert.ok(r.ok(),'reset fixture');}
const page=await ctx.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));let calls=0;page.on('request',r=>{if(r.url().includes('/api/lambda/functions/pth-facebookresearch-sam2-video-mask-gpu')&&r.method()==='POST')calls++;});
if(!prod){
 await page.route('**/multi-mask-gpu.js*',r=>r.fulfill({body:fs.readFileSync('/home/xinrun/cvat/components/sam2-video/multi-mask-gpu.js','utf8').replace("const MODEL = 'pth-facebookresearch-sam2-video-mask-gpu'","const MODEL = 'pth-facebookresearch-sam2-video-mask-gpu-stage'"),contentType:'application/javascript'}));
}
await page.addInitScript(()=>window.addEventListener('plugins.ready',()=>window.cvatUI.registerComponent(({core,store})=>{window.__test={core,store};return{name:'limits-observer',destructor(){}}}),{once:true}));
await page.goto(`${base}/tasks/${tmp.task}/jobs/${tmp.job}`,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.__test?.store.getState().annotation.job.instance?.id,undefined,{timeout:90000});
await page.locator('#cvat-multi-mask-gpu-button').click();const d=page.locator('#cvat-multi-mask-gpu-dialog');await d.locator('input[type=checkbox]').first().waitFor();assert.equal(await d.locator('input[type=checkbox]').count(),8);assert.equal(await d.locator('[data-role=frames]').getAttribute('max'),'100');assert.equal(await d.locator('[data-role=frames]').inputValue(),'20');
const checks=d.locator('input[type=checkbox]');for(let i=0;i<8;i++)await checks.nth(i).check();await d.locator('[data-role=run]').click();assert.match(await d.locator('[data-role=status]').innerText(),/1–7/);assert.equal(calls,0,'8 masks must not invoke GPU');
await checks.nth(7).uncheck();await d.locator('[data-role=frames]').fill('101');await d.locator('[data-role=run]').click();assert.match(await d.locator('[data-role=status]').innerText(),/1–100/);assert.equal(calls,0,'101 frames must not invoke GPU');
await d.locator('[data-role=frames]').fill('100');await page.screenshot({path:ROOT+(prod?'/public-dialog.png':'/stage-dialog.png')});const start=Date.now();let message,busyRetries=0;
for(let attempt=0;attempt<240;attempt++){
 await d.locator('[data-role=run]').click();
 await page.waitForFunction(()=>{const d=document.querySelector('#cvat-multi-mask-gpu-dialog');return !d.querySelector('[data-role=run]').disabled&&d.querySelector('[data-role=status]').textContent;},undefined,{timeout:300000});
 message=await d.locator('[data-role=status]').innerText();
 if(message.includes('GPU is busy')){busyRetries++;console.log('Research owns GPU; retrying later');await page.waitForTimeout(2000);continue;}
 break;
}
assert.match(message,/^完成/);assert.equal(calls,102+busyRetries,'init,100 frames,release plus busy attempts');
const staged=await page.evaluate(async()=>{const j=__test.store.getState().annotation.job.instance;return{shapes:(await j.annotations.export()).shapes.map(s=>({id:s.id,frame:s.frame,type:s.type,label:s.label_id,group:s.group})),unsaved:j.annotations.hasUnsavedChanges()};});
assert.equal(staged.shapes.length,708);assert.ok(staged.unsaved);for(let g=1;g<=7;g++)assert.equal(staged.shapes.filter(s=>s.group===g).length,101,'group '+g);assert.equal(staged.shapes.filter(s=>s.group===8).length,1,'unselected mask untouched');
const server=await(await ctx.request.get(base+`/api/jobs/${tmp.job}/annotations`)).json();assert.equal(server.shapes.length,9,'preview not yet persisted');
await d.locator('[data-role=close]').click();await page.getByText('Save',{exact:true}).click();await page.waitForFunction(()=>!__test.store.getState().annotation.job.instance.annotations.hasUnsavedChanges(),undefined,{timeout:60000});
const saved=await(await ctx.request.get(base+`/api/jobs/${tmp.job}/annotations`)).json();assert.equal(saved.shapes.length,708);for(const old of tmp.before.shapes)assert.deepEqual(saved.shapes.find(s=>s.id===old.id),old);
// Cancel after the first request is sent but before it completes; release still required.
await page.route('**/api/lambda/functions/pth-facebookresearch-sam2-video-mask-gpu*',async route=>{await new Promise(resolve=>setTimeout(resolve,800));await route.continue();});
await page.locator('#cvat-multi-mask-gpu-button').click();const cancelDialog=page.locator('#cvat-multi-mask-gpu-dialog');await cancelDialog.locator('input[type=checkbox]').first().waitFor();for(let i=0;i<7;i++)await cancelDialog.locator('input[type=checkbox]').nth(i).check();await cancelDialog.locator('[data-role=frames]').fill('100');await cancelDialog.locator('[data-role=run]').click();await page.waitForTimeout(150);await cancelDialog.locator('[data-role=close]').click();await page.waitForFunction(()=>document.querySelector('#cvat-multi-mask-gpu-dialog [data-role=status]').textContent.startsWith('已取消'),undefined,{timeout:60000});assert.equal(await page.evaluate(()=>__test.store.getState().annotation.job.instance.annotations.hasUnsavedChanges()),false);assert.deepEqual(await(await ctx.request.get(base+`/api/jobs/${tmp.job}/annotations`)).json(),saved);
assert.deepEqual(errors,[]);
const result={passed:true,objects:7,following_frames:100,new_masks:699,protected_existing_masks:1,saved_count:708,default_frames:20,reject_eighth:true,reject_101_frames:true,cancelled_without_writes:true,errors,elapsed_with_save_and_cancel_seconds:(Date.now()-start)/1000};fs.writeFileSync(ROOT+(prod?'/public-browser-result.json':'/stage-browser-result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close();}})().catch(e=>{console.error(e.message);process.exit(1)});
