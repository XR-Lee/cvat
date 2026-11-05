"""Mask codec/state regression tests; no model weights loaded."""
import importlib.util
import os
from pathlib import Path
import threading
import time
from types import SimpleNamespace
import unittest

import numpy as np
from PIL import Image
import torch
from transformers import Sam2VideoProcessor

path = Path(os.environ.get('VIDEO_HANDLER_PATH', Path(__file__).parents[1] / 'nuclio-video/model_handler.py'))
spec = importlib.util.spec_from_file_location('video_handler', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Tests(unittest.TestCase):
    def test_codec_holes_components_and_boundaries(self):
        for mask in (np.ones((4, 4), dtype=bool), np.eye(20, dtype=bool), np.random.default_rng(4).random((30,40)) > 0.5):
            encoded = module.encode_mask(mask)
            np.testing.assert_array_equal(module.decode_mask(encoded, mask.shape[1], mask.shape[0]), mask)
        self.assertIsNone(module.encode_mask(np.zeros((3,3), dtype=bool)))

    def test_invalid_masks(self):
        for points in (None, [], [0,0,0,0,0], [0,99,0,0,2,2], [0,-1,0,0,0,0], [0,1,-1,0,-1,0], [0,1.5,0,0,0,0], [0,float('nan'),0,0,0,0]):
            with self.subTest(points=points), self.assertRaises(ValueError):
                module.decode_mask(points, 10, 10)

    def test_real_video_postprocess_dimensions(self):
        processor = Sam2VideoProcessor.from_pretrained('facebook/sam2.1-hiera-large', local_files_only=True)
        masks = processor.post_process_masks([torch.ones(1,1,256,256)], original_sizes=[[54,96]])[0]
        self.assertEqual(tuple(masks.shape), (1,1,54,96))

    def handler(self):
        handler = module.ModelHandler.__new__(module.ModelHandler)
        handler.lock = threading.RLock()
        handler.sessions = {}
        handler.ttl = 180
        handler.max_sessions = 2
        handler.max_steps = 50
        handler.calls = 0
        class Processor:
            def init_video_session(self, **kwargs):
                return SimpleNamespace(processed_frames={})
            def add_inputs_to_inference_session(self, session, **kwargs):
                session.seed = kwargs['input_masks']
            def __call__(self, **kwargs):
                return {'pixel_values': torch.zeros(1,3,16,16)}
            def post_process_masks(self, masks, **kwargs):
                self_test.assertIsInstance(masks, list)
                return [torch.ones(1,1,8,8)]
        self_test = self
        handler.processor = Processor()
        def model(inference_session, frame, frame_idx):
            handler.calls += 1
            inference_session.processed_frames[frame_idx] = frame
            return SimpleNamespace(pred_masks=torch.ones(1,1,4,4))
        handler.model = model
        return handler

    def test_memory_state_retry_release_and_expiry(self):
        handler = self.handler()
        image = Image.new('RGB', (8,8))
        points = module.encode_mask(np.ones((8,8), dtype=bool))
        seed, state = handler.track(image, {'type':'mask','points':points}, None)
        self.assertEqual(seed['points'], points)
        result, next_state = handler.track(image, None, state)
        self.assertEqual(handler.calls, 2)
        self.assertEqual(handler.track(image, None, state), (result, next_state))
        self.assertEqual(handler.calls, 2, 'retry must not advance memory')
        with self.assertRaisesRegex(ValueError, 'different frame'):
            handler.track(Image.new('RGB',(8,8),'white'), None, state)
        handler.track(image, {'type':'mask','points':[]}, next_state)
        self.assertEqual(handler.sessions, {})
        with self.assertRaisesRegex(ValueError, 'expired'):
            handler.track(image, None, next_state)
        handler.sessions['old'] = {'touched':time.monotonic()-181}
        handler._expire()
        self.assertEqual(handler.sessions, {})

    def test_limits_and_invalid_shapes(self):
        handler = self.handler()
        image = Image.new('RGB',(8,8))
        with self.assertRaisesRegex(ValueError,'Initialize with a mask'):
            handler.track(image, {'type':'rectangle','points':[0,0,5,5]}, None)
        points = module.encode_mask(np.ones((8,8), dtype=bool))
        _, state = handler.track(image, {'type':'mask','points':points}, None)
        handler.sessions[state['session']]['step'] = 50
        with self.assertRaisesRegex(ValueError,'Maximum 50'):
            handler.track(image, None, {**state,'step':50})
        with self.assertRaisesRegex(ValueError,'dimensions'):
            handler.track(Image.new('RGB',(9,8)), None, state)


if __name__ == '__main__':
    unittest.main(verbosity=2)
