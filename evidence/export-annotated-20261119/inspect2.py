"""Deep inspection of the exported archives (pixel fidelity, instance vs semantic)."""
import io
import json
import pathlib
import zipfile

from PIL import Image

P = pathlib.Path(__file__).parent
ref = json.loads((P / 'reference-annotations.json').read_text())


def cvat_rle_to_full(points, width=960, height=544):
    counts = [int(v) for v in points[:-4]]
    x1, y1, x2, y2 = [int(v) for v in points[-4:]]
    crop = []
    for i, n in enumerate(counts):
        crop.extend([i % 2] * n)
    w, h = x2 - x1 + 1, y2 - y1 + 1
    full = bytearray(width * height)
    for row in range(h):
        full[(row + y1) * width + x1:(row + y1) * width + x2 + 1] = bytes(crop[row * w:(row + 1) * w])
    return bytes(full)


ref_masks = [cvat_rle_to_full(s['points']) for s in ref['shapes']]
ref_areas = [sum(m) for m in ref_masks]
print("reference: label_ids", [s['label_id'] for s in ref['shapes']], "areas", ref_areas)

print("\n--- Segmentation mask 1.1 ---")
z = zipfile.ZipFile(P / 'Segmentation_mask_1_1.zip')
print("labelmap.txt:", z.read('labelmap.txt').decode().strip().replace('\n', ' | '))
for name in ('SegmentationClass/f0.png', 'SegmentationObject/f0.png'):
    if name not in z.namelist():
        print(name, 'MISSING'); continue
    im = Image.open(io.BytesIO(z.read(name)))
    px = list(im.getdata())
    ids = {}
    for v in px:
        ids[v] = ids.get(v, 0) + 1
    print(f"  {name}: size={im.size} mode={im.mode} pixel-value histogram={dict(sorted(ids.items(), key=lambda kv: -kv[1])[:8])}")
    if im.mode == 'P':
        pal = im.getpalette()
        print("    palette entries (first 6):", [tuple(pal[i * 3:i * 3 + 3]) for i in range(6)])

# semantic mask: pixels of label A should equal union of the two structure instances
sem = Image.open(io.BytesIO(z.read('SegmentationClass/f0.png')))
sem_px = list(sem.getdata())
labelmap = z.read('labelmap.txt').decode().split('\n')
print("  labelmap entries:", [(i, l) for i, l in enumerate(labelmap) if l][:6])

print("\n--- MOTS PNG 1.0 ---")
z2 = zipfile.ZipFile(P / 'MOTS_PNG_1_0.zip')
print("  entries:", z2.namelist())
if 'default/instances/labels.txt' in z2.namelist():
    print("  instances/labels.txt:", repr(z2.read('default/instances/labels.txt').decode()[:200]))

print("\n--- COCO 1.0 ---")
z3 = zipfile.ZipFile(P / 'COCO_1_0.zip')
d = json.loads(z3.read('annotations/instances_default.json'))
print("  categories:", [(c['id'], c['name'], c.get('supercategory')) for c in d['categories']])
print("  images:", [(i['id'], i['file_name'], i['width'], i['height']) for i in d['images']])
for a in d['annotations']:
    seg = a['segmentation']
    kind = 'RLE' if isinstance(seg, dict) else 'polygon'
    extra = f" counts_len={len(seg['counts'])} size={seg.get('size')}" if isinstance(seg, dict) else f" points={len(seg[0]) if seg and isinstance(seg[0], list) else 0}"
    print(f"  ann id={a['id']} cat={a['category_id']} area={a.get('area')} bbox={[round(v,1) for v in a.get('bbox',[])]} seg={kind}{extra} iscrowd={a.get('iscrowd')}")

print("\n--- CVAT for video 1.1 ---")
z4 = zipfile.ZipFile(P / 'CVAT_for_video_1_1.zip')
xml = z4.read('annotations.xml').decode()
print(xml[:1800])
