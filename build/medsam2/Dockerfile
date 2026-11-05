# MedSAM2 (bowang-lab/MedSAM2 @ 332f30d) on the verified CUDA 12.8 + host-matched driver-library base.
# Code: Apache-2.0. Weights: research/education use only (per model card).
FROM cvat.sam2-video-cuda:2.9-cu128-595.71.05
RUN pip3 install --no-cache-dir "hydra-core==1.3.2" "iopath==0.1.10"
COPY medsam2/ /opt/medsam2/
RUN echo "c92743b99f00d078bf32a3afcc38aaa9faf1c1692dffe3eaa7a90938c1991060  /opt/medsam2/weights/MedSAM2_latest.pt" | sha256sum -c - \
 && python3 -c "import sys; sys.path.insert(0,'/opt/medsam2'); import sam2.build_sam, sam2.sam2_video_predictor; from sam2.build_sam import build_sam2_video_predictor as b; m=b(config_file=\"configs/sam2.1_hiera_t512.yaml\", ckpt_path=\"/opt/medsam2/weights/MedSAM2_latest.pt\", device=\"cpu\", apply_postprocessing=False); print(\"medsam2 build ok\", m.image_size)"
ENV MEDSAM2_ROOT=/opt/medsam2
