import os

import numpy as np
import torch
from PIL import Image
from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor, Sam2Model, Sam2Processor

PROMPTS = (
    ("神经根", "nerve root"),
    ("硬膜囊", "dural sac"),
    ("黄韧带", "ligamentum flavum"),
    ("纤维环", "annulus fibrosus"),
    ("髓核", "nucleus pulposus"),
    ("椎板", "vertebral lamina"),
    ("关节突", "facet joint"),
    ("硬膜外脂肪", "epidural fat"),
    ("血管", "blood vessel"),
    ("抓钳", "grasping forceps"),
    ("双极电凝", "bipolar forceps"),
    ("磨钻", "surgical drill"),
    ("咬骨钳", "rongeur"),
    ("神经探钩", "nerve hook"),
)


class ModelHandler:
    def __init__(self):
        self.device = torch.device("cpu")
        sam_id = os.environ.get("MODEL_ID", "facebook/sam2.1-hiera-large")
        dino_id = os.environ.get("DINO_ID", "IDEA-Research/grounding-dino-tiny")
        self.sam_processor = Sam2Processor.from_pretrained(sam_id)
        self.sam = Sam2Model.from_pretrained(sam_id).to(self.device).eval()
        self.dino_processor = AutoProcessor.from_pretrained(dino_id)
        self.dino = AutoModelForZeroShotObjectDetection.from_pretrained(dino_id).to(self.device).eval()
        self._cache_key = None
        self._embeddings = None
        self._original_sizes = None

    def handle(self, image: Image.Image, threshold: float):
        detect_threshold = min(max(float(threshold or 0.25), 0.05), 0.30)
        boxes = self._detect(image, detect_threshold)
        if not boxes:
            return []
        self._set_image(image)
        results = []
        for label, score, box in boxes:
            mask = self._segment_box(box)
            if mask is None:
                continue
            results.append(
                {
                    "confidence": f"{score:.4f}",
                    "label": label,
                    "mask": mask,
                    "type": "mask",
                }
            )
        return results

    def _detect(self, image: Image.Image, threshold: float):
        text = ". ".join(prompt for _, prompt in PROMPTS) + "."
        inputs = self.dino_processor(images=image, text=text, return_tensors="pt").to(self.device)
        with torch.inference_mode():
            outputs = self.dino(**inputs)
        processed = self.dino_processor.post_process_grounded_object_detection(
            outputs,
            inputs.input_ids,
            threshold=threshold,
            text_threshold=threshold,
            target_sizes=[image.size[::-1]],
        )[0]
        labels = processed.get("text_labels") or processed.get("labels") or []
        scores = processed["scores"].detach().cpu().tolist()
        boxes = processed["boxes"].detach().cpu().tolist()
        found = []
        counts = {}
        for raw_label, score, box in zip(labels, scores, boxes):
            label = _match_label(str(raw_label))
            if label is None or counts.get(label, 0) >= 2:
                continue
            counts[label] = counts.get(label, 0) + 1
            found.append((label, float(score), [float(value) for value in box]))
            if len(found) >= 12:
                break
        return found

    def _set_image(self, image: Image.Image):
        encoded = np.asarray(image.resize((160, 120))).tobytes()
        key = hash(encoded)
        if key == self._cache_key:
            return
        inputs = self.sam_processor(images=image, return_tensors="pt")
        with torch.inference_mode():
            embeddings = self.sam.get_image_embeddings(inputs["pixel_values"].to(self.device))
        self._embeddings = embeddings
        self._original_sizes = inputs["original_sizes"]
        self._cache_key = key

    def _segment_box(self, box):
        x1, y1, x2, y2 = box
        prompt_inputs = self.sam_processor(
            original_sizes=self._original_sizes,
            input_boxes=[[[x1, y1, x2, y2]]],
            return_tensors="pt",
        )
        prompt_inputs = {
            key: value.to(self.device) if torch.is_tensor(value) else value
            for key, value in prompt_inputs.items()
        }
        with torch.inference_mode():
            outputs = self.sam(
                image_embeddings=self._embeddings,
                multimask_output=False,
                **prompt_inputs,
            )
        masks = self.sam_processor.post_process_masks(
            outputs.pred_masks.cpu(),
            self._original_sizes,
        )[0]
        while masks.ndim > 3:
            masks = masks[0]
        if masks.ndim == 2:
            masks = masks.unsqueeze(0)
        mask = masks[0].numpy() > 0
        return _detector_mask(mask)


def _match_label(text):
    normalized = text.lower().replace("_", " ").strip(" .")
    for chinese, english in PROMPTS:
        if english in normalized or normalized in english:
            return chinese
    return None


def _detector_mask(mask):
    """CVAT detector wire format: cropped bitmap followed by inclusive bbox.

    Unlike an interactor's RLE points, detector masks must contain raw binary
    pixels. CVAT's AnnotationConverter performs the RLE encoding. Keeping the
    bitmap preserves holes, disconnected components and pixel-level boundaries.
    No polygon fallback is emitted: this function is deliberately mask-only.
    """
    bitmap = np.asarray(mask, dtype=bool)
    if bitmap.ndim != 2:
        raise ValueError("mask must have 2 dimensions")
    if int(bitmap.sum()) < 16:
        return None
    ys, xs = bitmap.nonzero()
    x1, y1 = int(xs.min()), int(ys.min())
    x2, y2 = int(xs.max()), int(ys.max())
    pixels = bitmap[y1:y2 + 1, x1:x2 + 1].astype(np.uint8).ravel().tolist()
    return pixels + [x1, y1, x2, y2]
