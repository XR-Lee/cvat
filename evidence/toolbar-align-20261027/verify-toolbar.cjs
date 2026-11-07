const {chromium}=require('/home/xinrun/pi-web/node_modules/playwright');const fs=require('fs'),assert=require('node:assert/strict');
const ROOT=__dirname,live=process.env.LIVE==='1';
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'/home/xinrun/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',args:['--no-sandbox']});try{
 const context=await browser.newContext({viewport:{width:1600,height:1000},deviceScaleFactor:2});const base='https://cvat.lxrserver.xyz';const c=Object.fromEntries(fs.readFileSync('/home/xinrun/cvat/.credentials','utf8').trim().split('\n').map(l=>l.split('=')));
 assert.ok((await context.request.post(base+'/api/auth/login',{data:{username:'cvatadmin',password:c.password},headers:{Accept:'application/vnd.cvat+json'}})).ok());
 const before=await(await context.request.get(base+'/api/jobs/1/annotations')).json();
 const page=await context.newPage();const errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(['POST','PATCH','PUT','DELETE'].includes(r.method()) && /\/api\/(lambda\/functions|jobs\/1\/annotations)/.test(r.url()))writes.push({method:r.method(),url:r.url()});});
 if(!live)await page.route('**/multi-mask-gpu.js*',r=>r.fulfill({path:'/home/xinrun/cvat/components/sam2-video/multi-mask-gpu.js',contentType:'application/javascript'}));
 await page.goto(base+'/tasks/2/jobs/1');await page.locator('#cvat-multi-mask-gpu-button').waitFor({timeout:90000});await page.waitForTimeout(700);
 const metrics=[];
 for(const width of [1600,1280]){
  await page.setViewportSize({width,height:1000});await page.mouse.move(1000,500);await page.waitForTimeout(300);
  const data=await page.evaluate(()=>{
   function measure(selector){const e=document.querySelector(selector),s=getComputedStyle(e);return {rect:e.getBoundingClientRect().toJSON(),icon:e.querySelector('[role=img]').getBoundingClientRect().toJSON(),caption:e.querySelector('span:not([role])').getBoundingClientRect().toJSON(),direction:s.flexDirection,height:s.height,font:s.font,background:s.backgroundColor};}
   return {save:measure('.cvat-annotation-header-save-button'),undo:measure('.cvat-annotation-header-undo-button'),redo:measure('.cvat-annotation-header-redo-button'),mask:measure('#cvat-multi-mask-gpu-button'),player:document.querySelector('.cvat-annotation-header-player-group').getBoundingClientRect().toJSON()};
  });
  for(const key of ['save','undo','redo']){
   assert.ok(Math.abs(data[key].rect.y-data.mask.rect.y)<0.5,'button top alignment');assert.equal(data[key].rect.height,data.mask.rect.height);
   assert.ok(Math.abs(data[key].icon.y-data.mask.icon.y)<0.5,'icon top alignment');assert.ok(Math.abs(data[key].caption.y-data.mask.caption.y)<0.5,'caption baseline alignment');
  }
  assert.ok(data.mask.rect.right<=data.player.left,'no overlap with player');assert.equal(data.mask.direction,'column');metrics.push({width,...data});
  await page.locator('.cvat-annotation-header').screenshot({path:ROOT+`/${live?'live':'stage'}-toolbar-${width}.png`});
 }
 const button=page.getByRole('button',{name:'多 Mask 跟踪 · GPU',exact:true});await button.focus();await page.keyboard.press('Enter');
 const dialog=page.locator('#cvat-multi-mask-gpu-dialog');await dialog.waitFor();await dialog.locator('[data-role=objects] label').first().waitFor();
 assert.match(await dialog.innerText(),/Group（对象组）/);assert.match(await dialog.locator('[data-role=objects]').innerText(),/对象组|未分组/);assert.equal(await dialog.locator('[data-role=frames]').getAttribute('max'),'100');assert.equal(await dialog.locator('[data-role=frames]').inputValue(),'20');
 await page.screenshot({path:ROOT+`/${live?'live':'stage'}-dialog.png`});await page.keyboard.press('Escape');assert.equal(await dialog.count(),0);
 // Button persists in its layout after the modal closes.
 await button.click();await page.locator('#cvat-multi-mask-gpu-dialog [data-role=close]').click();
 const after=await(await context.request.get(base+'/api/jobs/1/annotations')).json();assert.deepEqual(after,before);assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
 const result={passed:true,metrics,keyboard_and_mouse_open:true,group_help:true,annotation_and_group_data_unchanged:true,no_inference_calls:true,errors};fs.writeFileSync(ROOT+`/${live?'live':'stage'}-result.json`,JSON.stringify(result,null,2));console.log(JSON.stringify({passed:true,metrics:metrics.map(m=>({width:m.width,height:m.mask.height,icon_y:m.mask.icon.y,native_icon_y:m.save.icon.y,caption_y:m.mask.caption.y,native_caption_y:m.save.caption.y})),errors,writes}));
}finally{await browser.close();}})().catch(e=>{console.error(e.stack);process.exit(1)});
