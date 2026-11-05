"""Unit tests: SAM bitmap -> CVAT detector wire mask, without model weights."""
import importlib.util
import os
from pathlib import Path
import unittest

import numpy as np

MODULE = Path(os.environ.get("DETECTOR_HANDLER_PATH", Path(__file__).parents[1] / "nuclio-auto/model_handler.py"))
spec = importlib.util.spec_from_file_location("detector_handler", MODULE)
handler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handler)


def decode_wire_mask(encoded, shape):
    x1, y1, x2, y2 = encoded[-4:]
    pixels = np.asarray(encoded[:-4], dtype=np.uint8).reshape(y2 - y1 + 1, x2 - x1 + 1)
    decoded = np.zeros(shape, dtype=np.uint8)
    decoded[y1:y2 + 1, x1:x2 + 1] = pixels
    return decoded


class DetectorMaskTests(unittest.TestCase):
    def test_roundtrip_preserves_holes_and_disconnected_regions(self):
        bitmap = np.zeros((30, 40), dtype=bool)
        bitmap[3:20, 4:25] = True
        bitmap[8:13, 10:15] = False
        bitmap[26:29, 35:39] = True
        encoded = handler._detector_mask(bitmap)
        self.assertEqual(encoded[-4:], [4, 3, 38, 28])
        self.assertEqual(set(encoded[:-4]), {0, 1})
        np.testing.assert_array_equal(decode_wire_mask(encoded, bitmap.shape), bitmap)

    def test_boundary_masks(self):
        for bitmap in (np.ones((4, 4), dtype=bool), np.eye(20, dtype=bool)):
            with self.subTest(shape=bitmap.shape):
                encoded = handler._detector_mask(bitmap)
                np.testing.assert_array_equal(decode_wire_mask(encoded, bitmap.shape), bitmap)

    def test_empty_and_small_masks(self):
        self.assertIsNone(handler._detector_mask(np.zeros((20, 20), dtype=bool)))
        self.assertIsNone(handler._detector_mask(np.ones((3, 5), dtype=bool)))

    def test_rejects_wrong_dimension(self):
        with self.assertRaises(ValueError):
            handler._detector_mask(np.ones((2, 4, 4), dtype=bool))

    def test_handle_emits_mask_not_polygon(self):
        model = handler.ModelHandler.__new__(handler.ModelHandler)
        model._detect = lambda image, threshold: [("神经根", 0.7, [0, 0, 4, 4])]
        model._set_image = lambda image: None
        encoded = handler._detector_mask(np.ones((5, 5), dtype=bool))
        model._segment_box = lambda box: encoded
        result = model.handle(None, 0.25)
        self.assertEqual(result, [{"confidence": "0.7000", "label": "神经根", "mask": encoded, "type": "mask"}])


if __name__ == "__main__":
    unittest.main(verbosity=2)
