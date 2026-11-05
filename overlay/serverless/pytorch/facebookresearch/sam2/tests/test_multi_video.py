"""CPU-only contract tests for CUDA multi-object state handling (mock model)."""
import contextlib
import importlib.util
import os
from pathlib import Path
import threading
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import numpy as np
from PIL import Image
import torch

path=Path(os.environ.get('MULTI_HANDLER_PATH',Path(__file__).parents[1]/'nuclio-video-gpu/model_handler.py'))
spec=importlib.util.spec_from_file_location('multi',path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class Tests(unittest.TestCase):
    def handler(self):
        h=m.ModelHandler.__new__(m.ModelHandler);h.lock=threading.RLock();h.item=None;h.ttl=90;h.gpu_lock=None;h.device='cpu';h.dtype=torch.float32;h.calls=0
        h._acquire_gpu=lambda:None
        class Processor:
            def init_video_session(self,**kw):return SimpleNamespace(processed_frames={})
            def add_inputs_to_inference_session(self,s,**kw):s.masks=kw['input_masks'];s.ids=kw['obj_ids']
            def __call__(self,**kw):return {'pixel_values':torch.zeros(1,3,8,8)}
            def post_process_masks(self,masks,**kw):return masks
        class Model:
            def to(self,device):return self
            def __call__(self,inference_session,frame,frame_idx):
                h.calls+=1;inference_session.processed_frames[frame_idx]=frame
                return SimpleNamespace(pred_masks=torch.tensor(np.stack(inference_session.masks)).unsqueeze(1))
        h.processor=Processor();h.model=Model();return h
    def masks(self):
        a=np.zeros((8,8),bool);a[1:4,1:4]=True;b=np.zeros((8,8),bool);b[4:7,4:7]=True
        return [{'type':'mask','points':m.encode_mask(x)} for x in (a,b)]
    def test_codec(self):
        for s in self.masks():self.assertEqual(m.encode_mask(m.decode_mask(s['points'],8,8)),s['points'])
    def test_multi_identity_retry_and_release(self):
        h=self.handler();image=Image.new('RGB',(8,8));seeds=self.masks()
        with patch.object(torch,'autocast',lambda *a,**k:contextlib.nullcontext()),patch.object(torch.cuda,'synchronize',lambda:None):
            init=h.track(image,seeds,[]);self.assertEqual(init['shapes'],seeds);self.assertEqual([s['object'] for s in init['states']],[1,2])
            out=h.track(image,[],init['states']);self.assertEqual(out['shapes'],seeds);self.assertEqual(h.calls,2)
            self.assertEqual(h.track(image,[],init['states']),out);self.assertEqual(h.calls,2)
            with self.assertRaisesRegex(ValueError,'reordered'):h.track(image,[],list(reversed(out['states'])))
            released=h.track(image,[{'type':'mask','points':[]}]*2,out['states']);self.assertIsNone(h.item);self.assertEqual(released['shapes'],[None,None])
    def test_limits_bad_masks(self):
        h=self.handler();image=Image.new('RGB',(8,8))
        for shapes in ([],self.masks()*4,[{'type':'rectangle','points':[0,0,5,5]}]):
            with self.assertRaises(ValueError):h.track(image,shapes,[])
        for pts in ([0,100,0,0,2,2],[0,1,-1,0,0,0],[0,1.5,0,0,0,0]):
            with self.assertRaises(ValueError):m.decode_mask(pts,8,8)
    def test_seven_objects_one_hundred_steps_and_boundary_rejection(self):
        self.assertEqual(m.MAX_OBJECTS,7);self.assertEqual(m.MAX_STEPS,100)
        h=self.handler();image=Image.new('RGB',(8,8))
        masks=[]
        for i in range(7):
            bitmap=np.zeros((8,8),bool);bitmap[i,:]=True
            masks.append({'type':'mask','points':m.encode_mask(bitmap)})
        with patch.object(torch,'autocast',lambda *a,**k:contextlib.nullcontext()),patch.object(torch.cuda,'synchronize',lambda:None):
            out=h.track(image,masks,[])
            for step in range(1,101):
                out=h.track(image,[],out['states'])
                self.assertEqual(out['shapes'],masks)
                self.assertEqual([s['object'] for s in out['states']],list(range(1,8)))
                self.assertTrue(all(s['step']==step for s in out['states']))
            self.assertEqual(h.calls,101)
            with self.assertRaisesRegex(ValueError,'100-frame'):
                h.track(image,[],out['states'])
            self.assertEqual(h.calls,101)
            h.track(image,[{'type':'mask','points':[]}]*7,out['states'])
            self.assertIsNone(h.item)
    def test_gpu_lock_denial_no_state(self):
        h=self.handler()
        def denied():raise ValueError('GPU is busy')
        h._acquire_gpu=denied
        with self.assertRaisesRegex(ValueError,'busy'):h.track(Image.new('RGB',(8,8)),self.masks(),[])
        self.assertEqual(h.calls,0);self.assertIsNone(h.item)

if __name__=='__main__':unittest.main(verbosity=2)
