// Verify the temporal-tracking default is now 10 frames (dialog + action param).
const { chromium } = require('/home/xinrun/pi-web/node_modules/playwright');
const fs = require('fs'), assert = require('node:assert/strict');
const base = 'https://cvat.lxrserver.xyz';
const creds = Object.fromEntries(fs.readFileSync('/home/xinrun/cvat/.credentials', 'utf8').trim().split('\n').map((l) => l.split('=')));
(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: '/home/xinrun/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox'] });
    try {
        const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
        assert.ok((await ctx.request.post(base + '/api/auth/login', { data: { username: 'cvatadmin', password: creds.password }, headers: { Accept: 'application/vnd.cvat+json' } })).ok());
        const before = await (await ctx.request.get(base + '/api/jobs/1/annotations')).json();
        const page = await ctx.newPage();
        const errors = [], writes = [];
        page.on('pageerror', (e) => errors.push(e.message));
        page.on('request', (r) => {
            if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(r.method()) && /\/api\/(jobs\/1|tasks\/2)\/annotations|\/api\/lambda\//.test(r.url())) writes.push(r.method() + ' ' + r.url());
        });
        await page.goto(base + '/tasks/2/jobs/1');
        await page.locator('#cvat-multi-mask-gpu-button').waitFor({ timeout: 90000 });

        // 1) toolbar dialog default
        await page.locator('#cvat-multi-mask-gpu-button').click();
        const dialog = page.locator('#cvat-multi-mask-gpu-dialog');
        await dialog.locator('[data-role=frames]').waitFor();
        const dialogValue = await dialog.locator('[data-role=frames]').inputValue();
        const dialogMax = await dialog.locator('[data-role=frames]').getAttribute('max');
        await page.screenshot({ path: __dirname + '/frames10-dialog.png' });
        await dialog.locator('[data-role=close]').click();

        // 2) object-menu annotation action default
        const item = page.locator('.cvat-objects-sidebar-state-item').first();
        await item.hover();
        await item.locator('[aria-label="more"]').click();
        await page.locator('.ant-dropdown:visible').getByText('Run annotation action', { exact: true }).click();
        await page.locator('.cvat-action-runner-list .ant-select').click();
        await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option-content', { hasText: 'Multi-Mask' }).click();
        await page.waitForTimeout(600);
        const actionValue = await page.locator('.cvat-action-runner-action-parameter input').first().inputValue();
        await page.screenshot({ path: __dirname + '/frames10-action.png' });
        await page.locator('.cvat-action-runner-cancel-btn').click();

        assert.equal(dialogValue, '10', 'dialog default');
        assert.equal(actionValue, '10', 'annotation action default');
        assert.equal(dialogMax, '100', 'max unchanged');
        assert.deepEqual(writes, [], 'no annotation/lambda writes');
        assert.deepEqual(errors, []);
        const after = await (await ctx.request.get(base + '/api/jobs/1/annotations')).json();
        assert.deepEqual(after, before, 'job 1 annotations unchanged');
        const result = { passed: true, dialog_default: dialogValue, action_default: actionValue, max: dialogMax, writes: writes.length, errors };
        fs.writeFileSync(__dirname + '/frames10-result.json', JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result));
    } finally {
        await browser.close();
    }
})().catch((e) => { console.error(e.stack); process.exit(1); });
