"""MedSAM2 point/box interactor using the official SAM2ImagePredictor (CPU).

MedSAM2_latest is SAM2.1 Hiera-Tiny at 512 px, so the image encoder is fast on
CPU; running here avoids competing with research jobs for the shared GPU lock.
"""
import hashlib
import os
import sys
import threading

import numpy as np
import torch

sys.path.insert(0, os.environ.get('MEDSAM2_ROOT', '/opt/medsam2'))
from sam2.build_sam import build_sam2  # noqa: E402
from sam2.sam2_image_predictor import SAM2ImagePredictor  # noqa: E402

CONFIG = 'configs/sam2.1_hiera_t512.yaml'


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


def pairs(points):
    out = []
    for point in points or []:
        if isinstance(point, (list, tuple)) and len(point) >= 2:
            x, y = float(point[0]), float(point[1])
            if not (np.isfinite(x) and np.isfinite(y)):
                raise ValueError('Prompt coordinates must be finite')
            out.append([x, y])
    return out


class ModelHandler:
    def __init__(self):
        torch.set_num_threads(int(os.environ.get('TORCH_NUM_THREADS', '6')))
        root = os.environ.get('MEDSAM2_ROOT', '/opt/medsam2')
        model = build_sam2(config_file=CONFIG, ckpt_path=os.path.join(root, 'weights', 'MedSAM2_latest.pt'),
                           device='cpu', apply_postprocessing=False)
        self.predictor = SAM2ImagePredictor(model)
        self.lock = threading.Lock()
        self.key = None

    def handle(self, image, raw, pos_points, neg_points, obj_bbox):
        positive, negative, box_points = pairs(pos_points), pairs(neg_points), pairs(obj_bbox)
        if not positive and not negative and len(box_points) < 2:
            return None
        with self.lock, torch.inference_mode():
            key = hashlib.sha256(raw).digest()
            if key != self.key:  # cache the image embedding for repeated clicks on a frame
                self.predictor.set_image(np.asarray(image))
                self.key = key
            coords = labels = box = None
            if positive or negative:
                coords = np.array(positive + negative, dtype=np.float32)
                labels = np.array([1] * len(positive) + [0] * len(negative), dtype=np.int32)
            if len(box_points) >= 2:
                (x1, y1), (x2, y2) = box_points[0], box_points[1]
                box = np.array([min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)], dtype=np.float32)
            masks, scores, _ = self.predictor.predict(point_coords=coords, point_labels=labels, box=box,
                                                      multimask_output=True)
            return encode_mask(masks[int(np.argmax(scores))] > 0)
