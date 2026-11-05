import base64
import io
import json

from PIL import Image

from model_handler import ModelHandler


def init_context(context):
    context.logger.info("Init SAM 2.1 Tracker...  0%")
    context.user_data.model = ModelHandler()
    context.logger.info("Init SAM 2.1 Tracker...100%")


def handler(context, event):
    data = event.body
    if isinstance(data, (bytes, str)):
        data = json.loads(data)
    raw = base64.b64decode(data["image"])
    image = Image.open(io.BytesIO(raw)).convert("RGB")
    shapes = data.get("shapes") or []
    states = data.get("states") or []
    count = max(len(shapes), len(states))
    results = {"shapes": [], "states": []}
    for index in range(count):
        shape = shapes[index] if index < len(shapes) else None
        state = states[index] if index < len(states) else None
        tracked, new_state = context.user_data.model.track(image, raw, shape, state)
        results["shapes"].append(tracked)
        results["states"].append(new_state)
    return context.Response(
        body=json.dumps(results),
        headers={},
        content_type="application/json",
        status_code=200,
    )
