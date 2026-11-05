import hashlib
import os

import numpy as np
import torch
from PIL import Image
from transformers import Sam2Model, Sam2Processor


def encode_mask(bitmap):
    bitmap = np.asanyarray(bitmap)
    if bitmap.ndim != 2:
        raise ValueError("bitmap must have 2 dimensions")
    if bitmap.dtype != np.bool_:
        bitmap = bitmap.astype(bool)

    nz_y, nz_x = bitmap.nonzero()
    if nz_x.size == 0 or nz_y.size == 0:
        return [0, 0, 0, 0, 0]

    x1 = int(nz_x.min())
    y1 = int(nz_y.min())
    x2 = int(nz_x.max()) + 1
    y2 = int(nz_y.max()) + 1
    flat = bitmap[y1:y2, x1:x2].ravel()
    (run_indices,) = np.diff(flat, prepend=[not flat[0]], append=[not flat[-1]]).nonzero()
    if flat[0]:
        run_lengths = np.diff(run_indices, prepend=[0])
    else:
        run_lengths = np.diff(run_indices)
    return run_lengths.tolist() + [x1, y1, x2 - 1, y2 - 1]


def _pairs(points):
    if not points:
        return []
    pairs = []
    for point in points:
        if isinstance(point, (list, tuple)) and len(point) >= 2:
            # Sam2Processor counts list nesting only; tuple coordinates are
            # misread as a missing dimension and make every point prompt fail.
            pairs.append([float(point[0]), float(point[1])])
    return pairs


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

    def handle(self, image: Image.Image, raw: bytes, pos_points, neg_points, obj_bbox):
        positive = _pairs(pos_points)
        negative = _pairs(neg_points)
        box_points = _pairs(obj_bbox)
        if not positive and not negative and len(box_points) < 2:
            return []

        self._set_image(image, raw)

        input_points = None
        input_labels = None
        if positive or negative:
            input_points = [[[*positive, *negative]]]
            input_labels = [[[1] * len(positive) + [0] * len(negative)]]

        input_boxes = None
        if len(box_points) >= 2:
            x1, y1 = box_points[0]
            x2, y2 = box_points[1]
            input_boxes = [[[min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)]]]

        prompt_inputs = self.processor(
            original_sizes=self._original_sizes,
            input_boxes=input_boxes,
            input_points=input_points,
            input_labels=input_labels,
            return_tensors="pt",
        )
        prompt_inputs = {
            key: value.to(self.device) if torch.is_tensor(value) else value
            for key, value in prompt_inputs.items()
        }

        with torch.inference_mode():
            outputs = self.model(
                image_embeddings=self._embeddings,
                multimask_output=True,
                **prompt_inputs,
            )

        masks = self.processor.post_process_masks(
            outputs.pred_masks.cpu(),
            self._original_sizes,
        )[0][0]
        scores = outputs.iou_scores.detach().cpu().reshape(-1)
        best = int(torch.argmax(scores).item()) if scores.numel() else 0
        mask = masks[best].numpy() > 0
        return encode_mask(mask)
