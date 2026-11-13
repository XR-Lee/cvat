const { chromium } = require('/home/xinrun/pi-web/node_modules/playwright');
const fs = require('fs');
const base = 'https://cvat.lxrserver.xyz';
const creds = Object.fromEntries(fs.readFileSync('/home/xinrun/cvat/.credentials', 'utf8').trim().split('\n').map((l) => l.split('=')));
(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: '/home/xinrun/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox'] });
    try {
        const ctx = await browser.newContext({ viewport: { width: 1700, height: 1100 } });
        await ctx.request.post(base + '/api/auth/login', { data: { username: 'cvatadmin', password: creds.password }, headers: { Accept: 'application/vnd.cvat+json' } });
        const page = await ctx.newPage();
        await page.goto(base + '/tasks', { waitUntil: 'domcontentloaded' });
        await page.locator('.cvat-tasks-list-item').first().waitFor({ timeout: 90000 });
        // Poll badge text over 8 seconds to see if it changes.
        for (let i = 0; i < 8; i++) {
            await page.waitForTimeout(1000);
            const badges = await page.evaluate(() => [...document.querySelectorAll('.cvat-tasks-list-item')].map((row) => ({
                id: (row.querySelector('.cvat-item-task-id')?.textContent || '').trim(),
                badge: row.querySelector('.cvat-annotated-frames-badge')?.textContent || null,
            })));
            console.log(`t=${i + 1}s`, JSON.stringify(badges.filter((b) => b.badge)));
        }
        // Also read what /api/tasks returns (ids) to cross-check ordering/paging.
        const tasks = await page.evaluate(async () => (await fetch('/api/tasks?page_size=100', { credentials: 'same-origin', headers: { Accept: 'application/vnd.cvat+json' } })).json());
        console.log('api task ids:', tasks.results.map((t) => t.id).join(','));
    } finally {
        await browser.close();
    }
})().catch((e) => { console.error(e.stack); process.exit(1); });
