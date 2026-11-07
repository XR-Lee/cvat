"""Stateful SAM2 video-memory propagation, not repeated image box prompting."""
import hashlib
import os
import secrets
import threading
import time
from collections import OrderedDict

import numpy as np
import torch
from transformers import Sam2VideoModel, Sam2VideoProcessor


MAX_PIXELS = 4096 * 4096


def decode_mask(points, width, height):
    """Strict CVAT RLE validation before allocating or initializing video state."""
    if not isinstance(points, list) or len(points) < 6:
        raise ValueError("A nonempty CVAT RLE mask is required")
    if width * height > MAX_PIXELS:
        raise ValueError("Frame exceeds the supported pixel limit")
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not np.isfinite(v) or int(v) != v for v in points):
        raise ValueError("RLE values must be finite integers")
    counts = [int(v) for v in points[:-4]]
    x1, y1, x2, y2 = map(int, points[-4:])
    if not (0 <= x1 <= x2 < width and 0 <= y1 <= y2 < height):
        raise ValueError("Mask bbox is outside the frame")
    if any(n < 0 for n in counts) or sum(counts) != (x2-x1+1)*(y2-y1+1):
        raise ValueError("Invalid RLE run lengths")
    if not sum(counts[1::2]):
        raise ValueError("Cannot initialize from an empty mask")
    crop = np.repeat(np.arange(len(counts)) % 2, counts).reshape(y2-y1+1, x2-x1+1)
    bitmap = np.zeros((height, width), dtype=bool)
    bitmap[y1:y2+1, x1:x2+1] = crop
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
        torch.set_num_threads(int(os.environ.get("TORCH_NUM_THREADS", "4")))
        self.processor = Sam2VideoProcessor.from_pretrained(os.environ.get("MODEL_ID", "facebook/sam2.1-hiera-large"))
        self.model = Sam2VideoModel.from_pretrained(os.environ.get("MODEL_ID", "facebook/sam2.1-hiera-large")).to("cpu").eval()
        self.sessions = OrderedDict()
        self.lock = threading.RLock()
        self.ttl = int(os.environ.get("SESSION_TTL", "180"))
        self.max_sessions = 2
        self.max_steps = 50
        threading.Thread(target=self._reaper, daemon=True).start()

    def _reaper(self):
        while True:
            time.sleep(30)
            with self.lock:
                self._expire()

    def _expire(self):
        now = time.monotonic()
        for key in list(self.sessions):
            if now - self.sessions[key]["touched"] > self.ttl:
                del self.sessions[key]

    def track(self, image, shape, state):
        with self.lock, torch.inference_mode():
            self._expire()
            if state is None:
                if not isinstance(shape, dict) or shape.get("type") != "mask":
                    raise ValueError("Initialize with a mask, not a rectangle or polygon")
                bitmap = decode_mask(shape.get("points"), *image.size)
                if len(self.sessions) >= self.max_sessions:
                    raise ValueError("Video tracker is busy (2 active sessions). Wait up to 3 minutes and retry")
                sid = secrets.token_urlsafe(32)
                session = self.processor.init_video_session(inference_device="cpu", dtype=torch.float32)
                session.video_height, session.video_width = image.height, image.width
                self.processor.add_inputs_to_inference_session(session, frame_idx=0, obj_ids=1, input_masks=bitmap)
                frame = self.processor(images=image, return_tensors="pt")["pixel_values"][0]
                # This encodes the supplied mask into temporal memory for frame 0.
                self.model(inference_session=session, frame=frame, frame_idx=0)
                self.sessions[sid] = {"session": session, "step": 0, "size": image.size,
                                      "touched": time.monotonic(), "last": None}
                # Never modify the user's seed mask during initialization.
                return {"type": "mask", "points": shape["points"]}, {"session": sid, "step": 0}

            if not isinstance(state, dict) or set(state) != {"session", "step"}:
                raise ValueError("Invalid video state")
            sid, step = state["session"], state["step"]
            if not isinstance(sid, str) or type(step) is not int:
                raise ValueError("Invalid video state types")
            # Release uses the already CVAT-signed session token plus an explicit
            # empty mask control shape; it never changes any annotations.
            if isinstance(shape, dict) and shape.get("type") == "mask" and shape.get("points") == []:
                self.sessions.pop(sid, None)
                return None, {"session": sid, "step": step}
            item = self.sessions.get(sid)
            if item is None:
                raise ValueError("Video session expired or service restarted. Run again from the saved mask")
            if image.size != item["size"]:
                raise ValueError("Video frame dimensions changed")
            # A lost HTTP response may cause an exact retry with the old signed state.
            # Cache the last result without advancing temporal memory twice.
            image_digest = hashlib.sha256(image.tobytes()).digest()
            if step == item["step"] - 1 and item["last"] is not None:
                if image_digest != item["last_digest"]:
                    raise ValueError("Retry contains a different frame")
                item["touched"] = time.monotonic()
                return item["last"]
            if step != item["step"]:
                raise ValueError("Out-of-order video state. Restart propagation")
            if step >= self.max_steps:
                raise ValueError("Maximum 50 propagated frames per run")
            session = item["session"]
            try:
                frame = self.processor(images=image, return_tensors="pt")["pixel_values"][0]
                output = self.model(inference_session=session, frame=frame, frame_idx=step+1)
                masks = self.processor.post_process_masks([output.pred_masks], original_sizes=[[image.height, image.width]])[0]
                while masks.ndim > 2:
                    masks = masks[0]
                points = encode_mask(masks.cpu().numpy() > 0)
            except Exception:
                # Partial model mutation must not be reused after an inference error.
                self.sessions.pop(sid, None)
                raise
            result = ({"type": "mask", "points": points} if points else None,
                      {"session": sid, "step": step+1})
            item.update(step=step+1, touched=time.monotonic(), last=result, last_digest=image_digest)
            # Streamed frame tensors are no longer needed after their features have
            # been encoded; temporal masks/memory remain in output_dict_per_obj.
            session.processed_frames = {step+1: session.processed_frames[step+1]}
            return result
