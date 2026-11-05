"""MedSAM2 multi-object mask propagation for CVAT, using the official predictor.

The official MedSAM2 SAM2VideoPredictor expects every frame up front. CVAT's
tracker protocol delivers one frame per request, so this module streams frames
into the official inference state and advances the official
``propagate_in_video`` generator one frame at a time. Model code, configuration,
preprocessing, mask prompting, memory and thresholding follow the official
``medsam2_infer_video.py`` path (bf16 autocast, no post-processing, threshold 0).
Parity with the official whole-clip path is verified separately.
"""
import fcntl
import hashlib
import os
import secrets
import shutil
import sys
import tempfile
import threading
import time

import numpy as np
import torch

sys.path.insert(0, os.environ.get('MEDSAM2_ROOT', '/opt/medsam2'))
from sam2.build_sam import build_sam2_video_predictor  # noqa: E402

MAX_OBJECTS = 7
MAX_STEPS = 100
MAX_PIXELS = 4096 * 4096
CONFIG = 'configs/sam2.1_hiera_t512.yaml'
IMG_MEAN = torch.tensor((0.485, 0.456, 0.406), dtype=torch.float32)[:, None, None]
IMG_STD = torch.tensor((0.229, 0.224, 0.225), dtype=torch.float32)[:, None, None]


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
    if any(n < 0 for n in counts) or sum(counts) != (x2 - x1 + 1) * (y2 - y1 + 1) or not sum(counts[1::2]):
        raise ValueError('Invalid/empty mask RLE')
    flat = np.repeat((np.arange(len(counts)) % 2).astype(np.uint8), counts)
    bitmap = np.zeros((height, width), dtype=bool)
    bitmap[y1:y2 + 1, x1:x2 + 1] = flat.reshape(y2 - y1 + 1, x2 - x1 + 1)
    return bitmap


def encode_mask(bitmap):
    bitmap = np.asarray(bitmap, dtype=bool)
    ys, xs = bitmap.nonzero()
    if not len(xs):
        return None
    x1, y1, x2, y2 = int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())
    flat = bitmap[y1:y2 + 1, x1:x2 + 1].ravel()
    transitions = np.flatnonzero(flat[1:] != flat[:-1]) + 1
    counts = np.diff(np.r_[0, transitions, flat.size]).tolist()
    if flat[0]:
        counts.insert(0, 0)
    return counts + [x1, y1, x2, y2]


def preprocess(image, size, device):
    """Exactly sam2.utils.misc._load_img_as_tensor + load_video_frames normalisation.

    Official order: float64 [0,1] -> float32 on CPU, move to the compute device,
    then subtract mean / divide std there.
    """
    img_np = np.array(image.convert('RGB').resize((size, size)))
    if img_np.dtype != np.uint8:
        raise ValueError('Unexpected frame dtype')
    img = torch.from_numpy(img_np / 255.0).permute(2, 0, 1).to(torch.float32).to(device)
    img -= IMG_MEAN.to(device)
    img /= IMG_STD.to(device)
    return img


class StreamingFrames:
    """List-like frame container: official length, frames supplied on demand."""

    def __init__(self, length):
        self.length = length
        self.items = {}

    def __len__(self):
        return self.length

    def put(self, index, tensor):
        self.items[index] = tensor

    def __getitem__(self, index):
        if index not in self.items:
            raise IndexError(f'frame {index} has not been streamed yet')
        return self.items[index]

    def keep_only(self, index):
        for key in list(self.items):
            if key != index:
                del self.items[key]


