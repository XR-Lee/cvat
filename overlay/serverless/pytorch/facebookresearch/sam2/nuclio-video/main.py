import base64
import io
import json
from PIL import Image
from model_handler import ModelHandler


def init_context(context):
    context.user_data.model = ModelHandler()
    context.logger.info("SAM2 video-memory mask tracker ready (CPU)")


def handler(context, event):
    data = event.body
    if isinstance(data, (bytes, str)):
        data = json.loads(data)
    try:
        shapes, states = data.get("shapes") or [], data.get("states") or []
        if max(len(shapes), len(states)) != 1:
            raise ValueError("This bounded video tracker accepts exactly one object per request")
        raw = base64.b64decode(data["image"], validate=True)
        image = Image.open(io.BytesIO(raw)).convert("RGB")
        shape, state = context.user_data.model.track(image, shapes[0] if shapes else None,
                                                    states[0] if states else None)
        result = {"shapes": [shape], "states": [state]}
        status = 200
    except (ValueError, KeyError) as exc:
        result, status = {"error": str(exc)}, 400
        context.logger.warn(str(exc))
    return context.Response(body=json.dumps(result), headers={}, content_type="application/json", status_code=status)
