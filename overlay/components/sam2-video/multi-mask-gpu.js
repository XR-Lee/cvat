/* CVAT Community plugin: explicit multi-object selection + CUDA video action. */
(() => {
    'use strict';
    // Default stays SAM2.1 Large. MedSAM2 is an explicitly selected experiment:
    // its weights are licensed for research/education only and it did not
    // outperform SAM2.1 on this deployment's endoscopic A/B review.
    const MODELS = {
        'SAM2.1 Large': { id: 'pth-facebookresearch-sam2-video-mask-gpu', label: 'SAM2.1 Large（默认）' },
        MedSAM2: { id: 'pth-medsam2-video-mask-gpu', label: 'MedSAM2（实验；权重仅限研究/教学）' },
    };
    const DEFAULT_MODEL = 'SAM2.1 Large';
    const MODEL_STORAGE = 'cvat-multi-mask-gpu-model';
    const NAME = 'SAM2 Multi-Mask Video Propagation - GPU';
    const MAX_OBJECTS = 7;
    const MAX_FRAMES = 100;
    const empty = () => ({ shapes: [], tags: [], tracks: [] });
    const unchanged = () => ({ created: empty(), deleted: empty() });
    const clone = (x) => JSON.parse(JSON.stringify(x));
    const area = (p) => p.slice(0,-4).reduce((sum,n,i) => sum+(i%2?n:0),0);
    function validateMask(shape,width,height) {
        if (!shape || shape.type !== 'mask' || !Array.isArray(shape.points) || shape.points.length < 6) throw Error('Invalid mask response');
        const p=shape.points, [x1,y1,x2,y2]=p.slice(-4), runs=p.slice(0,-4);
        if (!p.every(Number.isInteger) || runs.some(n=>n<0) || x1<0 || y1<0 || x2>=width || y2>=height || x2<x1 || y2<y1 || runs.reduce((a,b)=>a+b,0)!==(x2-x1+1)*(y2-y1+1)) throw Error('Invalid mask encoding');
        return area(p);
    }
    function intersects(a,b) {
        const [x1,y1,x2,y2]=a.slice(-4), [u1,v1,u2,v2]=b.slice(-4);
        return x1<=u2 && u1<=x2 && y1<=v2 && v1<=y2;
    }
    let installed=false;
    function register() {
        if(installed||!window.cvatUI)return;
        installed=true;
        window.cvatUI.registerComponent(({core,store,dispatch,actionCreators})=>{
            let busy=false;
            class MultiMaskAction extends core.classes.BaseCollectionAction {
                get name(){return NAME;}
                get descriptions(){return [
                    {type:'info',message:`GPU: select 1–${MAX_OBJECTS} saved Masks from the SAME frame. Each object keeps its own label and Group, including objects with the same label. Default 20 frames; maximum ${MAX_FRAMES}. Review then Save.`},
                    {type:'warning',message:'GPU busy errors mean another research job owns the card; retry later. Existing same-Group annotations are preserved. Ungrouped overlapping same-label masks are conservatively skipped. Missing/unstable objects stop individually; review all results.'}
                ];}
                get parameters(){return {
                    'Frames forward':{type:'number',values:['1',String(MAX_FRAMES),'1'],defaultValue:'20'},
                    Model:{type:'select',values:Object.keys(MODELS),defaultValue:DEFAULT_MODEL},
                };}
                isApplicableForObject(s){return s.objectType==='shape'&&s.shapeType==='mask';}
                applyFilter({collection,frameData}){return {shapes:collection.shapes.filter(s=>s.type==='mask'&&s.frame===frameData.number&&!s.outside),tags:[],tracks:[]};}
                async init(job,params){
                    if(busy)throw Error('A mask propagation is already running');
                    this.acquired=false;this.states=null;
                    if(!(job instanceof core.classes.Job))throw Error('Open a video job');
                    if(job.annotations.hasUnsavedChanges())throw Error('Save your pending annotations first');
                    this.steps=Number(params['Frames forward']);
                    if(!Number.isInteger(this.steps)||this.steps<1||this.steps>MAX_FRAMES)throw Error(`Choose 1–${MAX_FRAMES} frames`);
                    const requested=params.Model??DEFAULT_MODEL;
                    this.modelName=Object.hasOwn(MODELS,requested)?requested:null;
                    if(!this.modelName)throw Error('Unknown model selection');
                    const {models}=await core.lambda.list();this.model=models.find(m=>m.id===MODELS[this.modelName].id);
                    if(!this.model)throw Error(`${this.modelName} GPU service is not available`);
                    this.job=job;busy=true;this.acquired=true;this.warnings=[];
                }
                async invoke(body){
                    const r=await core.lambda.call(this.job.taskId,this.model,{type:'track',job:this.job.id,...body});
                    if(r.error)throw Error(r.error);
                    if(r.device!=='cuda')throw Error('GPU service did not confirm CUDA; refusing CPU fallback');
                    return r;
                }
                async destroy(){
                    if(this.states&&this.job){try{await this.invoke({frame:this.lastFrame,states:this.states,shapes:this.states.map(()=>({type:'mask',points:[]}))});}catch(_){/* 90s expiry is fallback */}}
                    this.states=null;if(this.acquired)busy=false;this.acquired=false;this.job=null;
                }
                async saved(){
                    const r=await fetch(`/api/jobs/${this.job.id}/annotations`,{credentials:'same-origin',cache:'no-store',headers:{Accept:'application/vnd.cvat+json'}});
                    if(!r.ok)throw Error('Could not check saved annotations');return r.json();
                }
                async run({collection,frameData,onProgress,cancelled}){
                    const seeds=collection.shapes;
                    if(seeds.length<1||seeds.length>MAX_OBJECTS)throw Error(`Select 1–${MAX_OBJECTS} saved Masks from one frame`);
                    if(seeds.some(s=>!Number.isInteger(s.id)||s.frame!==frameData.number))throw Error('Save all selected Masks first, on the same frame');
                    const nonzero=seeds.filter(s=>s.group).map(s=>s.group);
                    if(new Set(nonzero).size!==nonzero.length)throw Error('Selected objects share a Group. Give different objects separate Groups before tracking');
                    const snapshot=await this.job.annotations.export(),saved=await this.saved();
                    for(const seed of seeds){
                        const s=saved.shapes.find(x=>x.id===seed.id);
                        if(!s||s.frame!==seed.frame||s.label_id!==seed.label_id||s.group!==seed.group||JSON.stringify(s.points)!==JSON.stringify(seed.points)||JSON.stringify(s.attributes)!==JSON.stringify(seed.attributes))throw Error('Saved Masks differ from the editor. Reload after saving');
                    }
                    const frameNumbers=(await this.job.frames.frameNumbers()).filter(f=>f>frameData.number).slice(0,this.steps);
                    if(!frameNumbers.length)throw Error('No following frames');
                    const existing=[...snapshot.shapes,...saved.shapes];
                    const tracks=[...snapshot.tracks,...saved.tracks];
                    function protectedAt(seed,predicted,frame){
                        if(seed.group&&existing.some(s=>s.frame===frame&&s.group===seed.group))return true;
                        if(seed.group&&tracks.some(t=>{
                            if(t.group!==seed.group)return false;
                            const prior=t.shapes.filter(s=>s.frame<=frame).sort((a,b)=>b.frame-a.frame)[0];
                            return prior&&!prior.outside;
                        }))return true;
                        // Different known groups are distinct objects even with the same label.
                        // Unknown same-label masks are protected only at overlapping locations.
                        return existing.some(s=>s.frame===frame&&!s.group&&s.type==='mask'&&s.label_id===seed.label_id&&intersects(s.points,predicted.points));
                    }
                    if(cancelled())return unchanged();
                    onProgress(`GPU: initializing ${seeds.length} objects…`,0);
                    // `frames` tells MedSAM2 the official clip length (ignored by SAM2.1).
                    let response=await this.invoke({frame:frameData.number,shapes:seeds.map(s=>({type:'mask',points:s.points,frames:frameNumbers.length}))});
                    this.states=response.states;this.lastFrame=frameData.number;
                    if(this.states.length!==seeds.length)throw Error('GPU object count mismatch');
                    const output=seeds.map(()=>[]),active=seeds.map(()=>true),previous=seeds.map(s=>area(s.points));let skipped=0;
                    for(let f=0;f<frameNumbers.length;f++){
                        if(cancelled())return unchanged();
                        const frame=frameNumbers[f],meta=await this.job.frames.get(frame);
                        if(meta.deleted||meta.width!==frameData.width||meta.height!==frameData.height)throw Error('Deleted/resized frame in range; use a shorter range');
                        onProgress(`GPU: frame ${frame}, ${seeds.length} objects (${f+1}/${frameNumbers.length})`,Math.round(100*f/frameNumbers.length));
                        response=await this.invoke({frame,states:this.states});this.states=response.states;this.lastFrame=frame;
                        if(response.shapes.length!==seeds.length||this.states.length!==seeds.length)throw Error('GPU object count changed');
                        for(let i=0;i<seeds.length;i++){
                            if(!active[i])continue;
                            const sh=response.shapes[i];const size=sh?validateMask(sh,meta.width,meta.height):0;
                            if(!size||size/previous[i]>3||size/previous[i]<1/3){active[i]=false;this.warnings.push(`Object #${seeds[i].id} stopped at frame ${frame}: missing/unstable Mask`);continue;}
                            previous[i]=size;
                            if(protectedAt(seeds[i],sh,frame)){skipped++;continue;}
                            const generated=clone(seeds[i]);delete generated.id;delete generated.clientID;
                            Object.assign(generated,{frame,points:sh.points,type:'mask',source:'semi-auto',rotation:0,outside:false,elements:[]});
                            output[i].push(generated);
                        }
                        if(!active.some(Boolean))break;
                    }
                    if(cancelled())return unchanged();
                    if(JSON.stringify(await this.job.annotations.export())!==JSON.stringify(snapshot)||JSON.stringify(await this.saved())!==JSON.stringify(saved))throw Error('Annotations changed while tracking; no results committed. Reload and retry');
                    if(!output.some(x=>x.length))throw Error('No new Masks: existing objects protected or all objects lost');
                    if(cancelled())return unchanged();
                    const states=await this.job.annotations.get(frameData.number);
                    for(let i=0;i<seeds.length;i++){
                        if(!output[i].length)continue;
                        let group=seeds[i].group;
                        if(!group){const source=states.find(s=>s.clientID===seeds[i].clientID);if(!source)throw Error('Source disappeared');group=await this.job.annotations.group([source],false);}
                        output[i].forEach(s=>s.group=group);
                    }
                    const created=output.flat();
                    onProgress(`${this.modelName}: ${created.length} Masks staged; ${skipped} protected. ${this.warnings.join('; ')} Review then Save.`,100);
                    return {created:{shapes:created,tags:[],tracks:[]},deleted:empty()};
                }
            }
            const action=new MultiMaskAction();core.actions.register(action);
            let button=null,dialog=null;
            function renderButton(){
                const state=store.getState(),job=state.annotation?.job?.instance;
                const host=document.querySelector('.cvat-annotation-header-left-group');
                if(!host||!job){if(button){button.remove();button=null;}return;}
                if(!button||!button.isConnected){
                    button=document.createElement('button');button.type='button';button.id='cvat-multi-mask-gpu-button';
                    // Match CVAT's icon-above-caption toolbar layout. Reuse the
                    // active Ant Design scope instead of hard-coding its build hash.
                    const nativeButton=host.querySelector('.cvat-annotation-header-save-button');
                    const scope=[...(nativeButton?.classList||[])].filter(name=>name.startsWith('css-'));
                    button.className=['ant-btn',...scope,'ant-btn-link','cvat-annotation-header-button','cvat-multi-mask-toolbar-button'].join(' ');
                    button.setAttribute('aria-label','多 Mask 跟踪 · GPU');
                    button.setAttribute('aria-haspopup','dialog');
                    button.setAttribute('aria-controls','cvat-multi-mask-gpu-dialog');
                    button.title=`多 Mask 跟踪 · GPU：选择 1–${MAX_OBJECTS} 个已保存 Mask，最多向后 ${MAX_FRAMES} 帧`;
                    button.style.cssText='width:72px;flex:0 0 72px;color:#0958d9;border:1px solid transparent;border-radius:4px;background:transparent;white-space:nowrap';
                    button.innerHTML='<span role="img" aria-hidden="true" class="anticon"><svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" xmlns="http://www.w3.org/2000/svg"><g stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"><path d="m3 7 8-4 8 4-8 4-8-4Z"/><path d="m3 11 8 4 4-2M3 15l8 4 3-1.5"/><path d="m18 13 4 3-4 3v-6Z"/></g></svg></span><span>Mask · GPU</span>';
                    button.addEventListener('click',openDialog);
                    // Keep Enter/Space on this focused control out of canvas shortcuts.
                    button.addEventListener('keydown',event=>{
                        if(event.key==='Enter'||event.key===' '){event.preventDefault();event.stopPropagation();if(!button.disabled)button.click();}
                    });
                    host.appendChild(button);
                }
                button.disabled=busy;
                button.style.opacity=busy?'0.5':'1';
            }
            async function openDialog(){
                if(dialog)return;
                const state=store.getState(),job=state.annotation.job.instance,frame=state.annotation.player.frame.number;
                dialog=document.createElement('dialog');dialog.id='cvat-multi-mask-gpu-dialog';dialog.style.cssText='width:580px;max-width:90vw;border:1px solid #91caff;border-radius:10px;padding:24px;box-shadow:0 10px 40px #0005';
                dialog.innerHTML=`<h2 style="margin-top:0">多 Mask 视频跟踪 · GPU</h2><p>勾选当前帧的 1–${MAX_OBJECTS} 个已保存 Mask；支持不同类别及同类别的不同对象。</p><div data-role="objects" style="max-height:240px;overflow:auto"></div><p><label>模型 <select data-role="model">${Object.entries(MODELS).map(([value,{label}])=>`<option value="${value}">${label}</option>`).join('')}</select></label></p><p data-role="model-note" style="font-size:12px;color:#ad4e00;margin:4px 0"></p><p><label>向后帧数 <input data-role="frames" type="number" min="1" max="${MAX_FRAMES}" value="20" style="width:70px"></label></p><p>最多 ${MAX_FRAMES} 帧；长片段更容易漂移，请检查后再 Save。不会覆盖已有对象。GPU 被其他任务占用时会提示稍后重试。</p><progress data-role="progress" max="100" value="0" style="width:100%"></progress><p data-role="status" role="status" style="white-space:pre-wrap"></p><div style="display:flex;justify-content:flex-end;gap:12px"><button data-role="close">关闭</button><button data-role="run">开始 GPU 跟踪</button></div>`;
                const groupHelp=document.createElement('p');
                groupHelp.id='cvat-multi-mask-group-help';
                groupHelp.style.cssText='font-size:12px;line-height:1.5;color:#595959;margin:8px 0';
                groupHelp.textContent='Group（对象组）用于关联同一对象在不同帧上的 Mask，不是类别。同一类别的不同对象应使用不同组；未分组的 Mask 会各自自动分组。不要把不同对象合并成同一组。';
                dialog.querySelector('[data-role="objects"]').before(groupHelp);
                document.body.appendChild(dialog);dialog.showModal();
                const currentDialog=dialog,status=dialog.querySelector('[data-role="status"]'),list=dialog.querySelector('[data-role="objects"]');
                const run=dialog.querySelector('[data-role="run"]'),close=dialog.querySelector('[data-role="close"]'),input=dialog.querySelector('[data-role="frames"]');
                const modelSelect=dialog.querySelector('[data-role="model"]'),modelNote=dialog.querySelector('[data-role="model-note"]');
                let remembered=null;try{remembered=localStorage.getItem(MODEL_STORAGE);}catch(_){/* storage unavailable */}
                modelSelect.value=Object.hasOwn(MODELS,remembered)?remembered:DEFAULT_MODEL;
                function describeModel(){
                    modelNote.textContent=modelSelect.value==='MedSAM2'?
                        'MedSAM2：SAM2.1 Tiny + 512 输入，用 CT/MRI/超声/息肉内镜数据微调，未包含脊柱内镜。在本任务对比中未优于 SAM2.1（抓钳会截断、少数对象漂移/丢失）。权重仅限研究和教学用途。':'';
                }
                modelSelect.onchange=()=>{try{localStorage.setItem(MODEL_STORAGE,modelSelect.value);}catch(_){/* ignore */}describeModel();};describeModel();
                let running=false,cancel=false;
                function requestClose(){if(running){cancel=true;status.textContent='正在取消：等待当前帧请求结束，本轮结果不会提交。';close.disabled=true;}else{currentDialog.close();currentDialog.remove();dialog=null;}}
                close.onclick=requestClose;dialog.addEventListener('cancel',e=>{e.preventDefault();requestClose();});
                try{
                    const states=(await job.annotations.get(frame)).filter(s=>s.objectType==='shape'&&s.shapeType==='mask'&&!s.outside&&!s.hidden);
                    if(!states.length){status.textContent='当前帧没有可跟踪的 Mask。请先标注并保存。';run.disabled=true;return;}
                    states.forEach((s,i)=>{const label=document.createElement('label');label.style.cssText='display:block;padding:8px;border-bottom:1px solid #ddd';const check=document.createElement('input');check.type='checkbox';check.value=String(i);check.checked=states.length<=MAX_OBJECTS;label.append(check,document.createTextNode(` #${s.serverID??s.clientID} · ${s.label.name} · ${s.group?.id?`对象组 ${s.group.id}`:'未分组（运行后自动分组）'}`));list.appendChild(label);});
                    run.onclick=async()=>{
                        const selected=[...list.querySelectorAll('input:checked')].map(c=>states[Number(c.value)]);
                        const steps=Number(input.value);
                        if(!selected.length||selected.length>MAX_OBJECTS||!Number.isInteger(steps)||steps<1||steps>MAX_FRAMES){status.textContent=`请选择 1–${MAX_OBJECTS} 个 Mask，帧数 1–${MAX_FRAMES}。`;return;}
                        if(job.annotations.hasUnsavedChanges()){status.textContent='请先关闭窗口并 Save，再运行。';return;}
                        if(store.getState().annotation.player.frame.number!==frame){status.textContent='当前帧已变化，请关闭并重新打开。';return;}
                        const modelName=modelSelect.value;
                        running=true;cancel=false;run.disabled=true;input.disabled=true;modelSelect.disabled=true;list.querySelectorAll('input').forEach(c=>c.disabled=true);close.textContent='取消';
                        const execution=new MultiMaskAction();
                        try{
                            await core.actions.call(job,execution,{'Frames forward':String(steps),Model:modelName},frame,selected,(message,percent)=>{status.textContent=message;currentDialog.querySelector('progress').value=percent;},()=>cancel);
                            if(cancel){status.textContent='已取消，本轮未新增 Mask。';}else{
                                await dispatch(actionCreators.changeFrameAsync(frame,false,undefined,true));
                                status.textContent=`完成（${modelName}），结果已放入编辑器，请逐帧检查后 Save。\n${execution.warnings.join('\n')}`;
                            }
                        }catch(e){status.textContent=e.message||String(e);}
                        finally{running=false;close.disabled=false;close.textContent='关闭';input.disabled=false;modelSelect.disabled=false;run.disabled=false;list.querySelectorAll('input').forEach(c=>c.disabled=false);renderButton();}
                    };
                }catch(e){status.textContent=e.message;run.disabled=true;}
            }
            const unsubscribe=store.subscribe(renderButton);const timer=setInterval(renderButton,1000);renderButton();
            return {name:NAME,destructor:()=>{unsubscribe();clearInterval(timer);button?.remove();dialog?.remove();core.actions.unregister(action);}};
        });
    }
    window.addEventListener('plugins.ready',register,{once:true});register();
})();
