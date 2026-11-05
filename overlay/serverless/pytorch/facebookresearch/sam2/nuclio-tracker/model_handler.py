import hashlib
import os

import numpy as np
import torch
from PIL import Image
from transformers import Sam2Model, Sam2Processor


class ModelHandler:
    def __init__(self):
        model_id = os.environ.get("MODEL_ID", "facebook/sam2.1-hiera-large")
        self.device = torch.device("cpu")
        self.processor = Sam2Processor.from_pretrained(model_id)
        self.model = Sam2Model.from_pretrained(model_id)
        self.model.to(self.device)
        self.model.eval()
        self._cache_key = None
        self._embeddings = None
        self._original_sizes = None

    def track(self, image: Image.Image, raw: bytes, shape, state):
        previous = _box_from_state(state) or _box_from_shape(shape)
        if previous is None:
            return None, state
        prompt = _expand_box(previous, image.size, 0.35 if state else 0.0)
        refined = self._segment_box(image, raw, prompt) or previous
        return _rectangle(refined), {"box": refined}

    def _segment_box(self, image: Image.Image, raw: bytes, box):
        self._set_image(image, raw)
        x1, y1, x2, y2 = box
        prompt_inputs = self.processor(
            original_sizes=self._original_sizes,
            input_boxes=[[[x1, y1, x2, y2]]],
            return_tensors="pt",
        )
        prompt_inputs = {
            key: value.to(self.device) if torch.is_tensor(value) else value
            for key, value in prompt_inputs.items()
        }
        with torch.inference_mode():
            outputs = self.model(
                image_embeddings=self._embeddings,
                multimask_output=False,
                **prompt_inputs,
            )
        masks = self.processor.post_process_masks(
            outputs.pred_masks.cpu(),
            self._original_sizes,
        )[0]
        while masks.ndim > 3:
            masks = masks[0]
        if masks.ndim == 2:
            masks = masks.unsqueeze(0)
        mask = masks[0].numpy() > 0
        if int(mask.sum()) < 16:
            return None
        ys, xs = np.nonzero(mask)
        return [float(xs.min()), float(ys.min()), float(xs.max()), float(ys.max())]

    def _set_image(self, image: Image.Image, raw: bytes):
        key = hashlib.sha256(raw).digest()
        if key == self._cache_key:
            return
        inputs = self.processor(images=image, return_tensors="pt")
        with torch.inference_mode():
            embeddings = self.model.get_image_embeddings(inputs["pixel_values"].to(self.device))
        self._embeddings = embeddings
        self._original_sizes = inputs["original_sizes"]
        self._cache_key = key


def _box_from_state(state):
    if not isinstance(state, dict):
        return None
    box = state.get("box")
    return _normalize_box(box)


def _box_from_shape(shape):
    if shape is None:
        return None
    if isinstance(shape, dict):
        points = shape.get("points") or []
    elif isinstance(shape, list):
        points = shape
    else:
        return None
    if len(points) < 4:
        return None
    xs = [float(points[i]) for i in range(0, len(points), 2)]
    ys = [float(points[i]) for i in range(1, len(points), 2)]
    return _normalize_box([min(xs), min(ys), max(xs), max(ys)])


def _normalize_box(box):
    if not box or len(box) < 4:
        return None
    x1, y1, x2, y2 = map(float, box[:4])
    if x2 < x1:
        x1, x2 = x2, x1
    if y2 < y1:
        y1, y2 = y2, y1
    if x2 - x1 < 2 or y2 - y1 < 2:
        return None
    return [x1, y1, x2, y2]


def _expand_box(box, size, scale):
    x1, y1, x2, y2 = box
    width, height = size
    grow_x = (x2 - x1) * scale
    grow_y = (y2 - y1) * scale
    return [
        max(0.0, x1 - grow_x),
        max(0.0, y1 - grow_y),
        min(float(width - 1), x2 + grow_x),
        min(float(height - 1), y2 + grow_y),
    ]


def _rectangle(box):
    return {"type": "rectangle", "points": box}
