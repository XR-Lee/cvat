import base64
import io
import json
from PIL import Image
from model_handler import ModelHandler


def init_context(context):
    context.user_data.model = ModelHandler()
    context.logger.info('SAM2 CUDA multi-mask tracker ready; idle weights on CPU; GPU acquired per session')


def handler(context, event):
    data = event.body
    if isinstance(data, (bytes, str)):
        data = json.loads(data)
    try:
        raw = base64.b64decode(data['image'], validate=True)
        image = Image.open(io.BytesIO(raw)).convert('RGB')
        result = context.user_data.model.track(image, data.get('shapes') or [], data.get('states') or [])
        status = 200
    except (ValueError, KeyError) as exc:
        context.logger.warn(str(exc))
        # A successful transport with explicit error preserves a useful error
        # through CVAT's lambda gateway (which otherwise discards HTTP 400 bodies).
        result, status = {'shapes': [], 'states': [], 'error': str(exc), 'device': 'cuda'}, 200
    return context.Response(body=json.dumps(result), headers={}, content_type='application/json', status_code=status)
