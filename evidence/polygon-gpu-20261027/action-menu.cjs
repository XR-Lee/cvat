// Verify the object-menu annotation action is now offered for a polygon object.
const {chromium}=require('/home/xinrun/pi-web/node_modules/playwright');const fs=require('fs'),assert=require('node:assert/strict');
const ROOT=__dirname,base='https://cvat.lxrserver.xyz';
const c=Object.fromEntries(fs.readFileSync('/home/xinrun/cvat/.credentials','utf8').trim().split('\n').map(l=>l.split('=')));
const tmp=JSON.parse(fs.readFileSync(ROOT+'/temp.json'));
(async()=>{const b=await chromium.launch({headless:true,executablePath:'/home/xinrun/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',args:['--no-sandbox']});try{
 const ctx=await b.newContext({viewport:{width:1600,height:1000}});await ctx.request.post(base+'/api/auth/login',{data:{username:'cvatadmin',password:c.password},headers:{Accept:'application/vnd.cvat+json'}});
 const page=await ctx.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`${base}/tasks/${tmp.task}/jobs/${tmp.job}`);await page.locator('.cvat-objects-sidebar-state-item').first().waitFor({timeout:90000});
 const item=page.locator('.cvat-objects-sidebar-state-item').first();
 await item.hover();await item.locator('[aria-label="more"]').click();
 const menu=await page.locator('.ant-dropdown:visible').innerText();
 await page.locator('.ant-dropdown:visible').getByText('Run annotation action',{exact:true}).click();
 await page.locator('.cvat-action-runner-list .ant-select').click();
 const actions=await page.evaluate(()=>[...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content')].map(e=>e.textContent.trim()));
 await page.screenshot({path:ROOT+'/polygon-action-menu.png'});
 const gpu=actions.find(a=>a.includes('Multi-Mask'));
 assert.ok(gpu,'GPU action offered for polygon: '+JSON.stringify(actions));
 // Run it from the action dialog on the current frame.
 await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content',{hasText:'Multi-Mask'}).click();
 const framesInput=page.locator('.cvat-action-runner-action-parameter input').first();await framesInput.fill('2');await framesInput.press('Tab');
 let msg='';for(let i=0;i<120;i++){await page.locator('.cvat-action-runner-run-btn').click();
   await page.waitForFunction(()=>{const b=document.querySelector('.cvat-action-runner-run-btn');return b&&!b.classList.contains('ant-btn-loading');},undefined,{timeout:180000});
   msg=await page.locator('.cvat-action-runner-content').innerText();
   if(/GPU is busy/.test(msg)){await page.waitForTimeout(3000);continue;}break;}
 const staged=await page.evaluate(async()=>{const w=window;const st=w.__store;return null;}).catch(()=>null);
 const ann=await(await ctx.request.get(base+`/api/jobs/${tmp.job}/annotations`)).json();
 assert.deepEqual(errors,[]);
 const r={passed:true,menu_has_run_action:/Run annotation action/.test(menu),actions,msg_excerpt:msg.split('\n').filter(Boolean).slice(0,3).join(' | '),saved_shapes_server:ann.shapes.length,errors};
 fs.writeFileSync(ROOT+'/action-menu-result.json',JSON.stringify(r,null,2));console.log(JSON.stringify(r).slice(0,700));
}finally{await b.close();}})().catch(e=>{console.error(e.stack);process.exit(1)});
