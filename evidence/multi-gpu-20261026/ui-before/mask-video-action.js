/* Custom Community integration. Uses CVAT's public plugin/action APIs. */
(() => {
    'use strict';
    const MODEL_ID = 'pth-facebookresearch-sam2-video-mask';
    const ACTION_NAME = 'SAM2 Mask Video Propagation';
    const empty = () => ({ shapes: [], tags: [], tracks: [] });
    const noChanges = () => ({ created: empty(), deleted: empty() });
    const clone = (value) => JSON.parse(JSON.stringify(value));
    let registered = false;

    function register() {
        if (registered || !window.cvatUI) return;
        registered = true;
        window.cvatUI.registerComponent(({ core }) => {
            class MaskVideoAction extends core.classes.BaseCollectionAction {
                get name() { return ACTION_NAME; }
                get descriptions() {
                    return [{ type: 'info', message: 'Select ONE saved Mask. Genuine SAM2 video memory, CPU. Default: 20 frames (maximum 50). Results are staged in the editor: review, then Save. This is not the rectangle Tracking tool.' },
                        { type: 'warning', message: 'Never overwrites existing annotations. Frames already containing the same label are skipped. Stops if the mask disappears or changes area abruptly. Medical predictions require review. Save pending edits before running. Cancel discards this run.' }];
                }
                get parameters() {
                    return { 'Frames forward': { type: 'number', values: ['1', '50', '1'], defaultValue: '20' } };
                }
                isApplicableForObject(state) { return state.objectType === 'shape' && state.shapeType === 'mask'; }
                applyFilter({ collection, frameData }) {
                    return { shapes: collection.shapes.filter((s) => s.type === 'mask' && s.frame === frameData.number && !s.outside), tags: [], tracks: [] };
                }
                async init(job, parameters) {
                    this.sessionState = null;
                    this.lastFrame = null;
                    if (!(job instanceof core.classes.Job)) throw new Error('Open a video job first');
                    if (job.annotations.hasUnsavedChanges()) throw new Error('Save your annotations before starting mask propagation');
                    this.job = job;
                    this.steps = Number(parameters['Frames forward']);
                    if (!Number.isInteger(this.steps) || this.steps < 1 || this.steps > 50) throw new Error('Choose 1–50 frames');
                    const { models } = await core.lambda.list();
                    this.model = models.find((m) => m.id === MODEL_ID);
                    if (!this.model) throw new Error('SAM2 video service is not available');
                }
                async destroy() {
                    if (this.sessionState && this.job && this.model) {
                        try {
                            await core.lambda.call(this.job.taskId, this.model, { type: 'track', job: this.job.id,
                                frame: this.lastFrame, states: [this.sessionState], shapes: [{ type: 'mask', points: [] }] });
                        } catch (_) { /* Server TTL is the fallback for network failures. */ }
                    }
                    this.sessionState = null; this.job = null; this.model = null;
                }
                async savedAnnotations() {
                    const response = await fetch(`/api/jobs/${this.job.id}/annotations`, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/vnd.cvat+json' } });
                    if (!response.ok) throw new Error(`Cannot check saved annotations (${response.status})`);
                    return response.json();
                }
                async run({ collection, frameData, onProgress, cancelled }) {
                    if (collection.shapes.length !== 1) throw new Error('Select exactly ONE saved Mask via its object menu → Run annotation action');
                    const seed = collection.shapes[0];
                    if (!Number.isInteger(seed.id)) throw new Error('Save the source mask first');
                    const job = this.job;
                    const snapshot = await job.annotations.export();
                    const savedBefore = await this.savedAnnotations();
                    const seedSaved = savedBefore.shapes.find((s) => s.id === seed.id);
                    if (!seedSaved || JSON.stringify(seedSaved.points) !== JSON.stringify(seed.points) || seedSaved.label_id !== seed.label_id) throw new Error('Saved source mask differs from the editor; reload after saving');
                    const frames = (await job.frames.frameNumbers()).filter((n) => n > frameData.number).slice(0, this.steps);
                    if (!frames.length) throw new Error('No following frames in this job');
                    const existing = [...snapshot.shapes, ...savedBefore.shapes];
                    const occupied = new Set(existing.filter((s) => s.label_id === seed.label_id).map((s) => s.frame));
                    const existingTracks = [...snapshot.tracks, ...savedBefore.tracks].filter((t) => t.label_id === seed.label_id);
                    function trackPresent(frame) {
                        return existingTracks.some((track) => {
                            const prior = track.shapes.filter((s) => s.frame <= frame).sort((a, b) => b.frame - a.frame)[0];
                            return prior && !prior.outside;
                        });
                    }
                    if (cancelled()) return noChanges();
                    onProgress('Encoding source Mask into SAM2 temporal memory…', 0);
                    let response = await core.lambda.call(job.taskId, this.model, { type: 'track', job: job.id, frame: frameData.number, shapes: [{ type: 'mask', points: seed.points }] });
                    let state = response.states[0];
                    this.sessionState = state;
                    this.lastFrame = frameData.number;
                    const created = [];
                    let skipped = 0;
                    let previousArea = seed.points.slice(0, -4).reduce((sum, run, i) => sum + (i % 2 ? run : 0), 0);
                    for (let i = 0; i < frames.length; i++) {
                        if (cancelled()) return noChanges();
                        const frame = frames[i];
                        const meta = await job.frames.get(frame);
                        if (meta.deleted) throw new Error('Propagation crosses a deleted frame; choose a shorter range');
                        if (meta.width !== frameData.width || meta.height !== frameData.height) throw new Error('Frame dimensions changed');
                        onProgress(`SAM2 video: frame ${frame} (${i+1}/${frames.length}); skipped ${skipped}`, Math.round(100*i/frames.length));
                        response = await core.lambda.call(job.taskId, this.model, { type: 'track', job: job.id, frame, states: [state] });
                        state = response.states[0];
                        this.sessionState = state;
                        this.lastFrame = frame;
                        const shape = response.shapes[0];
                        if (!shape) throw new Error(`Mask disappeared at frame ${frame}. Nothing committed; retry a shorter range and correct the seed`);
                        if (shape.type !== 'mask') throw new Error('Video tracker returned a non-mask');
                        const points = shape.points;
                        const [x1,y1,x2,y2] = points.slice(-4);
                        const counts = points.slice(0,-4);
                        if (!points.every(Number.isInteger) || counts.some((n) => n < 0) || x1 < 0 || y1 < 0 || x2 >= meta.width || y2 >= meta.height || x2 < x1 || y2 < y1 || counts.reduce((a,b) => a+b,0) !== (x2-x1+1)*(y2-y1+1)) throw new Error('Video tracker returned invalid mask encoding');
                        const area = counts.reduce((sum, run, n) => sum+(n%2 ? run : 0),0);
                        if (!area || area / previousArea > 3 || area / previousArea < 1/3) throw new Error(`Abrupt mask change at frame ${frame}; nothing committed. Review and use a shorter range`);
                        previousArea = area;
                        if (occupied.has(frame) || trackPresent(frame)) { skipped++; continue; }
                        const generated = clone(seed);
                        delete generated.id;
                        delete generated.clientID;
                        generated.frame = frame;
                        generated.points = points;
                        generated.source = 'semi-auto';
                        generated.type = 'mask';
                        generated.rotation = 0;
                        generated.outside = false;
                        generated.elements = [];
                        created.push(generated);
                    }
                    if (cancelled()) return noChanges();
                    if (JSON.stringify(await job.annotations.export()) !== JSON.stringify(snapshot)) throw new Error('Editor annotations changed during propagation; nothing committed');
                    if (JSON.stringify(await this.savedAnnotations()) !== JSON.stringify(savedBefore)) throw new Error('Another client changed saved annotations; nothing committed. Reload and retry');
                    if (!created.length) throw new Error('All target frames already contain this label; no masks added');
                    if (cancelled()) return noChanges();
                    // Per-frame mask IDs are unique. A shared group links this object
                    // across frames. Grouping changes only the seed group, not pixels.
                    let group = seed.group || 0;
                    if (!group) {
                        const states = await job.annotations.get(frameData.number);
                        const seedState = states.find((s) => s.clientID === seed.clientID);
                        if (!seedState) throw new Error('Source Mask disappeared from the editor');
                        group = await job.annotations.group([seedState], false);
                    }
                    created.forEach((shape) => { shape.group = group; });
                    onProgress(`${created.length} masks staged; ${skipped} existing-label frames skipped. Review then Save.`, 100);
                    return { created: { shapes: created, tags: [], tracks: [] }, deleted: empty() };
                }
            }
            const action = new MaskVideoAction();
            core.actions.register(action);
            return { name: ACTION_NAME, destructor: () => core.actions.unregister(action) };
        });
    }
    window.addEventListener('plugins.ready', register, { once: true });
    register();
})();
