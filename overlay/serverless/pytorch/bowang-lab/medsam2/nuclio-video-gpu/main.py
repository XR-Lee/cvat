import base64
import io
import json
from PIL import Image

from host_nvidia import link_host_driver_libraries

# Must run before CUDA initialises (ModelHandler checks torch.cuda).
LINKED_LIBRARIES, HOST_DRIVER = link_host_driver_libraries()

from model_handler import ModelHandler  # noqa: E402


def init_context(context):
    context.user_data.model = ModelHandler()
    context.logger.info(f'MedSAM2 CUDA multi-mask tracker ready; host driver {HOST_DRIVER} ({LINKED_LIBRARIES} libs); research/education-licensed weights')


def handler(context, event):
    data = event.body
    if isinstance(data, (bytes, str)):
        data = json.loads(data)
    try:
        raw = base64.b64decode(data['image'], validate=True)
        image = Image.open(io.BytesIO(raw)).convert('RGB')
        result = context.user_data.model.track(raw, image, data.get('shapes') or [], data.get('states') or [])
        status = 200
    except (ValueError, KeyError) as exc:
        context.logger.warn(str(exc))
        # CVAT's gateway discards HTTP 400 bodies; return an explicit error payload instead.
        result, status = {'shapes': [], 'states': [], 'error': str(exc), 'device': 'cuda'}, 200
    return context.Response(body=json.dumps(result), headers={}, content_type='application/json', status_code=status)
