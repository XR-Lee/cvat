/* CVAT Community plugin: annotated-frame markers on the player slider + jump buttons.
 *
 * Adds, inside the annotation editor only:
 *   - amber ticks on the frame slider for every frame that carries at least one shape
 *   - two transport buttons: jump to previous / next annotated frame
 *
 * Data comes from the current job's in-memory annotation collection
 * (job.annotations.export()), so unsaved edits are reflected immediately and no
 * extra API traffic is generated. Markers are drawn on a canvas so jobs with
 * thousands of annotated frames stay cheap.
 */
(() => {
    'use strict';
    const CANVAS_CLASS = 'cvat-annotated-frames-canvas';
    const NAV_CLASS = 'cvat-annotated-frame-nav';
    const REFRESH_MS = 3000;      // re-read the frame set (covers edits/saves)
    const SCAN_MS = 1000;         // re-attach nodes after React re-renders
    const TICK_COLOR = 'rgba(250, 173, 20, 0.95)';
    const TICK_W = 2;

    let mounted = false;

    function register() {
        if (mounted || !window.cvatUI) return;
        mounted = true;

        window.cvatUI.registerComponent(({ core, store, dispatch, actionCreators }) => {
            let canvas = null;
            let prevButton = null;
            let nextButton = null;
            let frames = [];                 // absolute frame numbers, ascending
            let signature = '';
            let jobId = null;
            let startFrame = 0;
            let stopFrame = 0;
            let lastJob = null;
            const timers = [];

            const frameSet = () => new Set(frames);

            function currentState() {
                return store.getState().annotation || {};
            }

            function currentJob() {
                const job = currentState().job?.instance;
                return job && typeof job.id === 'number' ? job : null;
            }

            function currentFrame() {
                return currentState().player?.frame?.number;
            }

            // Job annotations store frames relative to the segment start;
            // the player shows absolute task frames.
            async function refreshFrames(job) {
                try {
                    const collection = await job.annotations.export();
                    const offset = job.startFrame || 0;
                    const unique = new Set();
                    for (const shape of collection.shapes || []) unique.add(shape.frame + offset);
                    for (const track of collection.tracks || []) {
                        for (const keyframe of track.shapes || []) {
                            if (!keyframe.outside) unique.add(keyframe.frame + offset);
                        }
                    }
                    const next = [...unique].sort((a, b) => a - b);
                    const sig = `${next.length}:${next[0] ?? -1}:${next[next.length - 1] ?? -1}:${
                        next.reduce((acc, value) => (acc + value) % 1000003, 0)}`;
                    frames = next;
                    signature = sig;
                    jobId = job.id;
                    startFrame = job.startFrame ?? 0;
                    stopFrame = job.stopFrame ?? 0;
                    drawMarkers();
                    updateButtons();
                } catch (error) {
                    // job may be closing; ignore
                }
            }

            function sliderElement() {
                return document.querySelector('.cvat-player-controls .cvat-player-slider');
            }

            function ensureNodes() {
                const slider = sliderElement();
                if (!slider) return false;
                const host = slider.parentElement; // position: relative Col
                if (!host) return false;

                if (!canvas || !canvas.isConnected) {
                    canvas = document.createElement('canvas');
                    canvas.className = CANVAS_CLASS;
                    canvas.setAttribute('aria-hidden', 'true');
                    canvas.title = '黄色短线：已标注帧';
                    canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:5';
                    host.appendChild(canvas);
                }

                const buttonsHost = document.querySelector('.cvat-player-buttons');
                if (buttonsHost) {
                    if (!prevButton || !prevButton.isConnected) {
                        prevButton = makeButton('prev', '\u4e0a\u4e00\u4e2a\u5df2\u6807\u6ce8\u5e27', buttonsHost);
                    }
                    if (!nextButton || !nextButton.isConnected) {
                        nextButton = makeButton('next', '\u4e0b\u4e00\u4e2a\u5df2\u6807\u6ce8\u5e27', buttonsHost);
                    }
                }
                return true;
            }

            function makeButton(direction, title, host) {
                const button = document.createElement('span');
                button.className = `${NAV_CLASS} ${NAV_CLASS}-${direction}`;
                button.setAttribute('role', 'button');
                button.setAttribute('tabindex', '0');
                button.setAttribute('aria-label', title);
                button.title = title;
                button.style.cssText = 'cursor:pointer;display:inline-flex;align-items:center;margin:0 4px';
                // Chevron + dot: "step to the neighbouring annotated frame".
                const flip = direction === 'prev' ? '' : 'transform="scale(-1,1) translate(-24,0)"';
                button.innerHTML = `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none"
                    xmlns="http://www.w3.org/2000/svg"><g ${flip} stroke="currentColor" stroke-width="1.8"
                    stroke-linecap="round" stroke-linejoin="round"><path d="M14 5 7 12l7 7"/><circle cx="18.5" cy="12" r="2.2" fill="currentColor" stroke="none"/></g></svg>`;
                const jump = (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    go(direction);
                };
                button.addEventListener('click', jump);
                button.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter' || event.key === ' ') jump(event);
                });
                host.appendChild(button);
                return button;
            }

            function nearest(direction) {
                const frame = currentFrame();
                if (typeof frame !== 'number' || !frames.length) return null;
                if (direction === 'next') return frames.find((value) => value > frame) ?? null;
                for (let i = frames.length - 1; i >= 0; i -= 1) {
                    if (frames[i] < frame) return frames[i];
                }
                return null;
            }

            function go(direction) {
                const target = nearest(direction);
                const job = currentJob();
                if (target === null || !job) return;
                dispatch(actionCreators.changeFrameAsync(target, false, undefined, true));
            }

            function updateButtons() {
                const frame = currentFrame();
                for (const [button, direction] of [[prevButton, 'prev'], [nextButton, 'next']]) {
                    if (!button) continue;
                    const target = nearest(direction);
                    const enabled = target !== null && typeof frame === 'number';
                    button.style.opacity = enabled ? '1' : '0.3';
                    button.style.pointerEvents = enabled ? 'auto' : 'none';
                    button.title = enabled
                        ? `${direction === 'next' ? '\u4e0b\u4e00\u4e2a' : '\u4e0a\u4e00\u4e2a'}\u5df2\u6807\u6ce8\u5e27\uff08#${target}\uff09`
                        : '\u6ca1\u6709\u66f4\u591a\u5df2\u6807\u6ce8\u7684\u5e27';
                }
            }

            function drawMarkers() {
                const slider = sliderElement();
                if (!canvas || !slider) return;
                const width = slider.offsetWidth;
                const height = 16;
                if (!width) return;
                const ratio = window.devicePixelRatio || 1;
                canvas.width = Math.round(width * ratio);
                canvas.height = Math.round(height * ratio);
                canvas.style.width = `${width}px`;
                canvas.style.height = `${height}px`;
                const ctx = canvas.getContext('2d');
                ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
                ctx.clearRect(0, 0, width, height);
                const total = stopFrame - startFrame + 1;
                if (total <= 0 || !frames.length) return;
                ctx.fillStyle = TICK_COLOR;
                let lastX = -Infinity;
                for (const frame of frames) {
                    const x = Math.round(((frame - startFrame) / total) * width);
                    if (x - lastX < TICK_W) continue; // avoid overdraw on dense ranges
                    ctx.fillRect(x, height - 5, TICK_W, 5);
                    lastX = x;
                }
            }

            function tick() {
                const job = currentJob();
                if (!job) {
                    if (canvas) canvas.style.display = 'none';
                    if (prevButton) prevButton.style.display = 'none';
                    if (nextButton) nextButton.style.display = 'none';
                    return;
                }
                if (!ensureNodes()) return;
                if (canvas) canvas.style.display = '';
                if (prevButton) prevButton.style.display = 'inline-flex';
                if (nextButton) nextButton.style.display = 'inline-flex';
                if (job !== lastJob) {
                    lastJob = job;
                    refreshFrames(job);
                }
                drawMarkers();
                updateButtons();
            }

            const unsubscribe = store.subscribe(() => {
                if (!currentJob()) return;
                ensureNodes();
                updateButtons();
            });
            timers.push(setInterval(() => {
                const job = currentJob();
                if (job) refreshFrames(job);
            }, REFRESH_MS));
            timers.push(setInterval(tick, SCAN_MS));
            const onResize = () => drawMarkers();
            window.addEventListener('resize', onResize);
            const observer = new MutationObserver(() => {
                if (!currentJob()) return;
                if (!canvas || !canvas.isConnected) {
                    ensureNodes();
                    drawMarkers();
                }
                if (!document.querySelector('.cvat-player-buttons')?.contains(prevButton)) {
                    ensureNodes();
                }
                updateButtons();
            });
            observer.observe(document.body, { childList: true, subtree: true });
            tick();

            return {
                name: 'Annotated frame navigation',
                destructor: () => {
                    unsubscribe();
                    timers.forEach((timer) => clearInterval(timer));
                    window.removeEventListener('resize', onResize);
                    observer.disconnect();
                    canvas?.remove();
                    prevButton?.remove();
                    nextButton?.remove();
                    canvas = null; prevButton = null; nextButton = null;
                },
            };
        });
    }

    window.addEventListener('plugins.ready', register, { once: true });
    register();
})();
