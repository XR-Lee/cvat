const { chromium } = require('/home/xinrun/pi-web/node_modules/playwright');
const fs=require('fs');const ROOT=__dirname;
const creds=Object.fromEntries(fs.readFileSync('/home/xinrun/cvat/.credentials','utf8').trim().split('\n').map(l=>l.split('=')));
(async()=>{
const browser=await chromium.launch({headless:true,executablePath:'/home/xinrun/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',args:['--no-sandbox']});
try {
const ctx=await browser.newContext({viewport:{width:1500,height:1000}});const base='http://127.0.0.1:18080';
const r=await ctx.request.post(base+'/api/auth/login',{data:{username:'cvatadmin',password:creds.password},headers:{Accept:'application/vnd.cvat+json'}});if(!r.ok())throw Error('login');
const temp=JSON.parse(fs.readFileSync(ROOT+'/temporary-task.json'));
const csrf=(await ctx.cookies()).find(c=>c.name==='csrftoken').value;
const headers={'X-CSRFToken':csrf,Origin:base,Referer:base+'/',Accept:'application/vnd.cvat+json'};
const current=await (await ctx.request.get(base+`/api/jobs/${temp.job}/annotations`)).json();
const originalIDs=temp.before.shapes.map(s=>s.id);
const extras=current.shapes.filter(s=>!originalIDs.includes(s.id));
if(extras.length){const r=await ctx.request.patch(base+`/api/jobs/${temp.job}/annotations?action=delete`,{headers,data:{shapes:extras}});if(!r.ok())throw Error('reset delete '+r.status());}
const reset=await ctx.request.patch(base+`/api/jobs/${temp.job}/annotations?action=update`,{headers,data:{shapes:temp.before.shapes}});if(!reset.ok())throw Error('reset update');
const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.route('**/mask-video-action.js*',route=>route.fulfill({path:'/home/xinrun/cvat/components/sam2-video/mask-video-action.js',contentType:'application/javascript'}));
await page.route('**/tasks/*/jobs/*',async route=>{if(route.request().resourceType()==='document'){const html=fs.readFileSync(ROOT+'/index-before.html','utf8').replace('</body>','<script defer src="/mask-video-action.js"></script></body>');await route.fulfill({body:html,contentType:'text/html'});}else await route.continue();});
await page.addInitScript(()=>window.addEventListener('plugins.ready',()=>window.cvatUI.registerComponent(({core,store})=>{window.__test={core,store};return {name:'Test observer',destructor(){}}}),{once:true}));
await page.goto(`${base}/tasks/${temp.task}/jobs/${temp.job}`);await page.waitForFunction(()=>window.__test?.store.getState().annotation.job.instance?.id,{timeout:90000});await page.waitForTimeout(2500);
// Cancel after seed initialization. No group changes, generated shapes, or server writes.
const cancelled=await page.evaluate(async()=>{const {core,store}=__test;const job=store.getState().annotation.job.instance;const mask=(await job.annotations.get(0)).find(s=>s.shapeType==='mask');const action=(await core.actions.list()).find(a=>a.name==='SAM2 Mask Video Propagation');const before=JSON.stringify(await job.annotations.export());let n=0;await core.actions.call(job,action,{'Frames forward':'3'},0,[mask],()=>{},()=>++n>1);return {unchanged:before===JSON.stringify(await job.annotations.export()),unsaved:job.annotations.hasUnsavedChanges()};});
if(!cancelled.unchanged||cancelled.unsaved)throw Error('Cancel mutated annotations');console.log('CANCEL',cancelled);
// Actual UI route through Run annotation action.
await page.locator('.cvat-objects-sidebar-state-item').first().hover();
console.log('OBJECT HTML',(await page.locator('.cvat-objects-sidebar-state-item').first().innerHTML()).slice(-2000));
await page.locator('.cvat-objects-sidebar-state-item').first().locator('[aria-label="more"]').click();
await page.getByText('Run annotation action',{exact:true}).click();
await page.locator('.cvat-action-runner-list .ant-select').click();
await page.locator('.ant-select-item-option-content').filter({hasText:'SAM2 Mask Video Propagation'}).click();
await page.locator('.cvat-action-runner-action-parameter input').fill('3');
await page.locator('.cvat-action-runner-action-parameter input').press('Tab');
await page.screenshot({path:ROOT+'/action-modal.png'});
await page.locator('.cvat-action-runner-run-btn').click();
await page.locator('.cvat-action-runner-content').waitFor({state:'hidden',timeout:120000});
const staged=await page.evaluate(async()=>{const job=__test.store.getState().annotation.job.instance;return {shapes:(await job.annotations.export()).shapes.map(s=>({id:s.id,frame:s.frame,type:s.type,group:s.group})),unsaved:job.annotations.hasUnsavedChanges()};});
if(staged.shapes.length!==4||!staged.unsaved)throw Error('not staged '+JSON.stringify(staged));
const beforeSave=await (await ctx.request.get(base+`/api/jobs/${temp.job}/annotations`)).json();if(beforeSave.shapes.length!==2)throw Error('Action wrote annotations before Save');
await page.getByText('Save',{exact:true}).click();await page.waitForFunction(()=>!__test.store.getState().annotation.job.instance.annotations.hasUnsavedChanges(),{timeout:30000});
const saved=await (await ctx.request.get(base+`/api/jobs/${temp.job}/annotations`)).json();if(saved.shapes.length!==4)throw Error('Save failed');
const preserved=saved.shapes.find(s=>s.id===temp.before.shapes[1].id);if(JSON.stringify(preserved.points)!==JSON.stringify(temp.before.shapes[1].points))throw Error('Existing mask modified');
fs.writeFileSync(ROOT+'/browser-ui-result.json',JSON.stringify({cancelled,staged,saved:saved.shapes.map(s=>({id:s.id,frame:s.frame,type:s.type,group:s.group})),errors},null,2));console.log('UI SUCCESS',staged);
} finally {await browser.close();}
})().catch(e=>{console.error(e.message);process.exit(1)});
