const assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),test=require('node:test');
const code=fs.readFileSync(__dirname+'/multi-mask-gpu.js','utf8');
function harness(options={}){
 let action,calls=0,groupNext=10,groups=0,fetches=0;
 const a={id:1,clientID:1,frame:0,type:'mask',label_id:5,group:2,points:[0,16,0,0,3,3],attributes:[]};
 const b={id:2,clientID:2,frame:0,type:'mask',label_id:5,group:3,points:[0,16,5,5,8,8],attributes:[]};
 const existing={...a,id:3,clientID:3,frame:1};
 const col={shapes:[a,b,existing],tracks:[],tags:[]};
 class Job{};class BaseCollectionAction{};
 const job=new Job();Object.assign(job,{id:1,taskId:2,frames:{frameNumbers:async()=>[0,1,2],get:async()=>({width:10,height:10})},annotations:{hasUnsavedChanges:()=>!!options.unsaved,export:async()=>structuredClone(col),get:async()=>[{clientID:1},{clientID:2}],group:async()=>{groups++;return groupNext++;}}});
 const core={classes:{Job,BaseCollectionAction},actions:{register:a=>action=a,unregister(){}},lambda:{list:async()=>({models:[{id:'pth-facebookresearch-sam2-video-mask-gpu'}]}),call:async(_t,_m,d)=>{calls++;if(options.busy)return {error:'GPU is busy',device:'cuda'};return {device:'cuda',states:['s1','s2'],shapes:[options.lost&&d.states?null:a,b]};}}};
 const store={getState:()=>({}),subscribe:()=>()=>{}};
 const window={addEventListener(){},cvatUI:{registerComponent:f=>f({core,store})}};
 const fetch=async()=>({ok:true,json:async()=>{fetches++;const d=structuredClone(col);if(options.remoteEdit&&fetches>1)d.shapes[0].group=9;return d;}});
 vm.runInNewContext(code,{window,fetch,console,document:{querySelector:()=>null},setInterval:()=>1,clearInterval(){}});
 return {action,job,seeds:[a,b],col,get calls(){return calls;},get groups(){return groups;}};
}
async function run(h,cancelled=()=>false){await h.action.init(h.job,{'Frames forward':2});return h.action.run({collection:{shapes:h.seeds},frameData:{number:0,width:10,height:10},onProgress(){},cancelled});}
test('same-label distinct groups track separately; grouped correction protects only its object',async()=>{const h=harness(),out=await run(h);assert.deepEqual(Array.from(out.created.shapes,s=>[s.frame,s.group,s.label_id]),[[2,2,5],[1,3,5],[2,3,5]]);assert.equal(out.deleted.shapes.length,0);await h.action.destroy();assert.equal(h.calls,4);});
test('one lost object does not drop the other',async()=>{const h=harness({lost:true}),out=await run(h);assert.equal(out.created.shapes.length,2);assert.ok(out.created.shapes.every(s=>s.group===3));assert.equal(h.action.warnings.length,1);await h.action.destroy();});
test('busy GPU has explicit error and no groups',async()=>{const h=harness({busy:true});await assert.rejects(run(h),/GPU is busy/);assert.equal(h.groups,0);await h.action.destroy();});
test('cancel does not commit',async()=>{const h=harness();let n=0;const out=await run(h,()=>++n>1);assert.equal(out.created.shapes.length,0);assert.equal(h.groups,0);await h.action.destroy();});
test('concurrent saved edit aborts',async()=>{const h=harness({remoteEdit:true});await assert.rejects(run(h),/Annotations changed/);assert.equal(h.groups,0);await h.action.destroy();});
test('duplicate group rejected',async()=>{const h=harness();h.seeds[1].group=h.seeds[0].group;await assert.rejects(run(h),/share a Group/);assert.equal(h.calls,0);await h.action.destroy();});
test('unsaved seeds blocked',async()=>{const h=harness({unsaved:true});await assert.rejects(run(h),/Save your pending/);assert.equal(h.calls,0);});
test('ungrouped seeds receive separate identities',async()=>{const h=harness();h.seeds.forEach(s=>s.group=0);h.col.shapes.splice(2);const out=await run(h);assert.equal(h.groups,2);assert.deepEqual(Array.from(new Set(out.created.shapes.map(s=>s.group))),[10,11]);await h.action.destroy();});
test('unknown overlapping same-label mask protects only its spatial region',async()=>{const h=harness();h.col.shapes[2].group=0;const out=await run(h);assert.deepEqual(Array.from(out.created.shapes,s=>[s.frame,s.group]),[[2,2],[1,3],[2,3]]);await h.action.destroy();});
