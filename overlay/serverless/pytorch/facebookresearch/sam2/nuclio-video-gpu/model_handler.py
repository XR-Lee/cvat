"""Bounded multi-object SAM2 video tracking on CUDA, with shared-GPU locking."""
import fcntl
import hashlib
import os
import secrets
import threading
import time

import numpy as np
import torch
from transformers import Sam2VideoModel, Sam2VideoProcessor

MAX_OBJECTS = 7
MAX_STEPS = 100
MAX_PIXELS = 4096 * 4096


def decode_mask(points, width, height):
    if not isinstance(points, list) or len(points) < 6:
        raise ValueError('A nonempty CVAT RLE mask is required')
    if width * height > MAX_PIXELS or len(points) > MAX_PIXELS + 5:
        raise ValueError('Mask exceeds pixel limit')
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not np.isfinite(v) or int(v) != v for v in points):
        raise ValueError('Mask values must be finite integers')
    counts = list(map(int, points[:-4]))
    x1, y1, x2, y2 = map(int, points[-4:])
    if not (0 <= x1 <= x2 < width and 0 <= y1 <= y2 < height):
        raise ValueError('Invalid mask bbox')
    if any(n < 0 for n in counts) or sum(counts) != (x2-x1+1)*(y2-y1+1) or not sum(counts[1::2]):
        raise ValueError('Invalid/empty mask RLE')
    flat = np.repeat((np.arange(len(counts)) % 2).astype(np.uint8), counts)
    bitmap = np.zeros((height, width), dtype=bool)
    bitmap[y1:y2+1, x1:x2+1] = flat.reshape(y2-y1+1, x2-x1+1)
    return bitmap


def encode_mask(bitmap):
    bitmap = np.asarray(bitmap, dtype=bool)
    ys, xs = bitmap.nonzero()
    if not len(xs):
        return None
    x1, y1, x2, y2 = int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())
    flat = bitmap[y1:y2+1, x1:x2+1].ravel()
    transitions = np.flatnonzero(flat[1:] != flat[:-1]) + 1
    counts = np.diff(np.r_[0, transitions, flat.size]).tolist()
    if flat[0]:
        counts.insert(0, 0)
    return counts + [x1, y1, x2, y2]


