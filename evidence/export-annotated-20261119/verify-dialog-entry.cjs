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
        // open the stock dialog
        await page.locator('.cvat-task-page-actions-button').click();
        await page.getByText('Export task dataset', { exact: true }).click();
        const modalEntry = page.locator('#cvat-export-annotated-modal-entry');
        await modalEntry.waitFor({ timeout: 20000 });
        await page.screenshot({ path: path.join(__dirname, 'dialog-entry.png') });
        console.log('entry inside stock dialog:', (await modalEntry.innerText()).trim());
        // clicking it must close the stock modal and open ours
        await modalEntry.click();
        const ours = page.locator('#cvat-export-annotated-dialog');
        await ours.waitFor({ timeout: 20000 });
        await page.waitForTimeout(800);
        const stockModal = page.locator('.ant-modal-content').filter({ hasText: 'Export format' }).first();
        const stockVisible = (await stockModal.count()) ? await stockModal.isVisible() : false;
        const wrapHidden = await page.evaluate(() => {
            const wrap = [...document.querySelectorAll('.ant-modal-wrap')].find((w) => /Export format/.test(w.textContent || ''));
            if (!wrap) return 'removed';
            return getComputedStyle(wrap).display;
        });
        console.log('stock modal visible:', stockVisible, '| wrap display:', wrapHidden, '| ours title:', (await ours.locator('h2').innerText()).trim());
        assert.equal(stockVisible, false, 'stock dialog no longer visible');
        // run a real export from this path
        await ours.locator('[data-role=format]').selectOption('coco');
        const downloadPromise = page.waitForEvent('download', { timeout: 300000 });
        await ours.locator('[data-role=run]').click();
        const download = await downloadPromise;
        const target = path.join(__dirname, 'dialog-entry-coco.zip');
        await download.saveAs(target);
        const status = (await ours.locator('[data-role=status]').innerText()).replace(/\n/g, ' ');
        console.log('export status:', status);
        assert.match(status, /^完成：/);
        await ours.locator('[data-role=close]').click();
        const after = await (await ctx.request.get(base + '/api/jobs/1/annotations')).json();
        assert.deepEqual(after, before);
        assert.deepEqual(errors, []);
        const result = { passed: true, status, bytes: fs.statSync(target).size, errors };
        fs.writeFileSync(path.join(__dirname, 'dialog-entry-result.json'), JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result));
    } finally { await browser.close(); }
})().catch((e) => { console.error(e.stack); process.exit(1); });
