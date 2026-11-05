const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const code = fs.readFileSync(__dirname + '/mask-video-action.js', 'utf8');

function harness(options = {}) {
    const seed = { id: 7, clientID: 1, frame: 0, type: 'mask', label_id: 2, group: 0, points: [0, 16, 0, 0, 3, 3], attributes: [] };
    const existing = { ...seed, id: 8, clientID: 2, frame: 2, points: [...seed.points] };
    const collection = { shapes: [seed, existing], tags: [], tracks: [] };
    let action, calls = 0, fetches = 0, groups = 0;
    class Job {}
    class BaseCollectionAction {}
    const job = new Job();
    Object.assign(job, { id: 1, taskId: 2,
        frames: { frameNumbers: async () => [0, 1, 2, 3], get: async () => ({ width: 10, height: 10, deleted: false }) },
        annotations: { hasUnsavedChanges: () => !!options.unsaved,
            export: async () => JSON.parse(JSON.stringify(collection)),
            get: async () => [{ clientID: 1 }], group: async () => { groups++; return 9; } } });
    const core = { classes: { Job, BaseCollectionAction },
        actions: { register: (a) => { action = a; }, unregister() {} },
        lambda: { list: async () => ({ models: [{ id: 'pth-facebookresearch-sam2-video-mask' }] }),
            call: async (_task, _model, data) => { calls++; return { states: ['signed'], shapes: [options.disappear && data.states ? null : { type: 'mask', points: [...seed.points] }] }; } } };
    const window = { addEventListener() {}, cvatUI: { registerComponent: (builder) => builder({ core }) } };
    const fetch = async () => ({ ok: true, json: async () => {
        fetches++; const saved = JSON.parse(JSON.stringify(collection));
        if (options.remoteEdit && fetches > 1) saved.shapes[0].points[0] = 1;
        return saved;
    } });
    vm.runInNewContext(code, { window, fetch, console });
    return { action, job, seed, collection, get groups() { return groups; }, get calls() { return calls; } };
}

async function run(h, cancelled = () => false) {
    await h.action.init(h.job, { 'Frames forward': 3 });
    return h.action.run({ collection: { shapes: [h.seed] }, frameData: { number: 0, width: 10, height: 10 }, onProgress() {}, cancelled });
}

test('default is 20 frames, hard maximum 50', async () => {
    const h = harness(); assert.equal(h.action.parameters['Frames forward'].defaultValue, '20');
    await assert.rejects(h.action.init(h.job, { 'Frames forward': 51 }), /1–50/);
});
test('generates masks on unoccupied frames; group identity retained; no seed deletion', async () => {
    const h = harness(); const before = JSON.stringify(h.collection); const out = await run(h);
    assert.deepEqual(Array.from(out.created.shapes, s => s.frame), [1,3]);
    assert.ok(out.created.shapes.every(s => s.type === 'mask' && s.group === 9 && s.id === undefined && s.label_id === 2));
    assert.equal(out.deleted.shapes.length,0); assert.equal(JSON.stringify(h.collection), before);
    await h.action.destroy(); assert.equal(h.calls,5); // init + 3 frames + release
});
test('cancel after init discards output and does not group seed', async () => {
    const h = harness(); let checks = 0; const out = await run(h, () => ++checks > 1);
    assert.equal(out.created.shapes.length,0); assert.equal(h.groups,0);
    await h.action.destroy(); assert.equal(h.calls,2);
});
test('remote edit aborts entire run before grouping', async () => {
    const h = harness({remoteEdit:true}); await assert.rejects(run(h), /Another client changed/);
    assert.equal(h.groups,0); await h.action.destroy();
});
test('unsaved edits rejected', async () => {
    const h = harness({unsaved:true}); await assert.rejects(run(h), /Save your annotations/); assert.equal(h.calls,0);
});
test('lost mask stops without committing or grouping', async () => {
    const h = harness({disappear:true}); await assert.rejects(run(h), /Mask disappeared/);
    assert.equal(h.groups,0); await h.action.destroy();
});
