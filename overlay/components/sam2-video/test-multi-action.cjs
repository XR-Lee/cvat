const assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),test=require('node:test');
const code=fs.readFileSync(__dirname+'/multi-mask-gpu.js','utf8');
function harness(options={}){
 let action,calls=0,groupNext=10,groups=0,fetches=0;const requests=[];
 const a={id:1,clientID:1,frame:0,type:'mask',label_id:5,group:2,points:[0,16,0,0,3,3],attributes:[]};
 const b={id:2,clientID:2,frame:0,type:'mask',label_id:5,group:3,points:[0,16,5,5,8,8],attributes:[]};
 const existing={...a,id:3,clientID:3,frame:1};
 const seeds=options.count?Array.from({length:options.count},(_,i)=>({...a,id:i+1,clientID:i+1,group:i+1})): [a,b];
 const col={shapes:options.count?[...seeds]:[a,b,existing],tracks:[],tags:[]};
 class Job{};class BaseCollectionAction{};
 const job=new Job();Object.assign(job,{id:1,taskId:2,frames:{frameNumbers:async()=>Array.from({length:(options.frames??2)+1},(_,i)=>i),get:async()=>({width:10,height:10})},annotations:{hasUnsavedChanges:()=>!!options.unsaved,export:async()=>structuredClone(col),get:async()=>[{clientID:1},{clientID:2}],group:async()=>{groups++;return groupNext++;}}});
 const core={classes:{Job,BaseCollectionAction},actions:{register:a=>action=a,unregister(){}},lambda:{list:async()=>({models:[{id:'pth-facebookresearch-sam2-video-mask-gpu'},...(options.noMed?[]:[{id:'pth-medsam2-video-mask-gpu'}])]}),call:async(_t,m,d)=>{calls++;requests.push({model:m.id,body:structuredClone(d)});if(options.busy)return {error:'GPU is busy',device:'cuda'};return {device:'cuda',states:seeds.map((_,i)=>`s${i}`),shapes:seeds.map((s,i)=>options.lost&&d.states&&i===0?null:s)};}}};
 const store={getState:()=>({}),subscribe:()=>()=>{}};
 const window={addEventListener(){},cvatUI:{registerComponent:f=>f({core,store})}};
 const fetch=async()=>({ok:true,json:async()=>{fetches++;const d=structuredClone(col);if(options.remoteEdit&&fetches>1)d.shapes[0].group=9;return d;}});
 vm.runInNewContext(code,{window,fetch,console,document:{querySelector:()=>null},setInterval:()=>1,clearInterval(){}});
 return {action,job,seeds,col,requests,get calls(){return calls;},get groups(){return groups;}};
}
async function run(h,cancelled=()=>false){await h.action.init(h.job,{'Frames forward':h.frames??2,...(h.model?{Model:h.model}:{})});return h.action.run({collection:{shapes:h.seeds},frameData:{number:0,width:10,height:10},onProgress(){},cancelled});}
test('same-label distinct groups track separately; grouped correction protects only its object',async()=>{const h=harness(),out=await run(h);assert.deepEqual(Array.from(out.created.shapes,s=>[s.frame,s.group,s.label_id]),[[2,2,5],[1,3,5],[2,3,5]]);assert.equal(out.deleted.shapes.length,0);await h.action.destroy();assert.equal(h.calls,4);});
test('one lost object does not drop the other',async()=>{const h=harness({lost:true}),out=await run(h);assert.equal(out.created.shapes.length,2);assert.ok(out.created.shapes.every(s=>s.group===3));assert.equal(h.action.warnings.length,1);await h.action.destroy();});
test('busy GPU has explicit error and no groups',async()=>{const h=harness({busy:true});await assert.rejects(run(h),/GPU is busy/);assert.equal(h.groups,0);await h.action.destroy();});
test('cancel does not commit',async()=>{const h=harness();let n=0;const out=await run(h,()=>++n>1);assert.equal(out.created.shapes.length,0);assert.equal(h.groups,0);await h.action.destroy();});
test('concurrent saved edit aborts',async()=>{const h=harness({remoteEdit:true});await assert.rejects(run(h),/Annotations changed/);assert.equal(h.groups,0);await h.action.destroy();});
test('duplicate group rejected',async()=>{const h=harness();h.seeds[1].group=h.seeds[0].group;await assert.rejects(run(h),/share a Group/);assert.equal(h.calls,0);await h.action.destroy();});
test('unsaved seeds blocked',async()=>{const h=harness({unsaved:true});await assert.rejects(run(h),/Save your pending/);assert.equal(h.calls,0);});
test('seven masks and 100 following frames yields 700 independent masks',async()=>{
 const h=harness({count:7,frames:100});h.frames=100;
 assert.equal(h.action.parameters['Frames forward'].defaultValue,'20');
 assert.equal(h.action.parameters['Frames forward'].values[1],'100');
 const out=await run(h);assert.equal(out.created.shapes.length,700);
 for(let group=1;group<=7;group++)assert.equal(out.created.shapes.filter(s=>s.group===group).length,100);
 await h.action.destroy();assert.equal(h.calls,102);
});
test('eighth mask rejected without inference',async()=>{const h=harness({count:8});await assert.rejects(run(h),/1–7/);assert.equal(h.calls,0);await h.action.destroy();});
test('default model is SAM2.1 Large; seeds carry planned frame count',async()=>{const h=harness();const out=await run(h);assert.ok(out.created.shapes.length>0);assert.ok(h.requests.every(r=>r.model==='pth-facebookresearch-sam2-video-mask-gpu'));assert.ok(h.requests[0].body.shapes.every(s=>s.frames===2));assert.equal(h.action.parameters.Model.defaultValue,'SAM2.1 Large');await h.action.destroy();});
test('MedSAM2 selection routes every request, including release, to MedSAM2',async()=>{const h=harness();h.model='MedSAM2';await run(h);await h.action.destroy();assert.equal(h.requests.length,4);assert.ok(h.requests.every(r=>r.model==='pth-medsam2-video-mask-gpu'));});
test('unknown model or missing MedSAM2 service rejected before inference',async()=>{const a=harness();a.model='Other';await assert.rejects(run(a),/Unknown model/);assert.equal(a.calls,0);const b=harness({noMed:true});b.model='MedSAM2';await assert.rejects(run(b),/MedSAM2 GPU service is not available/);assert.equal(b.calls,0);});
test('101 frames rejected before inference',async()=>{const h=harness();h.frames=101;await assert.rejects(run(h),/1–100/);assert.equal(h.calls,0);});
test('ungrouped seeds receive separate identities',async()=>{const h=harness();h.seeds.forEach(s=>s.group=0);h.col.shapes.splice(2);const out=await run(h);assert.equal(h.groups,2);assert.deepEqual(Array.from(new Set(out.created.shapes.map(s=>s.group))),[10,11]);await h.action.destroy();});
test('unknown overlapping same-label mask protects only its spatial region',async()=>{const h=harness();h.col.shapes[2].group=0;const out=await run(h);assert.deepEqual(Array.from(out.created.shapes,s=>[s.frame,s.group]),[[2,2],[1,3],[2,3]]);await h.action.destroy();});
