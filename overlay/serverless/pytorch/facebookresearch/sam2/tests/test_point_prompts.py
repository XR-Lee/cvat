"""Regression tests for the Transformers 4.57 SAM2 point/box contract.

Run with the dependencies/cache of the SAM Nuclio image. No weight loading.
"""
import importlib.util
import os
from pathlib import Path
import unittest

import numpy as np
from transformers import Sam2Processor

MODULE = Path(os.environ.get("SAM_HANDLER_PATH", Path(__file__).parents[1] / "nuclio/model_handler.py"))
spec = importlib.util.spec_from_file_location("point_handler", MODULE)
handler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handler)


class PointPromptContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.processor = Sam2Processor.from_pretrained(
            "facebook/sam2.1-hiera-large", local_files_only=True
        )

    def test_coordinate_pairs_are_lists(self):
        self.assertEqual(handler._pairs([(12, 34), [56, 78]]), [[12.0, 34.0], [56.0, 78.0]])
        self.assertEqual(handler._pairs(None), [])

    def test_real_processor_accepts_point_and_box_combinations(self):
        for positive, negative, box in (
            ([[480, 272]], [], None),
            ([[480, 272], [490, 280]], [[300, 100]], None),
            ([], [[300, 100]], None),
            ([], [], [[[200, 100, 700, 450]]]),
            ([[480, 272]], [[300, 100]], [[[200, 100, 700, 450]]]),
        ):
            with self.subTest(positive=positive, negative=negative, box=box):
                pos, neg = handler._pairs(positive), handler._pairs(negative)
                inputs = self.processor(
                    original_sizes=[[544, 960]],
                    input_points=[[[*pos, *neg]]] if pos or neg else None,
                    input_labels=[[[1] * len(pos) + [0] * len(neg)]] if pos or neg else None,
                    input_boxes=box,
                    return_tensors="pt",
                )
                if pos or neg:
                    self.assertEqual(tuple(inputs["input_points"].shape), (1, 1, len(pos) + len(neg), 2))
                    self.assertEqual(inputs["input_labels"].tolist(), [[[1] * len(pos) + [0] * len(neg)]])
                if box:
                    self.assertEqual(tuple(inputs["input_boxes"].shape), (1, 1, 4))

    def test_rle_roundtrip(self):
        rng = np.random.default_rng(42)
        for bitmap in (np.ones((5, 7), dtype=bool), rng.random((13, 17)) > 0.6):
            encoded = handler.encode_mask(bitmap)
            counts = encoded[:-4]
            x1, y1, x2, y2 = encoded[-4:]
            cropped = bitmap[y1:y2 + 1, x1:x2 + 1]
            decoded = np.repeat(np.arange(len(counts)) % 2, counts).reshape(cropped.shape)
            np.testing.assert_array_equal(decoded, cropped)


if __name__ == "__main__":
    unittest.main(verbosity=2)
