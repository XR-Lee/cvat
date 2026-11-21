// Marks must map 1:1 to annotated frames on a tiny task (3 frames -> wide ticks).
const { chromium } = require('/home/xinrun/pi-web/node_modules/playwright');
const fs = require('fs'), assert = require('node:assert/strict');
const base = 'https://cvat.lxrserver.xyz';
const creds = Object.fromEntries(fs.readFileSync('/home/xinrun/cvat/.credentials', 'utf8').trim().split('\n').map((l) => l.split('=')));
const tmp = JSON.parse(fs.readFileSync(__dirname + '/temp-nav.json'));
(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: '/home/xinrun/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox'] });
    try {
        const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
        assert.ok((await ctx.request.post(base + '/api/auth/login', { data: { username: 'cvatadmin', password: creds.password }, headers: { Accept: 'application/vnd.cvat+json' } })).ok());
        const ann = await (await ctx.request.get(base + `/api/jobs/${tmp.job}/annotations`)).json();
        const expected = [...new Set(ann.shapes.map((s) => s.frame))].sort((a, b) => a - b);
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(`${base}/tasks/${tmp.task}/jobs/${tmp.job}`);
        await page.locator('.cvat-player-buttons').waitFor({ timeout: 120000 });
        await page.waitForFunction(() => document.querySelector('.cvat-annotated-frames-canvas'), undefined, { timeout: 40000 });
        await page.waitForTimeout(2000);
        const info = await page.evaluate(() => {
            const canvas = document.querySelector('.cvat-annotated-frames-canvas');
            const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            const columns = [];
            for (let x = 0; x < canvas.width; x++) {
                for (let y = 0; y < canvas.height; y++) {
                    if (data[(y * canvas.width + x) * 4 + 3] > 0) { columns.push(x); break; }
                }
            }
            return { width: canvas.getBoundingClientRect().width, columns };
        });
        const total = tmp.frames;
        const expectedX = expected.map((f) => Math.round((f / total) * info.width));
        console.log('expected frames', expected, 'expected x', expectedX, 'drawn columns', info.columns);
        // Each tick is TICK_W (2) px wide, so group consecutive columns into ticks.
        const runs = [];
        for (const column of info.columns) {
            const last = runs[runs.length - 1];
            if (last && column - last[last.length - 1] <= 1) last.push(column);
            else runs.push([column]);
        }
        console.log('tick runs:', runs.map((r) => r[0]));
        for (const x of expectedX) {
            assert.ok(runs.some((run) => Math.abs(run[0] - x) <= 3), `tick for x=${x}`);
        }
        assert.equal(runs.length, expectedX.length, 'one tick per annotated frame');
        // Jump from frame 0 forward through annotated frames.
        const readFrame = () => page.evaluate(() => Number(document.querySelector('.cvat-player-frame-selector input')?.value));
        const next = page.locator('.cvat-annotated-frame-nav').nth(1);
        const prev = page.locator('.cvat-annotated-frame-nav').nth(0);
        const seen = [];
        // Start at frame 0 which is already annotated: one jump reaches frame 2,
        // after which "next" must be disabled.
        for (let i = 1; i < expected.length; i++) { await next.click(); await page.waitForTimeout(600); seen.push(await readFrame()); }
        const atEnd = await readFrame();
        const nextDisabled = await page.evaluate(() => {
            const button = document.querySelectorAll('.cvat-annotated-frame-nav')[1];
            return button ? getComputedStyle(button).pointerEvents === 'none' : null;
        });
        assert.equal(nextDisabled, true, 'next button disabled at the last annotated frame');
        await prev.click(); await page.waitForTimeout(600);
        const back = await readFrame();
        console.log('walked', seen, 'last', atEnd, 'back', back);
        assert.deepEqual(seen, expected.slice(1));
        assert.equal(back, expected[expected.length - 2]);
        assert.deepEqual(errors, []);
        const result = { passed: true, frames: tmp.frames, annotated: expected, ticks: runs.length, tick_columns: info.columns, walked: seen, back };
        fs.writeFileSync(__dirname + '/nav-tiny-result.json', JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result));
    } finally {
        await browser.close();
    }
})().catch((e) => { console.error(e.stack); process.exit(1); });
