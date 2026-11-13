// Verify every badge on the task list matches the API distinct-frame count.
const { chromium } = require('/home/xinrun/pi-web/node_modules/playwright');
const fs = require('fs'), assert = require('node:assert/strict');
const base = 'https://cvat.lxrserver.xyz';
const creds = Object.fromEntries(fs.readFileSync('/home/xinrun/cvat/.credentials', 'utf8').trim().split('\n').map((l) => l.split('=')));
async function apiAnnotatedFrames(ctx, taskId) {
    const jobs = await (await ctx.request.get(base + `/api/jobs?task_id=${taskId}`)).json();
    const annotationJob = jobs.results.find((j) => j.type === 'annotation');
    if (!annotationJob) return 0;
    const ann = await (await ctx.request.get(base + `/api/jobs/${annotationJob.id}/annotations`)).json();
    return new Set((ann.shapes || []).map((s) => s.frame)).size;
}
(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: '/home/xinrun/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox'] });
    try {
        const ctx = await browser.newContext({ viewport: { width: 1700, height: 1100 } });
        assert.ok((await ctx.request.post(base + '/api/auth/login', { data: { username: 'cvatadmin', password: creds.password }, headers: { Accept: 'application/vnd.cvat+json' } })).ok());
        const page = await ctx.newPage();
        const errors = []; page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(base + '/tasks', { waitUntil: 'domcontentloaded' });
        await page.locator('.cvat-tasks-list-item').first().waitFor({ timeout: 90000 });
        await page.waitForFunction(() => document.querySelectorAll('.cvat-annotated-frames-badge').length > 0, undefined, { timeout: 30000 });
        await page.waitForTimeout(2500); // let stats finish loading
        const read = () => page.evaluate(() => [...document.querySelectorAll('.cvat-tasks-list-item')].map((row) => ({
            id: (row.querySelector('.cvat-item-task-id')?.textContent || '').trim().replace(/#|:/g, ''),
            badge: row.querySelector('.cvat-annotated-frames-badge')?.textContent || null,
        })));
        const checked = new Set();
        // Page 1
        for (const row of await read()) {
            if (!row.badge) continue;
            const shown = Number(row.badge.match(/\d+/)[0]);
            const expected = await apiAnnotatedFrames(ctx, Number(row.id));
            assert.equal(shown, expected, `task #${row.id} badge ${shown} != API ${expected}`);
            checked.add(row.id);
        }
        // Find and click page 2 to check task #2.
        console.log('pagination items:', await page.locator('.ant-pagination li').allInnerTexts());
        const pager = page.locator('.ant-pagination-item').filter({ hasText: '2' });
        if (await pager.count()) {
            await pager.click();
            await page.waitForFunction(() => document.querySelector('.cvat-annotated-frames-badge') && [...document.querySelectorAll('.cvat-tasks-list-item')].some((r) => (r.querySelector('.cvat-item-task-id')?.textContent || '').includes('#2:')), undefined, { timeout: 30000 });
            await page.waitForTimeout(2500);
            for (const row of await read()) {
                if (!row.badge) continue;
                const shown = Number(row.badge.match(/\d+/)[0]);
                const expected = await apiAnnotatedFrames(ctx, Number(row.id));
                assert.equal(shown, expected, `task #${row.id} badge ${shown} != API ${expected}`);
                checked.add(row.id);
            }
        }
        await page.screenshot({ path: __dirname + '/task-list-badge-page2.png' });
        assert.deepEqual(errors, []);
        console.log('checked set:', [...checked].map(Number).sort((a,b)=>a-b));
        assert.ok(checked.size >= 4, 'verified several badges: ' + JSON.stringify([...checked]));
        const result = { passed: true, verified_task_ids: [...checked].map(Number).sort((a, b) => a - b), errors };
        fs.writeFileSync(__dirname + '/badge-result.json', JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result));
    } finally {
        await browser.close();
    }
})().catch((e) => { console.error(e.stack); process.exit(1); });
