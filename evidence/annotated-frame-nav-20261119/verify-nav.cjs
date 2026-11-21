// Verify slider markers + prev/next annotated-frame buttons in the real editor.
const { chromium } = require('/home/xinrun/pi-web/node_modules/playwright');
const fs = require('fs'), assert = require('node:assert/strict');
const base = 'https://cvat.lxrserver.xyz';
const creds = Object.fromEntries(fs.readFileSync('/home/xinrun/cvat/.credentials', 'utf8').trim().split('\n').map((l) => l.split('=')));
(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: '/home/xinrun/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox'] });
    try {
        const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
        assert.ok((await ctx.request.post(base + '/api/auth/login', { data: { username: 'cvatadmin', password: creds.password }, headers: { Accept: 'application/vnd.cvat+json' } })).ok());
        const page = await ctx.newPage();
        const errors = [], writes = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('request', (r) => {
            if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(r.method()) && /\/annotations|\/api\/lambda\//.test(r.url())) writes.push(r.method() + ' ' + r.url());
        });
        // Reference: annotated frames straight from the API.
        const jobs = await (await ctx.request.get(base + '/api/jobs?task_id=2')).json();
        const job = jobs.results.find((j) => j.type === 'annotation');
        const ann = await (await ctx.request.get(base + `/api/jobs/${job.id}/annotations`)).json();
        const expected = [...new Set(ann.shapes.map((s) => s.frame))].sort((a, b) => a - b);

        await page.goto(base + '/tasks/2/jobs/1');
        await page.locator('.cvat-player-buttons').waitFor({ timeout: 90000 });
        await page.waitForFunction(() => document.querySelector('.cvat-annotated-frames-canvas')
            && document.querySelectorAll('.cvat-annotated-frame-nav').length === 2, undefined, { timeout: 30000 });
        await page.waitForTimeout(1500);

        // 1) canvas exists, sized to the slider, and has amber pixels at the right places.
        const canvasInfo = await page.evaluate(() => {
            const canvas = document.querySelector('.cvat-annotated-frames-canvas');
            const slider = document.querySelector('.cvat-player-controls .cvat-player-slider');
            const rect = canvas.getBoundingClientRect();
            const sliderRect = slider.getBoundingClientRect();
            const ctx = canvas.getContext('2d');
            const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            const columns = new Set();
            for (let x = 0; x < canvas.width; x++) {
                for (let y = 0; y < canvas.height; y++) {
                    const i = (y * canvas.width + x) * 4;
                    if (data[i + 3] > 0) { columns.add(x); break; }
                }
            }
            return {
                canvasLeft: rect.left, sliderLeft: sliderRect.left, width: canvas.width, cssWidth: rect.width, sliderWidth: sliderRect.width,
                markedColumns: columns.size, columns: [...columns].sort((a, b) => a - b).slice(0, 5),
            };
        });
        console.log('canvas:', JSON.stringify(canvasInfo));
        assert.ok(Math.abs(canvasInfo.canvasLeft - canvasInfo.sliderLeft) <= 1, 'canvas aligned to slider');
        assert.ok(Math.abs(canvasInfo.cssWidth - canvasInfo.sliderWidth) <= 2, 'canvas width matches slider');
        assert.ok(canvasInfo.markedColumns >= 3, 'markers drawn');

        // 2) Marker positions must match frame positions for the first few frames.
        const total = 13632;
        const width = canvasInfo.cssWidth;
        const mapped = canvasInfo.columns.map((x) => Math.round((x / width) * total));
        console.log('first marked frames by pixel:', mapped, 'api first frames:', expected.slice(0, 5));
        // Every drawn column must correspond to an annotated frame's x position
        // (adjacent frames coalesce into one 2px tick).
        const expectedX = new Set(expected.map((frame) => Math.round((frame / total) * width)));
        for (const column of canvasInfo.columns) {
            const near = [...expectedX].some((x) => Math.abs(x - column) <= 2);
            assert.ok(near, `column ${column} has no annotated frame nearby`);
        }
        // And the extremes must be present (annotation cluster is frames 0..83 here).
        const firstX = Math.round((expected[0] / total) * width);
        const lastX = Math.round((expected[expected.length - 1] / total) * width);
        assert.ok(canvasInfo.columns.some((c) => Math.abs(c - firstX) <= 2), 'first annotated frame marked');
        assert.ok(canvasInfo.columns.some((c) => Math.abs(c - lastX) <= 3), 'last annotated frame marked');

        // 3) Next / previous annotated frame navigation.
        const readFrame = () => page.evaluate(() => {
            const input = document.querySelector('.cvat-player-frame-selector input');
            return input ? Number(input.value) : null;
        });
        const navButtons = page.locator('.cvat-annotated-frame-nav');
        const [prevBtn, nextBtn] = [navButtons.nth(0), navButtons.nth(1)];
        console.log('start frame:', await readFrame());
        const visited = [];
        for (let i = 0; i < 3; i++) {
            await nextBtn.click();
            await page.waitForTimeout(700);
            visited.push(await readFrame());
        }
        console.log('after next x3:', visited);
        assert.deepEqual(visited, expected.slice(1, 4), 'next jumps follow annotated frames');

        await prevBtn.click();
        await page.waitForTimeout(700);
        const back = await readFrame();
        console.log('after prev:', back);
        assert.equal(back, expected[2], 'prev returns to previous annotated frame');
        assert.deepEqual(writes, [], 'no annotation or model writes');
        assert.deepEqual(errors, []);
        await page.screenshot({ path: __dirname + '/annotated-nav.png' });
        const result = { passed: true, api_annotated_frames: expected.length, first_annotated_frames: expected.slice(0, 6), next_jumps: visited, prev_jump: back, canvas: { width: canvasInfo.cssWidth, slider_width: canvasInfo.sliderWidth, marked_columns: canvasInfo.markedColumns }, errors };
        fs.writeFileSync(__dirname + '/nav-result.json', JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result));
    } finally {
        await browser.close();
    }
})().catch((e) => { console.error(e.stack); process.exit(1); });
