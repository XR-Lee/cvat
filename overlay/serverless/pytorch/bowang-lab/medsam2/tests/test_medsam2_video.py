"""Contract tests for the MedSAM2 streaming handler with a fake predictor.

Real-model behaviour is verified separately by bitwise parity against the
official whole-clip path (see .medsam2/eval/parity.py).
"""
import importlib.util
import os
from pathlib import Path
import threading
from types import SimpleNamespace
import unittest

import numpy as np
from PIL import Image
import torch

path = Path(os.environ.get('MEDSAM2_HANDLER_PATH', Path(__file__).parents[1] / 'nuclio-video-gpu/model_handler.py'))
spec = importlib.util.spec_from_file_location('medsam2_handler', path)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Tests(unittest.TestCase):
    def handler(self):
        h = m.ModelHandler.__new__(m.ModelHandler)
        h.lock = threading.RLock(); h.item = None; h.ttl = 90; h.gpu_lock = None; h.size = 8; h.calls = 0
        h.predictor = SimpleNamespace(to=lambda device: None)
        h._acquire_gpu = lambda: None
        h.started = []

        def start(raw, image, bitmaps, num_frames):
            h.started.append((len(bitmaps), num_frames))
            return {'images': None}, iter(())

        def step(item, image, index):
            h.calls += 1
            return [m.encode_mask(np.eye(8, dtype=bool)) for _ in range(item['count'])]

        h.start, h.step = start, step
        return h

    def seeds(self, n):
        out = []
        for i in range(n):
            bitmap = np.zeros((8, 8), bool); bitmap[i % 8, :] = True
            out.append({'type': 'mask', 'points': m.encode_mask(bitmap), 'frames': 3})
        return out

    def run_cuda_free(self, fn):
        sync = torch.cuda.synchronize
        torch.cuda.synchronize = lambda: None
        try:
            return fn()
        finally:
            torch.cuda.synchronize = sync

    def test_codec_roundtrip_and_preprocess_shape(self):
        for bitmap in (np.ones((4, 4), bool), np.random.default_rng(1).random((20, 30)) > 0.5):
            np.testing.assert_array_equal(m.decode_mask(m.encode_mask(bitmap), bitmap.shape[1], bitmap.shape[0]), bitmap)
        tensor = m.preprocess(Image.new('RGB', (30, 20), (255, 0, 0)), 16, 'cpu')
        self.assertEqual(tuple(tensor.shape), (3, 16, 16)); self.assertEqual(tensor.dtype, torch.float32)

    def test_planned_frames_seven_objects_limits_retry_and_release(self):
        h = self.handler(); image = Image.new('RGB', (8, 8))
        init = self.run_cuda_free(lambda: h.track(b'raw', image, self.seeds(7), []))
        self.assertEqual(h.started, [(7, 4)])  # planned 3 following frames => official clip of 4
        self.assertEqual([s['object'] for s in init['states']], list(range(1, 8)))
        out = init
        for step in range(1, 4):
            out = self.run_cuda_free(lambda: h.track(b'raw', image, [], out['states']))
            self.assertEqual(len(out['shapes']), 7)
        self.assertEqual(h.calls, 3)
        with self.assertRaisesRegex(ValueError, 'planned 3-frame'):
            self.run_cuda_free(lambda: h.track(b'raw', image, [], out['states']))
        h2 = self.handler(); first = self.run_cuda_free(lambda: h2.track(b'raw', image, self.seeds(2), []))
        nxt = self.run_cuda_free(lambda: h2.track(b'raw', image, [], first['states']))
        self.assertEqual(self.run_cuda_free(lambda: h2.track(b'raw', image, [], first['states'])), nxt)
        self.assertEqual(h2.calls, 1, 'retry must not advance memory')
        with self.assertRaisesRegex(ValueError, 'reordered'):
            h2.track(b'raw', image, [], list(reversed(nxt['states'])))
        released = h2.track(b'raw', image, [{'type': 'mask', 'points': []}] * 2, nxt['states'])
        self.assertIsNone(h2.item); self.assertEqual(released['shapes'], [None, None])

    def test_rejections_without_starting(self):
        h = self.handler(); image = Image.new('RGB', (8, 8))
        bad = [self.seeds(8), [], [{'type': 'rectangle', 'points': [0, 0, 4, 4]}],
               [{**self.seeds(1)[0], 'frames': 101}], [{**self.seeds(1)[0], 'frames': 0}],
               [self.seeds(1)[0], {**self.seeds(2)[1], 'frames': 5}]]
        for shapes in bad:
            with self.subTest(shapes=len(shapes)), self.assertRaises(ValueError):
                h.track(b'raw', image, shapes, [])
        self.assertEqual(h.started, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
