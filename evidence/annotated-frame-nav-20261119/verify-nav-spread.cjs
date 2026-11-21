// Verify markers on a job whose annotations are spread across the timeline (task 15 / job 15),
// and that prev/next jumping works there too.
const { chromium } = require('/home/xinrun/pi-web/node_modules/playwright');
const fs = require('fs'), assert = require('node:assert/strict');
const base = 'https://cvat.lxrserver.xyz';
const creds = Object.fromEntries(fs.readFileSync('/home/xinrun/cvat/.credentials', 'utf8').trim().split('\n').map((l) => l.split('=')));
const TASK = 15, JOB = 15;
(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: '/home/xinrun/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox'] });
    try {
        const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
        assert.ok((await ctx.request.post(base + '/api/auth/login', { data: { username: 'cvatadmin', password: creds.password }, headers: { Accept: 'application/vnd.cvat+json' } })).ok());
        const ann = await (await ctx.request.get(base + `/api/jobs/${JOB}/annotations`)).json();
        const expected = [...new Set(ann.shapes.map((s) => s.frame))].sort((a, b) => a - b);
        const total = 15660;
        const page = await ctx.newPage();
        const errors = [], writes = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('request', (r) => {
            if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(r.method()) && /\/annotations|\/api\/lambda\//.test(r.url())) writes.push(r.method() + ' ' + r.url());
        });
        await page.goto(`${base}/tasks/${TASK}/jobs/${JOB}`);
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
            return { width: canvas.width, cssWidth: canvas.getBoundingClientRect().width, columns };
        });
        const span = [expected[0], expected[expected.length - 1]];
        const expectedX = [Math.round((span[0] / total) * info.cssWidth), Math.round((span[1] / total) * info.cssWidth)];
        console.log('marked columns:', info.columns.length, 'first/last:', info.columns[0], info.columns[info.columns.length - 1],
            'expected span x:', expectedX, 'annotated frames:', expected.length);
        assert.ok(info.columns.length >= 8, 'marker strip drawn (adjacent frames coalesce into single columns)');
        assert.ok(Math.abs(info.columns[0] - expectedX[0]) <= 3, 'left edge marker matches first annotated frame');
        assert.ok(Math.abs(info.columns[info.columns.length - 1] - expectedX[1]) <= 3, 'right edge marker matches last annotated frame');
        // Every marked column must sit inside the annotated span.
        assert.ok(info.columns.every((c) => c >= expectedX[0] - 3 && c <= expectedX[1] + 3), 'markers only inside annotated span');

        // Jump to the first annotated frame, then walk forward twice and back once.
        const readFrame = () => page.evaluate(() => Number(document.querySelector('.cvat-player-frame-selector input')?.value));
        const [prevBtn, nextBtn] = [page.locator('.cvat-annotated-frame-nav').nth(0), page.locator('.cvat-annotated-frame-nav').nth(1)];
        // Start at frame 0 (before all annotations) -> "next" must jump to the first annotated frame.
        const before = await readFrame();
        await nextBtn.click(); await page.waitForTimeout(900);
        const first = await readFrame();
        await nextBtn.click(); await page.waitForTimeout(900);
        const second = await readFrame();
        await prevBtn.click(); await page.waitForTimeout(900);
        const back = await readFrame();
        console.log('start', before, '-> next', first, '-> next', second, '-> prev', back);
        assert.equal(first, expected[0], 'first jump lands on first annotated frame');
        assert.equal(second, expected[1], 'second jump lands on second annotated frame');
        assert.equal(back, expected[0], 'prev returns');
        assert.deepEqual(writes, []); assert.deepEqual(errors, []);
        await page.screenshot({ path: __dirname + '/annotated-nav-spread.png' });
        const result = { passed: true, task: TASK, job: JOB, annotated_frames: expected.length, span, marked_columns: info.columns.length, jumps: { start: before, first, second, back }, errors };
        fs.writeFileSync(__dirname + '/nav-spread-result.json', JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result));
    } finally {
        await browser.close();
    }
})().catch((e) => { console.error(e.stack); process.exit(1); });
