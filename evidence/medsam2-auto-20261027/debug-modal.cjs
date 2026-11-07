const {chromium}=require('/home/xinrun/pi-web/node_modules/playwright');const fs=require('fs');
const base='https://cvat.lxrserver.xyz';const c=Object.fromEntries(fs.readFileSync('/home/xinrun/cvat/.credentials','utf8').trim().split('\n').map(l=>l.split('=')));
(async()=>{const b=await chromium.launch({headless:true,executablePath:'/home/xinrun/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',args:['--no-sandbox']});try{
 const ctx=await b.newContext({viewport:{width:1600,height:1000}});await ctx.request.post(base+'/api/auth/login',{data:{username:'cvatadmin',password:c.password},headers:{Accept:'application/vnd.cvat+json'}});
 const p=await ctx.newPage();await p.goto(base+'/tasks/2');await p.getByText('Actions',{exact:true}).first().click();await p.getByText('Automatic annotation',{exact:true}).first().click();
 await p.waitForTimeout(1500);
 const sel=p.locator('.ant-modal .cvat-run-model-content .ant-select');console.log('selects',await sel.count());
 await sel.first().click();await p.waitForTimeout(1000);
 console.log(await p.evaluate(()=>[...document.querySelectorAll('.ant-select-dropdown')].map(d=>({hidden:d.classList.contains('ant-select-dropdown-hidden'),style:d.getAttribute('style'),text:d.innerText.slice(0,300)}))));
 await p.screenshot({path:__dirname+'/debug-modal.png'});
}finally{await b.close();}})();