class ModelHandler:
    def __init__(self):
        torch.set_num_threads(4)
        if not torch.cuda.is_available():
            raise RuntimeError('CUDA required; refusing silent CPU fallback')
        torch.cuda.set_per_process_memory_fraction(0.35)
        root = os.environ.get('MEDSAM2_ROOT', '/opt/medsam2')
        checkpoint = os.path.join(root, 'weights', 'MedSAM2_latest.pt')
        # Official medsam2_infer_video.py defaults: no post-processing. Objects are
        # kept independent (as CVAT objects are), i.e. non_overlap_masks=false.
        self.predictor = build_sam2_video_predictor(
            config_file=CONFIG, ckpt_path=checkpoint, device='cpu', apply_postprocessing=False,
            hydra_overrides_extra=['++model.non_overlap_masks=false'])
        self.predictor.eval()
        self.size = self.predictor.image_size
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
                self.predictor.to('cpu')
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

    @staticmethod
    def _states(sid, step, count):
        return [{'session': sid, 'step': step, 'object': i + 1} for i in range(count)]

    def start(self, raw, image, bitmaps, num_frames):
        """Initialise via the official init_state/add_new_mask/propagate_in_video path."""
        predictor = self.predictor
        workdir = tempfile.mkdtemp(prefix='medsam2-')
        try:
            # Feed the untouched frame bytes through official init_state frame loading.
            # Official vos_inference runs init_state inside bf16 autocast as well.
            with open(os.path.join(workdir, '00000.jpg'), 'wb') as handle:
                handle.write(raw)
            with torch.autocast('cuda', dtype=torch.bfloat16):
                state = predictor.init_state(video_path=workdir, async_loading_frames=False)
        finally:
            shutil.rmtree(workdir, ignore_errors=True)
        if (state['video_width'], state['video_height']) != image.size:
            raise ValueError('Frame size mismatch')
        frames = StreamingFrames(num_frames)
        frames.put(0, state['images'][0])
        state['images'] = frames
        state['num_frames'] = num_frames
        with torch.autocast('cuda', dtype=torch.bfloat16):
            for obj_id, bitmap in enumerate(bitmaps, start=1):
                predictor.add_new_mask(inference_state=state, frame_idx=0, obj_id=obj_id, mask=bitmap)
            generator = predictor.propagate_in_video(state)
            frame_idx, obj_ids, _ = next(generator)  # conditioning frame; runs official preflight
        if frame_idx != 0 or list(obj_ids) != list(range(1, len(bitmaps) + 1)):
            raise RuntimeError('Unexpected initial MedSAM2 output')
        return state, generator

    def step(self, item, image, index):
        frames = item['state']['images']
        frames.put(index, preprocess(image, self.size, item['state']['device']))
        with torch.autocast('cuda', dtype=torch.bfloat16):
            try:
                frame_idx, obj_ids, video_res_masks = next(item['generator'])
            except StopIteration:
                raise ValueError('Planned frame count exhausted') from None
        if frame_idx != index or len(obj_ids) != item['count']:
            raise RuntimeError('MedSAM2 frame/object mismatch')
        frames.keep_only(index)
        masks = (video_res_masks > 0.0).cpu().numpy()
        return [encode_mask(masks[i, 0]) for i in range(item['count'])]

    def track(self, raw, image, shapes, states):
        with self.lock, torch.inference_mode():
            if self.item and time.monotonic() - self.item['touched'] > self.ttl:
                self._release()
            if not states:
                if not 1 <= len(shapes) <= MAX_OBJECTS:
                    raise ValueError(f'Select 1–{MAX_OBJECTS} saved masks')
                if any(not isinstance(s, dict) or s.get('type') != 'mask' for s in shapes):
                    raise ValueError('Only masks are supported')
                planned = shapes[0].get('frames', MAX_STEPS)
                if type(planned) is not int or not 1 <= planned <= MAX_STEPS or any(s.get('frames', MAX_STEPS) != planned for s in shapes):
                    raise ValueError(f'Planned frames must be one integer in 1–{MAX_STEPS}')
                bitmaps = [decode_mask(s.get('points'), *image.size) for s in shapes]
                if self.item:
                    raise ValueError('GPU video tracker is serving another session; retry later')
                self._acquire_gpu()
                try:
                    self.predictor.to('cuda')
                    state, generator = self.start(raw, image, bitmaps, planned + 1)
                    torch.cuda.synchronize()
                    sid = secrets.token_urlsafe(32)
                    self.item = {'sid': sid, 'state': state, 'generator': generator, 'step': 0,
                                 'planned': planned, 'size': image.size, 'count': len(shapes),
                                 'touched': time.monotonic(), 'last': None}
                    return {'shapes': [{'type': 'mask', 'points': s['points']} for s in shapes],
                            'states': self._states(sid, 0, len(shapes)), 'device': 'cuda',
                            'model': 'MedSAM2_latest', 'objects': list(range(1, len(shapes) + 1))}
                except Exception:
                    self._release()
                    raise

            if not 1 <= len(states) <= MAX_OBJECTS or any(not isinstance(s, dict) or set(s) != {'session', 'step', 'object'} for s in states):
                raise ValueError('Invalid tracking state')
            sid, step = states[0]['session'], states[0]['step']
            if not isinstance(sid, str) or type(step) is not int or step < 0:
                raise ValueError('Invalid state types')
            if any(s['session'] != sid or type(s['step']) is not int or s['step'] != step or type(s['object']) is not int or s['object'] != i + 1 for i, s in enumerate(states)):
                raise ValueError('States mixed or reordered; restart from saved masks')
            item = self.item
            if not item or item['sid'] != sid:
                raise ValueError('Video session expired/restarted. Run again from saved masks')
            if len(states) != item['count']:
                raise ValueError('Object count changed')
            if shapes and len(shapes) == len(states) and all(isinstance(s, dict) and s.get('type') == 'mask' and s.get('points') == [] for s in shapes):
                self._release()
                return {'shapes': [None] * len(states), 'states': states, 'device': 'cuda', 'model': 'MedSAM2_latest'}
            if image.size != item['size']:
                raise ValueError('Frame dimensions changed')
            digest = hashlib.sha256(image.tobytes()).digest()
            if step == item['step'] - 1 and item['last'] is not None:
                if digest != item['last_digest']:
                    raise ValueError('Retry uses a different frame')
                item['touched'] = time.monotonic()
                return item['last']
            if step != item['step'] or step >= item['planned']:
                raise ValueError(f"Out-of-order state or planned {item['planned']}-frame limit exceeded")
            try:
                points = self.step(item, image, step + 1)
                torch.cuda.synchronize()
            except Exception:
                self._release()
                raise
            result = {'shapes': [{'type': 'mask', 'points': p} if p else None for p in points],
                      'states': self._states(sid, step + 1, item['count']), 'device': 'cuda',
                      'model': 'MedSAM2_latest', 'objects': list(range(1, item['count'] + 1))}
            item.update(step=step + 1, touched=time.monotonic(), last=result, last_digest=digest)
            return result
