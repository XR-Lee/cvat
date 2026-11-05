"""Use the host's NVIDIA user-space driver libraries, whatever version is installed.

Nuclio's local platform can only request GPUs with ``docker --gpus``, which this
host's snap Docker rejects (it requires ``--runtime=nvidia``). Bundling driver
libraries in the image breaks whenever the host driver is upgraded (as happened
on the 2026-10-27 reboot: kernel module 595.71.05 -> 595.99.02).

Instead the host library directory is bind-mounted read-only at
``/host-nvidia-lib``. Before CUDA initialises, the NVIDIA libraries found there
are symlinked into ``/opt/nvidia-host``, which is the only entry of
``LD_LIBRARY_PATH``. Only NVIDIA driver libraries become loadable; the rest of
the host's system libraries are never on the search path. Every container start
re-creates the links, so a driver upgrade plus reboot is picked up automatically.
"""
import glob
import os

SOURCE = '/host-nvidia-lib'
TARGET = '/opt/nvidia-host'
PATTERNS = ('libcuda.so*', 'libnvidia-*.so*')


def link_host_driver_libraries():
    if not os.path.isfile(os.path.join(SOURCE, 'libcuda.so.1')):
        raise RuntimeError(f'Host NVIDIA driver libraries not mounted at {SOURCE}')
    os.makedirs(TARGET, exist_ok=True)
    for name in os.listdir(TARGET):
        os.unlink(os.path.join(TARGET, name))
    linked = 0
    for pattern in PATTERNS:
        for path in glob.glob(os.path.join(SOURCE, pattern)):
            os.symlink(path, os.path.join(TARGET, os.path.basename(path)))
            linked += 1
    version = os.path.realpath(os.path.join(SOURCE, 'libcuda.so.1')).rsplit('.so.', 1)[-1]
    return linked, version
