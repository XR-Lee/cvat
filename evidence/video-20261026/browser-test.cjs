const { chromium } = require('/home/xinrun/pi-web/node_modules/playwright');
const fs = require('fs');
const ROOT = __dirname;
const c = Object.fromEntries(fs.readFileSync('/home/xinrun/cvat/.credentials','utf8').trim().split('\n').map(l=>l.split('=')));
(async()=>{
 const browser = await chromium.launch({headless:true,executablePath:'/home/xinrun/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',args:['--no-sandbox']});
 const context = await browser.newContext({viewport:{width:1500,height:1000}});
 const api='http://127.0.0.1:18080';
 const login=await context.request.post(api+'/api/auth/login',{data:{username:'cvatadmin',password:c.password},headers:{Accept:'application/vnd.cvat+json'}});
 if(!login.ok())throw Error('login '+login.status());
 const page=await context.newPage();
 const errors=[];page.on('pageerror',e=>{errors.push(e.message);console.log('PAGEERROR',e.message)});
 // Serve only the staged UI HTML/plugin; API and released assets stay same-origin.
 await page.route('**/mask-video-action.js*',async route=>route.fulfill({path:'/home/xinrun/cvat/components/sam2-video/mask-video-action.js',contentType:'application/javascript'}));
 await page.route('**/tasks/*/jobs/*',async route=>{
  if(route.request().resourceType()==='document'){
   const html=await context.request.get('http://127.0.0.1:18081/index.html'); await route.fulfill({body:await html.text(),contentType:'text/html'});
  } else await route.continue();
 });
 await page.addInitScript(()=>window.addEventListener('plugins.ready',()=>{
  window.cvatUI.registerComponent(({core,store})=>{window.__test={core,store};return {name:'Test observer',destructor(){}}});
 },{once:true}));
 const temp=JSON.parse(fs.readFileSync(ROOT+'/temporary-task.json'));
 await page.goto(`${api}/tasks/${temp.task}/jobs/${temp.job}`,{waitUntil:'domcontentloaded'});
 await page.waitForFunction(()=>window.__test?.store.getState().annotation.job.instance?.id,{timeout:90000});
 await page.waitForTimeout(4000);
 console.log('BODY',(await page.innerText('body')).slice(0,1800));
 console.log('ACTIONS',await page.evaluate(async()=> (await __test.core.actions.list()).map(a=>a.name)));
 const result=await page.evaluate(async()=>{
  const {core,store}=__test; const job=store.getState().annotation.job.instance;
  const states=await job.annotations.get(0); const mask=states.find(s=>s.shapeType==='mask');
  const action=(await core.actions.list()).find(a=>a.name==='SAM2 Mask Video Propagation');
  if(!mask||!action)throw Error('missing seed/action');
  const progress=[];
  await core.actions.call(job,action,{'Frames forward':'3'},0,[mask],(message,percent)=>progress.push({message,percent}),()=>false);
  const staged=await job.annotations.export();
  if(staged.shapes.length!==4)throw Error('expected two generated masks, got '+staged.shapes.length);
  const source=staged.shapes.find(s=>s.frame===0);
  const added=staged.shapes.filter(s=>s.frame===1||s.frame===3);
  if(!source.group||added.some(s=>s.group!==source.group))throw Error('group not shared');
  if(staged.shapes.filter(s=>s.frame===2).length!==1)throw Error('existing frame duplicated');
  await job.annotations.save();
  return {progress,shapes:staged.shapes.map(s=>({id:s.id,frame:s.frame,type:s.type,group:s.group})),saved:true};
 });
 console.log('RESULT',JSON.stringify(result));
 fs.writeFileSync(ROOT+'/browser-result.json',JSON.stringify({result,errors},null,2));
 await page.screenshot({path:ROOT+'/browser-stage.png',fullPage:false});
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
