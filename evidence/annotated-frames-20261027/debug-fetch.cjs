const { chromium } = require('/home/xinrun/pi-web/node_modules/playwright');
const fs = require('fs');
const base = 'https://cvat.lxrserver.xyz';
const creds = Object.fromEntries(fs.readFileSync('/home/xinrun/cvat/.credentials', 'utf8').trim().split('\n').map((l) => l.split('=')));
(async () => {
    const browser = await chromium.launch({ headless: true, executablePath: '/home/xinrun/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox'] });
    try {
        const ctx = await browser.newContext();
        await ctx.request.post(base + '/api/auth/login', { data: { username: 'cvatadmin', password: creds.password }, headers: { Accept: 'application/vnd.cvat+json' } });
        const page = await ctx.newPage();
        await page.goto(base + '/tasks', { waitUntil: 'domcontentloaded' });
        await page.locator('.cvat-tasks-list-item').first().waitFor({ timeout: 90000 });
        const debug = await page.evaluate(async () => {
            const out = {};
            const jobsResp = await fetch('/api/jobs?task_id=2', { credentials: 'same-origin', headers: { Accept: 'application/vnd.cvat+json' } });
            out.jobsStatus = jobsResp.status;
            const jobs = (await jobsResp.json()).results || [];
            out.jobs = jobs.map((j) => ({ id: j.id, type: j.type, start: j.start_frame, stop: j.stop_frame }));
            const annotationJobs = jobs.filter((j) => j.type === 'annotation');
            out.annotationJobIds = annotationJobs.map((j) => j.id);
            for (const job of annotationJobs) {
                const r = await fetch(`/api/jobs/${job.id}/annotations`, { credentials: 'same-origin', headers: { Accept: 'application/vnd.cvat+json' } });
                const ann = await r.json();
                const frames = new Set((ann.shapes || []).map((s) => s.frame));
                out[`job_${job.id}`] = { status: r.status, shapes: (ann.shapes || []).length, distinctFrames: frames.size, firstFrames: [...frames].slice(0, 10) };
            }
            return out;
        });
        console.log(JSON.stringify(debug, null, 2));
    } finally {
        await browser.close();
    }
})().catch((e) => { console.error(e.stack); process.exit(1); });
