const {chromium}=require('/home/xinrun/pi-web/node_modules/playwright');const fs=require('fs'),assert=require('node:assert/strict');
const ROOT=__dirname,base='https://cvat.lxrserver.xyz',NAME='Grounding DINO + MedSAM2 - Masks (Experimental, Research)';
const c=Object.fromEntries(fs.readFileSync('/home/xinrun/cvat/.credentials','utf8').trim().split('\n').map(l=>l.split('=')));
const tmp=JSON.parse(fs.readFileSync(ROOT+'/temp.json'));
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'/home/xinrun/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',args:['--no-sandbox']});try{
 const ctx=await browser.newContext({viewport:{width:1600,height:1000}});
 assert.ok((await ctx.request.post(base+'/api/auth/login',{data:{username:'cvatadmin',password:c.password},headers:{Accept:'application/vnd.cvat+json'}})).ok());
 const csrf=(await ctx.cookies()).find(x=>x.name==='csrftoken').value,headers={'X-CSRFToken':csrf,Origin:base,Referer:base+'/',Accept:'application/vnd.cvat+json'};
 // Start the browser run from an empty job so only Auto-labeling output is present.
 const cur=await(await ctx.request.get(base+`/api/jobs/${tmp.job}/annotations`)).json();if(cur.shapes.length)assert.ok((await ctx.request.patch(base+`/api/jobs/${tmp.job}/annotations?action=delete`,{headers,data:{shapes:cur.shapes}})).ok());
 const page=await ctx.newPage(),errors=[],task2Writes=[],calls=[];page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{const u=r.url();if(r.method()==='POST'&&/lambda\/functions\//.test(u))calls.push(u.split('/functions/')[1].split('?')[0]);if(['POST','PATCH','PUT','DELETE'].includes(r.method())&&/\/api\/(jobs\/1|tasks\/2)\/annotations|\/api\/lambda\/requests/.test(u))task2Writes.push(r.method()+' '+u);});
 await page.addInitScript(()=>window.addEventListener('plugins.ready',()=>window.cvatUI.registerComponent(({store})=>{window.__store=store;return{name:'obs',destructor(){}}}),{once:true}));
 // 1) Task 2 task page: task-level "Automatic annotation" lists the model (open, read, cancel; no run).
 await page.goto(base+'/tasks/2');await page.getByText('Actions',{exact:true}).first().click();await page.getByText('Automatic annotation',{exact:true}).first().click();
 const modal=page.locator('.ant-modal').filter({has:page.locator('.cvat-run-model-content')});await modal.waitFor();await page.waitForTimeout(1500);
 await modal.locator('.cvat-run-model-content .ant-select').first().click();
 await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content',{hasText:'MedSAM2'}).waitFor({timeout:30000});
 const taskLevel=await page.evaluate(()=>[...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content')].map(e=>e.textContent.trim()));await page.screenshot({path:ROOT+'/task-automatic-annotation.png'});
 assert.ok(taskLevel.includes(NAME),'task-level list: '+taskLevel);await page.keyboard.press('Escape');await modal.locator('.ant-modal-close').click();await modal.waitFor({state:'hidden'});
 // 2) Disposable task annotation page: AI assistance -> Auto-labeling -> MedSAM2 detector -> Annotate.
 await page.goto(`${base}/tasks/${tmp.task}/jobs/${tmp.job}`);await page.locator('.cvat-tools-control').waitFor({timeout:90000});await page.waitForTimeout(1500);
 await page.locator('.cvat-tools-control').click();const pop=page.locator('.cvat-tools-control-popover-content');await pop.waitFor();
 await pop.getByRole('tab',{name:'Auto-labeling'}).click();await page.waitForTimeout(800);await pop.locator('.cvat-run-model-content .ant-select').first().click();
 await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content',{hasText:'MedSAM2'}).waitFor({timeout:30000});
 const jobLevel=await page.evaluate(()=>[...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content')].map(e=>e.textContent.trim()));
 await page.locator('.ant-select-dropdown:visible .ant-select-item-option-content',{hasText:'MedSAM2'}).click();await page.waitForTimeout(500);await page.screenshot({path:ROOT+'/auto-labeling-tab.png'});
 await pop.locator('.cvat-inference-run-button').click();
 for(let i=0;i<180;i++){const n=await page.evaluate(async()=>(await __store.getState().annotation.job.instance.annotations.export()).shapes.length);if(n>0)break;await page.waitForTimeout(1000);}
 await page.waitForTimeout(1000);await page.screenshot({path:ROOT+'/auto-labeling-result.png'});
 const staged=await page.evaluate(async()=>{const j=__store.getState().annotation.job.instance;return (await j.annotations.export()).shapes.map(s=>({frame:s.frame,type:s.type,source:s.source}));});
 console.log('STAGED',JSON.stringify(staged)); assert.ok(staged.length>0&&staged.every(s=>s.type==='mask'&&s.frame===0));
 await page.mouse.click(1440,600);await pop.waitFor({state:'hidden',timeout:15000});
 await page.getByText('Save',{exact:true}).click();await page.waitForFunction(()=>!__store.getState().annotation.job.instance.annotations.hasUnsavedChanges(),undefined,{timeout:60000});
 const saved=await(await ctx.request.get(base+`/api/jobs/${tmp.job}/annotations`)).json();assert.equal(saved.shapes.length,staged.length);
 assert.ok(calls.includes('pth-medsam2-auto'),JSON.stringify(calls));assert.deepEqual(task2Writes,[]);assert.deepEqual(errors,[]);
 const r={passed:true,task_level_models:taskLevel,job_level_models:jobLevel,auto_labeling_masks:staged.length,saved:saved.shapes.length,detector_calls:calls,task2_writes:task2Writes.length,errors};
 fs.writeFileSync(ROOT+'/browser-result.json',JSON.stringify(r,null,2));console.log(JSON.stringify(r));
}finally{await browser.close();}})().catch(e=>{console.error(e.stack);process.exit(1)});
