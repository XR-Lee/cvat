from host_nvidia import link_host_driver_libraries as l; print(l())
import ctypes, os
for n in ('libcuda.so.1','libnvidia-gpucomp.so.595.99.02','libnvidia-ml.so.1'):
    p='/opt/nvidia-host/'+n; print(n, os.path.exists(p), os.path.realpath(p))
try:
    c=ctypes.CDLL('libcuda.so.1'); print('dlopen ok')
    r=c.cuInit(0); print('cuInit ->', r)
    n=ctypes.c_int(); print('cuDeviceGetCount ->', c.cuDeviceGetCount(ctypes.byref(n)), n.value)
    v=ctypes.c_int(); c.cuDriverGetVersion(ctypes.byref(v)); print('driver api', v.value)
except OSError as e: print('dlopen failed', e)
print(open('/proc/driver/nvidia/version').readline().strip() if os.path.exists('/proc/driver/nvidia/version') else 'no /proc/driver/nvidia')
print(sorted(os.listdir('/dev'))[:0] or [d for d in os.listdir('/dev') if d.startswith('nvidia')])