class ModelHandler:
    def __init__(self):
        torch.set_num_threads(4)
        self.device = 'cuda'
        if not torch.cuda.is_available():
            raise RuntimeError('CUDA required; refusing silent CPU fallback')
        torch.cuda.set_per_process_memory_fraction(0.35)
        self.dtype = torch.bfloat16
        model_id = os.environ.get('MODEL_ID', 'facebook/sam2.1-hiera-large')
        self.processor = Sam2VideoProcessor.from_pretrained(model_id, local_files_only=True)
        # Keep idle weights on CPU. The cooperative GPU lock is acquired before
        # moving weights or inference state to CUDA, and held until release.
        self.model = Sam2VideoModel.from_pretrained(model_id, local_files_only=True).eval()
        self.lock = threading.RLock()
        self.item = None
        self.gpu_lock = None
        self.ttl = 90
        threading.Thread(target=self._reaper, daemon=True).start()

    def _acquire_gpu(self):
        path = os.environ.get('GPU_LOCK_PATH')
        if not path:
            raise RuntimeError('GPU_LOCK_PATH must be configured')
        handle = open(path, 'a+')
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            handle.close()
            raise ValueError('GPU is busy with another research job. Retry later; no annotations were changed')
        self.gpu_lock = handle

    def _release(self):
        self.item = None
        try:
            if self.gpu_lock is not None:
                self.model.to('cpu')
                torch.cuda.empty_cache()
        finally:
            if self.gpu_lock is not None:
                fcntl.flock(self.gpu_lock, fcntl.LOCK_UN)
                self.gpu_lock.close()
                self.gpu_lock = None

    def _reaper(self):
        while True:
            time.sleep(10)
            with self.lock:
                if self.item and time.monotonic() - self.item['touched'] > self.ttl:
                    self._release()

    def _states(self, sid, step, count):
        return [{'session': sid, 'step': step, 'object': i+1} for i in range(count)]

    def track(self, image, shapes, states):
        with self.lock, torch.inference_mode():
            if self.item and time.monotonic() - self.item['touched'] > self.ttl:
                self._release()
            if not states:
                if not 1 <= len(shapes) <= MAX_OBJECTS:
                    raise ValueError(f'Select 1–{MAX_OBJECTS} saved masks')
                if any(not isinstance(s, dict) or s.get('type') != 'mask' for s in shapes):
                    raise ValueError('Only masks are supported')
                bitmaps = [decode_mask(s.get('points'), *image.size) for s in shapes]
                if self.item:
                    raise ValueError('GPU video tracker is serving another session; retry later')
                self._acquire_gpu()
                try:
                    self.model.to(self.device)
                    session = self.processor.init_video_session(inference_device=self.device, dtype=self.dtype)
                    session.video_height, session.video_width = image.height, image.width
                    obj_ids = list(range(1, len(shapes)+1))
                    self.processor.add_inputs_to_inference_session(session, frame_idx=0, obj_ids=obj_ids, input_masks=bitmaps)
                    frame = self.processor(images=image, return_tensors='pt')['pixel_values'][0]
                    with torch.autocast('cuda', dtype=self.dtype):
                        self.model(inference_session=session, frame=frame, frame_idx=0)
                    torch.cuda.synchronize()
                    sid = secrets.token_urlsafe(32)
                    self.item = {'sid': sid, 'session': session, 'step': 0, 'size': image.size,
                                 'count': len(shapes), 'touched': time.monotonic(), 'last': None}
                    return {'shapes': [{'type': 'mask', 'points': s['points']} for s in shapes],
                            'states': self._states(sid, 0, len(shapes)), 'device': 'cuda',
                            'objects': obj_ids}
                except Exception:
                    self._release()
                    raise

            if not 1 <= len(states) <= MAX_OBJECTS or any(not isinstance(s, dict) or set(s) != {'session','step','object'} for s in states):
                raise ValueError('Invalid tracking state')
            sid, step = states[0]['session'], states[0]['step']
            if not isinstance(sid, str) or type(step) is not int or step < 0:
                raise ValueError('Invalid state types')
            if any(s['session'] != sid or type(s['step']) is not int or s['step'] != step or type(s['object']) is not int or s['object'] != i+1 for i,s in enumerate(states)):
                raise ValueError('States mixed or reordered; restart from saved masks')
            item = self.item
            if not item or item['sid'] != sid:
                raise ValueError('Video session expired/restarted. Run again from saved masks')
            if len(states) != item['count']:
                raise ValueError('Object count changed')
            if shapes and all(isinstance(s,dict) and s.get('type') == 'mask' and s.get('points') == [] for s in shapes) and len(shapes) == len(states):
                self._release()
                return {'shapes':[None]*len(states), 'states':states, 'device':'cuda'}
            if image.size != item['size']:
                raise ValueError('Frame dimensions changed')
            digest = hashlib.sha256(image.tobytes()).digest()
            if step == item['step']-1 and item['last'] is not None:
                if digest != item['last_digest']:
                    raise ValueError('Retry uses a different frame')
                item['touched'] = time.monotonic()
                return item['last']
            if step != item['step'] or step >= MAX_STEPS:
                raise ValueError(f'Out-of-order state or {MAX_STEPS}-frame limit exceeded')
            try:
                frame = self.processor(images=image, return_tensors='pt')['pixel_values'][0]
                with torch.autocast('cuda', dtype=self.dtype):
                    output = self.model(inference_session=item['session'], frame=frame, frame_idx=step+1)
                    masks = self.processor.post_process_masks([output.pred_masks], original_sizes=[[image.height,image.width]])[0]
                if masks.shape[0] != item['count']:
                    raise RuntimeError('Model object count mismatch')
                result_shapes = []
                for mask in masks:
                    points = encode_mask(mask.squeeze(0).cpu().numpy() > 0)
                    result_shapes.append({'type':'mask','points':points} if points else None)
                torch.cuda.synchronize()
                result = {'shapes': result_shapes, 'states': self._states(sid, step+1, item['count']), 'device':'cuda',
                          'objects': list(range(1,item['count']+1))}
                item.update(step=step+1, touched=time.monotonic(), last=result, last_digest=digest)
                item['session'].processed_frames = {step+1:item['session'].processed_frames[step+1]}
                return result
            except Exception:
                self._release()
                raise
