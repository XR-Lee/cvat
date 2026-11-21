const { chromium } = require('/home/xinrun/pi-web/node_modules/playwright');
const fs = require('fs'), path = require('path'), assert = require('node:assert/strict');
const base = 'https://cvat.lxrserver.xyz';
const creds = Object.fromEntries(fs.readFileSync('/home/xinrun/cvat/.credentials', 'utf8').trim().split('\n').map((l) => l.split('=')));
(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: '/home/xinrun/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox'] });
    try {
        const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
        await ctx.request.post(base + '/api/auth/login', { data: { username: 'cvatadmin', password: creds.password }, headers: { Accept: 'application/vnd.cvat+json' } });
        const before = await (await ctx.request.get(base + '/api/jobs/1/annotations')).json();
        const page = await ctx.newPage(); const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(base + '/tasks/2');
        await page.locator('#cvat-export-annotated-button').waitFor({ timeout: 90000 });
        await page.locator('#cvat-export-annotated-button').click();
        const dialog = page.locator('#cvat-export-annotated-dialog');
        await dialog.locator('[data-role=format]').selectOption('coco');
        await dialog.locator('[data-role=quality]').selectOption('compressed');
        const started = Date.now();
        const downloadPromise = page.waitForEvent('download', { timeout: 300000 });
        await dialog.locator('[data-role=run]').click();
        const download = await downloadPromise;
        const target = path.join(__dirname, 'real-task2-coco.zip'); await download.saveAs(target);
        const status = await dialog.locator('[data-role=status]').innerText();
        const seconds = Math.round((Date.now() - started) / 1000);
        await page.screenshot({ path: path.join(__dirname, 'real-export-done.png') });
        const after = await (await ctx.request.get(base + '/api/jobs/1/annotations')).json();
        assert.deepEqual(after, before); assert.deepEqual(errors, []);
        const result = { passed: true, status: status.replace(/\n/g, ' '), seconds, bytes: fs.statSync(target).size, mb: +(fs.statSync(target).size / 2 ** 20).toFixed(2) };
        fs.writeFileSync(path.join(__dirname, 'real-export-result.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result));
    } finally { await browser.close(); }
})().catch((e) => { console.error(e.stack); process.exit(1); });
