import io, zipfile
from PIL import Image

p = "/home/django/data/cache/export/task-16-dataset-instance1794734298.268173-coco-10.zip"
with zipfile.ZipFile(p) as z:
    names = [n for n in z.namelist() if n.endswith(".png")][:3]
    for n in names:
        raw = z.read(n)
        im = Image.open(io.BytesIO(raw)).convert("RGB")
        out = {}
        for q in (95, 90, 80, 70):
            buf = io.BytesIO(); im.save(buf, "JPEG", quality=q, optimize=True)
            out[f"jpeg_q{q}"] = len(buf.getvalue())
        buf = io.BytesIO(); im.save(buf, "WEBP", quality=90, method=4)
        out["webp_q90"] = len(buf.getvalue())
        print(n, im.size, f"png={len(raw)/1024:.0f} KB",
              " ".join(f"{k}={v/1024:.0f}KB ({len(raw)/v:.1f}x)" for k, v in out.items()))
