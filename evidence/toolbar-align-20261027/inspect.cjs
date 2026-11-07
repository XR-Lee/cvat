const {chromium}=require('/home/xinrun/pi-web/node_modules/playwright');const fs=require('fs');
(async()=>{const browser=await chromium.launch({headless:true,executablePath:'/home/xinrun/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',args:['--no-sandbox']});try{
 const context=await browser.newContext({viewport:{width:1600,height:1000}});const base='https://cvat.lxrserver.xyz';const c=Object.fromEntries(fs.readFileSync('/home/xinrun/cvat/.credentials','utf8').trim().split('\n').map(l=>l.split('=')));
 const login=await context.request.post(base+'/api/auth/login',{data:{username:'cvatadmin',password:c.password},headers:{Accept:'application/vnd.cvat+json'}});if(!login.ok())throw Error('Login');
 const before=await(await context.request.get(base+'/api/jobs/1/annotations')).json();fs.writeFileSync(__dirname+'/annotations.before.json',JSON.stringify(before));
 const page=await context.newPage();await page.goto(base+'/tasks/2/jobs/1');await page.locator('#cvat-multi-mask-gpu-button').waitFor({timeout:90000});
 console.log(JSON.stringify(await page.evaluate(()=>[...document.querySelector('.cvat-annotation-header-left-group').children].map(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return {text:e.textContent,class:e.className,rect:r.toJSON(),display:s.display,gap:s.gap,padding:s.padding,border:s.border,font:s.font,html:e.outerHTML.slice(0,1200),children:[...e.children].map(c=>({tag:c.tagName,role:c.getAttribute('role'),class:c.className,rect:c.getBoundingClientRect().toJSON(),font:getComputedStyle(c).font,lineHeight:getComputedStyle(c).lineHeight}))}})),null,2));
 await page.locator('.cvat-annotation-header').screenshot({path:__dirname+'/toolbar-before.png'});
}finally{await browser.close();}})().catch(e=>{console.error(e.message);process.exit(1)});
