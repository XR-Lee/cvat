import base64
import io
import json

from PIL import Image

from model_handler import ModelHandler


def init_context(context):
    context.logger.info("Init SAM 2.1 Large...  0%")
    context.user_data.model = ModelHandler()
    context.logger.info("Init SAM 2.1 Large...100%")


def handler(context, event):
    data = event.body
    if isinstance(data, (bytes, str)):
        data = json.loads(data)
    raw = base64.b64decode(data["image"])
    image = Image.open(io.BytesIO(raw)).convert("RGB")
    points = context.user_data.model.handle(
        image,
        raw,
        data.get("pos_points") or [],
        data.get("neg_points") or [],
        data.get("obj_bbox"),
    )
    shapes = []
    if points:
        shapes.append(
            {
                "points": points,
                "group": 0,
                "source": "semi-auto",
                "attributes": [],
                "occluded": False,
                "rotation": 0,
                "type": "mask",
            }
        )
    return context.Response(
        body=json.dumps({"shapes": shapes}),
        headers={},
        content_type="application/json",
        status_code=200,
    )
