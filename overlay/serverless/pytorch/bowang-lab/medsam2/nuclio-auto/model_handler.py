"""Auto-labeling: Grounding DINO boxes (identical to the SAM 2.1 detector) + MedSAM2 masks.

Detection (PROMPTS, _detect, _match_label, threshold clamp and limits) is copied
verbatim from serverless/pytorch/facebookresearch/sam2/nuclio-auto/model_handler.py
and uses the same pinned Grounding DINO revision, so both detectors produce the
same labels, scores and boxes. Only the in-box mask comes from MedSAM2, via the
official SAM2ImagePredictor with a box prompt. MedSAM2 does not read the label
text; class identity comes entirely from Grounding DINO.
"""
import os
import sys

import numpy as np
import torch
from PIL import Image
from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

sys.path.insert(0, os.environ.get('MEDSAM2_ROOT', '/opt/medsam2'))
from sam2.build_sam import build_sam2  # noqa: E402
from sam2.sam2_image_predictor import SAM2ImagePredictor  # noqa: E402

MEDSAM2_CONFIG = 'configs/sam2.1_hiera_t512.yaml'

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
        torch.set_num_threads(int(os.environ.get('TORCH_NUM_THREADS', '10')))
        self.device = torch.device("cpu")
        dino_id = os.environ.get("DINO_ID", "IDEA-Research/grounding-dino-tiny")
        revision = os.environ.get("DINO_REVISION")
        self.dino_processor = AutoProcessor.from_pretrained(dino_id, revision=revision)
        self.dino = AutoModelForZeroShotObjectDetection.from_pretrained(dino_id, revision=revision).to(self.device).eval()
        root = os.environ.get('MEDSAM2_ROOT', '/opt/medsam2')
        medsam2 = build_sam2(config_file=MEDSAM2_CONFIG, ckpt_path=os.path.join(root, 'weights', 'MedSAM2_latest.pt'),
                             device='cpu', apply_postprocessing=False)
        self.predictor = SAM2ImagePredictor(medsam2)

    def handle(self, image: Image.Image, threshold: float):
        detect_threshold = min(max(float(threshold or 0.25), 0.05), 0.30)
        boxes = self._detect(image, detect_threshold)
        if not boxes:
            return []
        with torch.inference_mode():
            self.predictor.set_image(np.asarray(image.convert("RGB")))
            results = []
            for label, score, box in boxes:
                mask = self._segment_box(box)
                if mask is None:
                    continue
                results.append({"confidence": f"{score:.4f}", "label": label, "mask": mask, "type": "mask"})
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

    def _segment_box(self, box):
        # Box prompts are unambiguous, so a single mask is requested (as in the SAM 2.1 detector).
        masks, _, _ = self.predictor.predict(box=np.asarray(box, dtype=np.float32), multimask_output=False)
        return _detector_mask(masks[0] > 0)


def _match_label(text):
    normalized = text.lower().replace("_", " ").strip(" .")
    for chinese, english in PROMPTS:
        if english in normalized or normalized in english:
            return chinese
    return None


def _detector_mask(mask):
    """CVAT detector wire format: cropped bitmap followed by inclusive bbox."""
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
