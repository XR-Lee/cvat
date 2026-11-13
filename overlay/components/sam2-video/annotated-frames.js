/* CVAT Community plugin: show "已标注 N 帧" on each task-list row.
 *
 * The stock task list progress bar counts completed *jobs*, not annotated
 * frames. This script derives the per-task annotated-frame count from the
 * annotations API and injects a small badge into each row's progress area.
 *
 * It uses plain DOM injection (no bundle rebuild): every row is scanned on a
 * timer and after DOM mutations, and the badge is re-attached whenever React
 * re-renders the list. Statistics are cached and refreshed periodically;
 * failures are silent so the badge simply stays absent.
 */
(() => {
    'use strict';
    const BADGE_CLASS = 'cvat-annotated-frames-badge';
    const REFRESH_STATS_MS = 30000; // re-read annotation counts
    const SCAN_MS = 1200;           // re-attach badges React may have removed
    const stats = new Map();        // taskId -> annotated frame count

    async function annotatedFramesForTask(taskId) {
        const jobsResponse = await fetch(`/api/jobs?task_id=${taskId}`, {
            credentials: 'same-origin',
            headers: { Accept: 'application/vnd.cvat+json' },
        });
        if (!jobsResponse.ok) return 0;
        const jobs = (await jobsResponse.json()).results || [];
        const annotationJobs = jobs.filter((job) => job.type === 'annotation');
        const frames = new Set();
        for (const job of annotationJobs) {
            const response = await fetch(`/api/jobs/${job.id}/annotations`, {
                credentials: 'same-origin',
                headers: { Accept: 'application/vnd.cvat+json' },
            });
            if (!response.ok) continue;
            const annotations = await response.json();
            for (const shape of annotations.shapes || []) frames.add(shape.frame);
        }
        return frames.size;
    }

    async function refreshStats() {
        try {
            const response = await fetch('/api/tasks?page_size=100', {
                credentials: 'same-origin',
                headers: { Accept: 'application/vnd.cvat+json' },
            });
            if (!response.ok) return;
            const tasks = (await response.json()).results || [];
            // Load counts concurrently; each task is independent and a single
            // failure must not block the others.
            await Promise.all(tasks.map(async (task) => {
                if (stats.has(task.id)) return;
                try {
                    stats.set(task.id, await annotatedFramesForTask(task.id));
                } catch (error) {
                    // best-effort per task
                }
            }));
        } catch (error) {
            // best-effort; ignore network/auth errors
        }
    }

    function taskIdFromRow(row) {
        const idEl = row.querySelector('.cvat-item-task-id');
        if (!idEl) return null;
        const digits = (idEl.textContent || '').replace(/[^0-9]/g, '');
        return digits ? Number(digits) : null;
    }

    function render() {
        for (const row of document.querySelectorAll('.cvat-tasks-list-item')) {
            const taskId = taskIdFromRow(row);
            if (taskId === null) continue;
            const count = stats.get(taskId);
            if (!count) continue;
            const textHost = row.querySelector('.cvat-task-item-progress-wrapper > div:first-child');
            if (!textHost) continue;
            if (row.querySelector(`.${BADGE_CLASS}`)) continue; // already attached
            const badge = document.createElement('span');
            badge.className = BADGE_CLASS;
            badge.style.cssText = 'color:#0958d9;font-size:12px;font-weight:600;margin-left:4px';
            badge.textContent = `\u2022 \u5df2\u6807\u6ce8 ${count} \u5e27`;
            textHost.appendChild(badge);
        }
    }

    // Re-scan on DOM changes (rows re-render on hover/select) plus a timer.
    new MutationObserver(render).observe(document.body, { childList: true, subtree: true });
    setInterval(render, SCAN_MS);
    setInterval(refreshStats, REFRESH_STATS_MS);
    refreshStats();
})();
