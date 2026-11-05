import base64
import io
import json

from PIL import Image

from model_handler import ModelHandler


def init_context(context):
    context.user_data.model = ModelHandler()
    context.logger.info("Grounding DINO + MedSAM2 auto-labeling ready (CPU; research/education-licensed MedSAM2 weights)")


def handler(context, event):
    data = event.body
    if isinstance(data, (bytes, str)):
        data = json.loads(data)
    raw = base64.b64decode(data["image"])
    image = Image.open(io.BytesIO(raw)).convert("RGB")
    threshold = float(data.get("threshold") or 0.25)
    results = context.user_data.model.handle(image, threshold)
    return context.Response(body=json.dumps(results), headers={}, content_type="application/json", status_code=200)
