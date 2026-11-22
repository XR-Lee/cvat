/* CVAT Community plugin: export a dataset containing only annotated frames.
 *
 * CVAT's export API has no frame filter: `save_images` always writes every
 * frame. This plugin builds the filtered dataset in the browser instead:
 *
 *   1. ask CVAT for an annotations-only export (small: no images)
 *   2. read that zip in the page (native DecompressionStream)
 *   3. fetch only the frames that carry annotations
 *   4. repack everything into a new zip and download it
 *
 * Nothing is written on the server and no CVAT data is modified.
 * Entry point: a button next to the task page "Actions" button.
 */
(() => {
    'use strict';
    const BUTTON_ID = 'cvat-export-annotated-button';
    const DIALOG_ID = 'cvat-export-annotated-dialog';
    const FORMATS = {
        coco: { cvat: 'COCO 1.0', label: 'COCO 1.0（实例分割 JSON）' },
        segmask: { cvat: 'Segmentation mask 1.1', label: 'Segmentation mask 1.1（逐帧掩膜 PNG）' },
    };
    const SCAN_MS = 1000;
    let busy = false;

    // ---------------------------------------------------------------- zip I/O
    const CRC_TABLE = (() => {
        const table = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            table[i] = c >>> 0;
        }
        return table;
    })();

    function crc32(bytes) {
        let crc = 0xffffffff;
        for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
        return (crc ^ 0xffffffff) >>> 0;
    }

    async function inflateRaw(bytes) {
        if (typeof DecompressionStream === 'undefined') {
            throw new Error('浏览器不支持 DecompressionStream，请使用较新的 Chrome/Edge/Safari');
        }
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    async function readZip(buffer) {
        const view = new DataView(buffer);
        const bytes = new Uint8Array(buffer);
        let eocd = -1;
        for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65558); i--) {
            if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error('不是有效的 zip 文件');
        const count = view.getUint16(eocd + 10, true);
        let offset = view.getUint32(eocd + 16, true);
        const entries = new Map();
        for (let i = 0; i < count; i++) {
            if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('zip 中央目录损坏');
            const method = view.getUint16(offset + 10, true);
            const compressedSize = view.getUint32(offset + 20, true);
            const nameLength = view.getUint16(offset + 28, true);
            const extraLength = view.getUint16(offset + 30, true);
            const commentLength = view.getUint16(offset + 32, true);
            const localOffset = view.getUint32(offset + 42, true);
            const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
            const localNameLength = view.getUint16(localOffset + 26, true);
            const localExtraLength = view.getUint16(localOffset + 28, true);
            const dataStart = localOffset + 30 + localNameLength + localExtraLength;
            const raw = bytes.subarray(dataStart, dataStart + compressedSize);
            let data;
            if (method === 0) data = raw;
            else if (method === 8) data = await inflateRaw(raw);
            else throw new Error(`不支持的压缩方式 ${method}（${name}）`);
            entries.set(name, data);
            offset += 46 + nameLength + extraLength + commentLength;
        }
        return entries;
    }

    // Stored (method 0) entries: frames are already compressed, and the
    // annotation JSON is small. Keeps the writer simple and dependency-free.
    function buildZip(files) {
        const encoder = new TextEncoder();
        const parts = [];
        const central = [];
        let offset = 0;
        for (const [name, data] of files) {
            const nameBytes = encoder.encode(name);
            const crc = crc32(data);
            const local = new Uint8Array(30 + nameBytes.length);
            const lv = new DataView(local.buffer);
            lv.setUint32(0, 0x04034b50, true);
            lv.setUint16(4, 20, true);
            lv.setUint16(6, 0x0800, true); // UTF-8 names
            lv.setUint16(8, 0, true);
            lv.setUint32(14, crc, true);
            lv.setUint32(18, data.length, true);
            lv.setUint32(22, data.length, true);
            lv.setUint16(26, nameBytes.length, true);
            local.set(nameBytes, 30);
            parts.push(local, data);

            const record = new Uint8Array(46 + nameBytes.length);
            const cv = new DataView(record.buffer);
            cv.setUint32(0, 0x02014b50, true);
            cv.setUint16(4, 20, true);
            cv.setUint16(6, 20, true);
            cv.setUint16(8, 0x0800, true);
            cv.setUint32(16, crc, true);
            cv.setUint32(20, data.length, true);
            cv.setUint32(24, data.length, true);
            cv.setUint16(28, nameBytes.length, true);
            cv.setUint32(42, offset, true);
            record.set(nameBytes, 46);
            central.push(record);
            offset += local.length + data.length;
        }
        const centralSize = central.reduce((sum, record) => sum + record.length, 0);
        const eocd = new Uint8Array(22);
        const ev = new DataView(eocd.buffer);
        ev.setUint32(0, 0x06054b50, true);
        ev.setUint16(8, central.length, true);
        ev.setUint16(10, central.length, true);
        ev.setUint32(12, centralSize, true);
        ev.setUint32(16, offset, true);
        return new Blob([...parts, ...central, eocd], { type: 'application/zip' });
    }

    // ------------------------------------------------------------------ http
    function csrfToken() {
        const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
        return match ? decodeURIComponent(match[1]) : '';
    }

    function sameOriginUrl(url) {
        const parsed = new URL(url, window.location.origin);
        return parsed.pathname + parsed.search;
    }

    async function getJson(path, init) {
        const response = await fetch(path, {
            credentials: 'same-origin',
            ...init,
            headers: { Accept: 'application/vnd.cvat+json', ...(init?.headers || {}) },
        });
        if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
        return response.json();
    }

    async function waitForExport(rqId, onProgress, cancelled) {
        const encoded = encodeURIComponent(rqId);
        for (;;) {
            if (cancelled()) throw new Error('cancelled');
            const status = await getJson(`/api/requests/${encoded}`);
            if (status.status === 'finished') return status;
            if (status.status === 'failed') throw new Error(`CVAT 导出失败：${status.message || 'unknown'}`);
            onProgress({ phase: 'server', value: status.progress || 0 });
            await new Promise((resolve) => setTimeout(resolve, 2000));
        }
    }

    async function fetchFrames(taskId, frames, quality, onProgress, cancelled) {
        const results = new Map();
        const queue = [...frames];
        const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
            while (queue.length) {
                if (cancelled()) throw new Error('cancelled');
                const frame = queue.shift();
                const response = await fetch(
                    `/api/tasks/${taskId}/data?type=frame&number=${frame}&quality=${quality}`,
                    { credentials: 'same-origin' },
                );
                if (!response.ok) throw new Error(`取帧 #${frame} 失败：HTTP ${response.status}`);
                results.set(frame, new Uint8Array(await response.arrayBuffer()));
                onProgress({ phase: 'frames', done: results.size, total: frames.length });
            }
        });
        await Promise.all(workers);
        return results;
    }

    function extensionOf(bytes) {
        if (bytes[0] === 0x89 && bytes[1] === 0x50) return '.png';
        if (bytes[0] === 0xff && bytes[1] === 0xd8) return '.jpg';
        return '.png';
    }

    function frameOf(name) {
        const match = name.match(/(\d+)\D*$/);
        return match ? Number(match[1]) : null;
    }

    // ---------------------------------------------------------------- export
    async function exportAnnotated({ taskId, format, quality, onProgress, cancelled }) {
        onProgress({ message: '请求 CVAT 仅标注导出…' });
        const rq = await getJson(`/api/tasks/${taskId}/dataset/export?format=${encodeURIComponent(FORMATS[format].cvat)}&save_images=false`, {
            method: 'POST',
            headers: { 'X-CSRFToken': csrfToken(), 'Content-Type': 'application/json' },
        });
        const status = await waitForExport(rq.rq_id, onProgress, cancelled);
        const downloadPath = sameOriginUrl(status.result_url);
        const archiveResponse = await fetch(downloadPath, { credentials: 'same-origin' });
        if (!archiveResponse.ok) throw new Error(`下载导出包失败：HTTP ${archiveResponse.status}`);
        const entries = await readZip(await archiveResponse.arrayBuffer());

        const files = [];
        let frames = [];
        if (format === 'coco') {
            const jsonName = [...entries.keys()].find((name) => name.endsWith('.json'));
            if (!jsonName) throw new Error('导出包里找不到 COCO JSON');
            const data = JSON.parse(new TextDecoder().decode(entries.get(jsonName)));
            const annotated = new Set(data.annotations.map((ann) => ann.image_id));
            const images = data.images.filter((image) => annotated.has(image.id));
            frames = images.map((image) => frameOf(image.file_name)).filter((value) => value !== null);
            onProgress({ message: `${frames.length} 帧有标注（共 ${data.images.length} 帧），开始取帧…` });
            const frameBytes = await fetchFrames(taskId, frames, quality, onProgress, cancelled);
            const kept = new Set(frames);
            const imagesOut = images.map((image) => {
                const frame = frameOf(image.file_name);
                const bytes = frameBytes.get(frame);
                const name = image.file_name.replace(/\.[^.]*$/, extensionOf(bytes));
                files.push([`images/default/${name}`, bytes]);
                return { ...image, file_name: name };
            });
            const annotationsOut = data.annotations.filter((ann) => annotated.has(ann.image_id));
            const filtered = {
                info: data.info || {}, licenses: data.licenses || [], categories: data.categories,
                images: imagesOut, annotations: annotationsOut,
            };
            files.push([jsonName, new TextEncoder().encode(JSON.stringify(filtered))]);
            onProgress({ message: `打包 ${imagesOut.length} 帧 / ${annotationsOut.length} 个标注…` });
            void kept;
            return { files, frames: imagesOut.length, annotations: annotationsOut.length };
        }

        // Segmentation mask: masks are already the annotation; keep them and add frames.
        const maskNames = [...entries.keys()].filter((name) => name.startsWith('SegmentationClass/'));
        frames = maskNames.map((name) => frameOf(name)).filter((value) => value !== null);
        onProgress({ message: `${frames.length} 帧有掩膜，开始取帧…` });
        const frameBytes = await fetchFrames(taskId, frames, quality, onProgress, cancelled);
        for (const [name, data] of entries) {
            if (name.startsWith('SegmentationClass/') || name.startsWith('SegmentationObject/') || name === 'labelmap.txt') {
                files.push([name, data]);
            }
        }
        const stems = maskNames.map((name) => name.replace(/^SegmentationClass\//, '').replace(/\.[^.]*$/, ''));
        for (const stem of stems) {
            const frame = frameOf(stem);
            const bytes = frameBytes.get(frame);
            files.push([`JPEGImages/${stem}${extensionOf(bytes)}`, bytes]);
        }
        files.push(['ImageSets/Segmentation/default.txt', new TextEncoder().encode(stems.join('\n') + '\n')]);
        onProgress({ message: `打包 ${stems.length} 帧掩膜…` });
        return { files, frames: stems.length, annotations: maskNames.length };
    }

    // -------------------------------------------------------------------- ui
    function taskIdFromLocation() {
        const match = window.location.pathname.match(/^\/tasks\/(\d+)(?:\/|$)/);
        return match ? Number(match[1]) : null;
    }

    function ensureButton() {
        const taskId = taskIdFromLocation();
        const actionsButton = document.querySelector('.cvat-task-page-actions-button');
        if (!taskId || !actionsButton) {
            document.getElementById(BUTTON_ID)?.remove();
            return;
        }
        if (document.getElementById(BUTTON_ID)) return;
        const button = document.createElement('button');
        button.id = BUTTON_ID;
        button.type = 'button';
        button.className = 'ant-btn ant-btn-default';
        button.style.cssText = 'margin-left:8px;height:32px;font-size:13px;color:#0958d9;border-color:#91caff;background:#e6f4ff';
        button.textContent = '\u5bfc\u51fa\u5df2\u6807\u6ce8\u5e27';
        button.title = '只导出有标注的帧（浏览器内打包，不改动任务）';
        button.addEventListener('click', () => openDialog(taskId));
        actionsButton.insertAdjacentElement('afterend', button);
    }

    function openDialog(taskId) {
        document.getElementById(DIALOG_ID)?.remove();
        const dialog = document.createElement('dialog');
        dialog.id = DIALOG_ID;
        dialog.style.cssText = 'width:520px;max-width:92vw;border:1px solid #91caff;border-radius:10px;padding:22px';
        dialog.innerHTML = `
            <h2 style="margin:0 0 12px">导出已标注帧 · Task #${taskId}</h2>
            <p style="font-size:13px;color:#595959;margin:0 0 14px">
                只包含有标注的帧；由浏览器取帧并打包，服务端不改动任何数据。
            </p>
            <p><label>格式 <select data-role="format" style="min-width:320px">${Object.entries(FORMATS)
                .map(([value, { label }]) => `<option value="${value}">${label}</option>`).join('')}</select></label></p>
            <p><label>帧质量 <select data-role="quality">
                <option value="compressed">压缩（JPEG，体积小）</option>
                <option value="original">原始（PNG，无损）</option>
            </select></label></p>
            <progress data-role="progress" max="100" value="0" style="width:100%"></progress>
            <p data-role="status" style="font-size:13px;white-space:pre-wrap;min-height:2.4em"></p>
            <div style="display:flex;justify-content:flex-end;gap:12px">
                <button data-role="close">关闭</button>
                <button data-role="run" style="font-weight:600">开始导出</button>
            </div>`;
        document.body.appendChild(dialog);
        dialog.showModal();

        const formatSelect = dialog.querySelector('[data-role="format"]');
        const qualitySelect = dialog.querySelector('[data-role="quality"]');
        const progress = dialog.querySelector('[data-role="progress"]');
        const status = dialog.querySelector('[data-role="status"]');
        const runButton = dialog.querySelector('[data-role="run"]');
        const closeButton = dialog.querySelector('[data-role="close"]');
        let cancelled = false;

        closeButton.addEventListener('click', () => {
            if (busy) { cancelled = true; status.textContent = '正在取消…'; return; }
            dialog.close();
            dialog.remove();
        });

        runButton.addEventListener('click', async () => {
            if (busy) return;
            busy = true;
            cancelled = false;
            runButton.disabled = true;
            formatSelect.disabled = true;
            qualitySelect.disabled = true;
            closeButton.textContent = '取消';
            progress.value = 0;
            const onProgress = (event) => {
                if (event.message) status.textContent = event.message;
                if (event.phase === 'server') progress.value = Math.round((event.value || 0) * 100);
                if (event.phase === 'frames') progress.value = Math.round((event.done / event.total) * 100);
            };
            try {
                const result = await exportAnnotated({
                    taskId,
                    format: formatSelect.value,
                    quality: qualitySelect.value,
                    onProgress,
                    cancelled: () => cancelled,
                });
                if (cancelled) { status.textContent = '已取消，未生成文件。'; return; }
                const blob = buildZip(result.files);
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement('a');
                const suffix = formatSelect.value === 'coco' ? 'coco' : 'segmask';
                anchor.href = url;
                anchor.download = `task-${taskId}-annotated-${suffix}.zip`;
                document.body.appendChild(anchor);
                anchor.click();
                anchor.remove();
                setTimeout(() => URL.revokeObjectURL(url), 60000);
                status.textContent = `完成：${result.frames} 帧，${result.annotations} 个标注，${(blob.size / 2 ** 20).toFixed(1)} MB。`;
                progress.value = 100;
            } catch (error) {
                status.textContent = cancelled ? '已取消，未生成文件。' : `失败：${error.message}`;
            } finally {
                busy = false;
                runButton.disabled = false;
                formatSelect.disabled = false;
                qualitySelect.disabled = false;
                closeButton.textContent = '关闭';
            }
        });
    }

    // Also surface the entry point inside CVAT's own "Export task as a dataset"
    // dialog, where users naturally look. The stock dialog is a compiled React
    // component, so this adds a sibling action instead of a real form field;
    // it closes that dialog and opens ours.
    const MODAL_ENTRY_ID = 'cvat-export-annotated-modal-entry';
    function ensureDialogEntry() {
        const taskId = taskIdFromLocation();
        if (!taskId) return;
        const modal = [...document.querySelectorAll('.ant-modal')].find((element) => (
            /Export (task|project|job) as a dataset/i.test(element.textContent || '')
            && element.querySelector('.cvat-run-model-content, .ant-modal-footer')
        ));
        if (!modal || modal.querySelector(`#${MODAL_ENTRY_ID}`)) return;
        const footer = modal.querySelector('.ant-modal-footer');
        if (!footer) return;
        const entry = document.createElement('button');
        entry.id = MODAL_ENTRY_ID;
        entry.type = 'button';
        entry.className = 'ant-btn ant-btn-link';
        entry.style.cssText = 'margin-right:auto;padding-left:0;color:#0958d9';
        entry.textContent = '\u53ea\u5bfc\u51fa\u5df2\u6807\u6ce8\u5e27\u2026';
        entry.title = '\u53ea\u5305\u542b\u6709\u6807\u6ce8\u7684\u5e27\uff08\u6d4f\u89c8\u5668\u5185\u6253\u5305\uff09';
        entry.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            // Close the stock dialog through its own Cancel button so React
            // tears the modal down normally.
            const cancel = [...footer.querySelectorAll('button')]
                .find((button) => /cancel|\u53d6\u6d88/i.test(button.textContent || ''));
            cancel?.click();
            openDialog(taskId);
        });
        footer.insertBefore(entry, footer.firstChild);
        const footerStyle = footer.getAttribute('style') || '';
        if (!/display:\s*flex/.test(footerStyle)) {
            footer.setAttribute('style', `${footerStyle};display:flex;align-items:center;gap:8px`);
        }
    }

    function tick() {
        try {
            if (/^\/tasks\/\d+/.test(window.location.pathname)) {
                ensureButton();
                ensureDialogEntry();
            } else {
                document.getElementById(BUTTON_ID)?.remove();
            }
        } catch (error) {
            // page not ready; ignore
        }
    }

    new MutationObserver(tick).observe(document.body, { childList: true, subtree: true });
    setInterval(tick, SCAN_MS);
    tick();
})();
