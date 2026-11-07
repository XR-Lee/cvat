const {chromium}=require('/home/xinrun/pi-web/node_modules/playwright');const fs=require('fs'),assert=require('node:assert/strict');
const ROOT=__dirname,base='https://cvat.lxrserver.xyz';
const c=Object.fromEntries(fs.readFileSync('/home/xinrun/cvat/.credentials','utf8').trim().split('\n').map(l=>l.split('=')));
const tmp=JSON.parse(fs.readFileSync(ROOT+'/temp.json'));
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'/home/xinrun/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',args:['--no-sandbox']});try{
 const ctx=await browser.newContext({viewport:{width:1600,height:1000},deviceScaleFactor:1});
 assert.ok((await ctx.request.post(base+'/api/auth/login',{data:{username:'cvatadmin',password:c.password},headers:{Accept:'application/vnd.cvat+json'}})).ok());
 const page=await ctx.newPage(),errors=[],writes=[],calls=[];page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{const u=r.url();if(/lambda\/functions\//.test(u)&&r.method()==='POST')calls.push(u.split('/functions/')[1].split('?')[0]);if(['POST','PATCH','PUT','DELETE'].includes(r.method())&&/\/api\/jobs\/1\/annotations/.test(u))writes.push(u);});
 await page.addInitScript(()=>window.addEventListener('plugins.ready',()=>window.cvatUI.registerComponent(({store})=>{window.__store=store;return{name:'obs',destructor(){}}}),{once:true}));
 // 1) Production Task 2: read-only look at both menus.
 await page.goto(base+'/tasks/2/jobs/1');await page.locator('#cvat-multi-mask-gpu-button').waitFor({timeout:90000});await page.waitForTimeout(800);
 await page.locator('.cvat-tools-control').click();const pop=page.locator('.cvat-tools-control-popover-content');await pop.waitFor();
 await pop.locator('.ant-select').first().click();const opts=await page.locator('.ant-select-dropdown:visible .ant-select-item-option').allInnerTexts();
 await page.waitForTimeout(300);await page.screenshot({path:ROOT+'/prompting-models.png'});assert.ok(opts.some(o=>o.includes('MedSAM2')),'MedSAM2 in Prompting: '+opts);
 await page.keyboard.press('Escape');await page.mouse.move(900,600);await page.waitForTimeout(400);
 await page.locator('#cvat-multi-mask-gpu-button').click();const d=page.locator('#cvat-multi-mask-gpu-dialog');await d.locator('[data-role=model]').waitFor();
 const trackModels=await d.locator('[data-role=model] option').allInnerTexts();await page.screenshot({path:ROOT+'/gpu-dialog-models.png'});await d.locator('[data-role=close]').click();
 assert.ok(trackModels.some(o=>o.includes('MedSAM2')));assert.deepEqual(writes,[]);
 // 2) Disposable task: real canvas click with MedSAM2 Prompting, then Done + Save.
 await page.goto(`${base}/tasks/${tmp.task}/jobs/${tmp.job}`);await page.locator('.cvat-tools-control').waitFor({timeout:90000});await page.waitForTimeout(1500);
 await page.locator('.cvat-tools-control').click();await pop.waitFor();
 await pop.locator('.ant-select').first().click();await page.locator('.ant-select-dropdown:visible .ant-select-item-option',{hasText:'MedSAM2'}).click();
 const sw=pop.locator('.cvat-tools-interactor-setups .ant-switch').last();if(await sw.getAttribute('aria-checked')==='true')await sw.click();
 await pop.locator('.cvat-tools-interact-button').click();
 const box=await page.locator('#cvat_canvas_background').boundingBox();
 await page.mouse.click(box.x+box.width*0.5,box.y+box.height*0.5);
 await page.waitForFunction(()=>document.querySelector('.cvat-annotation-header-done-button')!==null,undefined,{timeout:30000});
 await page.waitForTimeout(1500);await page.screenshot({path:ROOT+'/medsam2-click.png'});
 await page.locator('.cvat-annotation-header-done-button').click();
 await page.waitForFunction(async()=>{const j=__store.getState().annotation.job.instance;return (await j.annotations.export()).shapes.length===1;},undefined,{timeout:30000});
 await page.getByText('Save',{exact:true}).click();await page.waitForFunction(()=>!__store.getState().annotation.job.instance.annotations.hasUnsavedChanges(),undefined,{timeout:30000});
 const saved=await(await ctx.request.get(base+`/api/jobs/${tmp.job}/annotations`)).json();assert.equal(saved.shapes.length,1);assert.equal(saved.shapes[0].type,'mask');
 const medCalls=calls.filter(x=>x==='pth-medsam2-interactor').length;assert.ok(medCalls>=1,'MedSAM2 interactor called: '+calls);
 assert.deepEqual(errors,[]);const r={passed:true,prompting_models:opts,tracking_models:trackModels,task2_writes:writes.length,medsam2_interactor_calls:medCalls,saved_shape:{type:saved.shapes[0].type,source:saved.shapes[0].source},errors};
 fs.writeFileSync(ROOT+'/browser-check.json',JSON.stringify(r,null,2));console.log(JSON.stringify(r));
}finally{await browser.close();}})().catch(e=>{console.error(e.stack);process.exit(1)});
