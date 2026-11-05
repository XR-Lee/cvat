"""Contract tests for the Grounding DINO + MedSAM2 detector (no model weights loaded).

Run inside cvat.medsam2-cuda with both handler directories mounted:
  MEDSAM2_AUTO=/a/model_handler.py SAM21_AUTO=/b/model_handler.py python3 test_medsam2_auto.py
"""
import ast
import importlib.util
import os
from types import SimpleNamespace
import unittest

import numpy as np
from PIL import Image

MED = os.environ.get('MEDSAM2_AUTO', os.path.join(os.path.dirname(__file__), '../nuclio-auto/model_handler.py'))
SAM = os.environ.get('SAM21_AUTO', os.path.join(os.path.dirname(__file__), '../../../facebookresearch/sam2/nuclio-auto/model_handler.py'))
spec = importlib.util.spec_from_file_location('med_auto', MED)
med = importlib.util.module_from_spec(spec)
spec.loader.exec_module(med)


def definitions(path):
    tree = ast.parse(open(path, encoding='utf-8').read())
    out = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.Assign)):
            name = node.name if isinstance(node, ast.FunctionDef) else getattr(node.targets[0], 'id', None)
            if name:
                if isinstance(node, ast.FunctionDef):
                    node = ast.FunctionDef(**{**node.__dict__, 'body': [s for s in node.body if not (isinstance(s, ast.Expr) and isinstance(getattr(s, 'value', None), ast.Constant) and isinstance(s.value.value, str))]})
                out[name] = ast.dump(node, annotate_fields=False, include_attributes=False)
    return out


class Tests(unittest.TestCase):
    def test_detection_code_identical_to_sam21_detector(self):
        a, b = definitions(MED), definitions(SAM)
        for name in ('PROMPTS', '_detect', '_match_label'):
            self.assertEqual(a[name], b[name], f'{name} diverged from the SAM 2.1 detector')
        # The mask wire format must stay identical too (docstring may differ).
        self.assertEqual(a['_detector_mask'], b['_detector_mask'])

    def handler(self, boxes):
        h = med.ModelHandler.__new__(med.ModelHandler)
        h._detect = lambda image, threshold: boxes
        calls = []

        def predict(box, multimask_output):
            calls.append((tuple(box.tolist()), multimask_output))
            m = np.zeros((20, 30), bool); x1, y1, x2, y2 = map(int, box); m[y1:y2 + 1, x1:x2 + 1] = True
            return m[None], np.array([0.9]), None

        h.predictor = SimpleNamespace(set_image=lambda arr: calls.append(('set', arr.shape)), predict=predict)
        return h, calls

    def test_masks_in_cvat_detector_format(self):
        h, calls = self.handler([('神经根', 0.42, [2, 3, 11, 9]), ('抓钳', 0.31, [15, 1, 25, 18])])
        out = h.handle(Image.new('RGB', (30, 20)), 0.25)
        self.assertEqual([r['label'] for r in out], ['神经根', '抓钳'])
        self.assertEqual([r['confidence'] for r in out], ['0.4200', '0.3100'])
        self.assertTrue(all(r['type'] == 'mask' and 'points' not in r for r in out))
        first = out[0]['mask']; self.assertEqual(first[-4:], [2, 3, 11, 9]); self.assertEqual(len(first) - 4, 10 * 7)
        self.assertEqual(calls[0], ('set', (20, 30, 3)))  # one image encoding per frame
        self.assertTrue(all(c[1] is False for c in calls[1:]))  # single-mask box prompts

    def test_no_detections_skips_segmentation(self):
        h, calls = self.handler([])
        self.assertEqual(h.handle(Image.new('RGB', (30, 20)), 0.25), [])
        self.assertEqual(calls, [])

    def test_tiny_masks_dropped(self):
        h, _ = self.handler([('血管', 0.5, [0, 0, 2, 2])])  # 9 pixels < 16
        self.assertEqual(h.handle(Image.new('RGB', (30, 20)), 0.25), [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
