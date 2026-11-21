// End-to-end test of the in-UI "export annotated frames" button on a disposable task.
const { chromium } = require('/home/xinrun/pi-web/node_modules/playwright');
const fs = require('fs'), path = require('path'), assert = require('node:assert/strict');
const base = 'https://cvat.lxrserver.xyz';
const creds = Object.fromEntries(fs.readFileSync('/home/xinrun/cvat/.credentials', 'utf8').trim().split('\n').map((l) => l.split('=')));
const tmp = JSON.parse(fs.readFileSync(path.join(__dirname, 'temp-ui-export.json')));
(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: '/home/xinrun/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox'] });
    try {
        const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, acceptDownloads: true });
        assert.ok((await ctx.request.post(base + '/api/auth/login', { data: { username: 'cvatadmin', password: creds.password }, headers: { Accept: 'application/vnd.cvat+json' } })).ok());
        const before = await (await ctx.request.get(base + `/api/jobs/${tmp.job}/annotations`)).json();
        const page = await ctx.newPage();
        const errors = [], writes = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('request', (r) => {
            if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(r.method()) && /\/annotations/.test(r.url())) writes.push(r.method() + ' ' + r.url());
        });
        await page.goto(`${base}/tasks/${tmp.task}`);
        await page.locator('#cvat-export-annotated-button').waitFor({ timeout: 90000 });
        await page.locator('#cvat-export-annotated-button').click();
        const dialog = page.locator('#cvat-export-annotated-dialog');
        await dialog.waitFor();
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(__dirname, 'export-dialog.png') });

        // COCO, compressed frames
        await dialog.locator('[data-role=format]').selectOption('coco');
        await dialog.locator('[data-role=quality]').selectOption('compressed');
        const downloadPromise = page.waitForEvent('download', { timeout: 180000 });
        await dialog.locator('[data-role=run]').click();
        const download = await downloadPromise;
        const cocoZip = path.join(__dirname, 'ui-coco.zip');
        await download.saveAs(cocoZip);
        const status = await dialog.locator('[data-role=status]').innerText();
        console.log('coco status:', status.replace(/\n/g, ' '));
        assert.match(status, /^完成：/, 'export finished');

        // Segmentation mask, compressed frames
        await dialog.locator('[data-role=format]').selectOption('segmask');
        const downloadPromise2 = page.waitForEvent('download', { timeout: 180000 });
        await dialog.locator('[data-role=run]').click();
        const download2 = await downloadPromise2;
        const maskZip = path.join(__dirname, 'ui-segmask.zip');
        await download2.saveAs(maskZip);
        console.log('segmask status:', (await dialog.locator('[data-role=status]').innerText()).replace(/\n/g, ' '));
        await page.screenshot({ path: path.join(__dirname, 'export-done.png') });
        await dialog.locator('[data-role=close]').click();

        assert.deepEqual(writes, [], 'no annotation writes');
        assert.deepEqual(errors, []);
        const after = await (await ctx.request.get(base + `/api/jobs/${tmp.job}/annotations`)).json();
        assert.deepEqual(after, before, 'job annotations unchanged');
        fs.writeFileSync(path.join(__dirname, 'ui-export-result.json'), JSON.stringify({
            passed: true, coco: { file: cocoZip, size: fs.statSync(cocoZip).size, status },
            segmask: { file: maskZip, size: fs.statSync(maskZip).size }, writes: writes.length, errors,
        }, null, 2));
        console.log(JSON.stringify({ passed: true, coco_bytes: fs.statSync(cocoZip).size, mask_bytes: fs.statSync(maskZip).size }));
    } finally {
        await browser.close();
    }
})().catch((e) => { console.error(e.stack); process.exit(1); });
