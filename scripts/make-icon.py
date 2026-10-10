"""Generates build/icon.ico (the app/installer icon) — same motif as the tray icon. Requires Pillow."""
import os
from PIL import Image, ImageDraw

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([40, 40, S - 40, S - 40], radius=230, fill=(251, 232, 239, 255))
d.ellipse([170, 170, S - 170, S - 170], fill=(236, 120, 160, 255), outline=(200, 80, 120, 255), width=36)
for cx in (S / 2 - 160, S / 2 + 160):  # eyes
    d.ellipse([cx - 62, 400 - 80, cx + 62, 400 + 80], fill=(40, 30, 50, 255))
    d.ellipse([cx - 22, 400 - 50, cx + 18, 400 - 10], fill=(255, 255, 255, 255))
d.arc([S / 2 - 150, 500, S / 2 + 150, 720], start=20, end=160, fill=(120, 40, 70, 255), width=34)  # smile
for cx in (S / 2 - 250, S / 2 + 250):  # cheeks
    d.ellipse([cx - 60, 560, cx + 60, 620], fill=(255, 170, 190, 255))
out = os.path.join(os.path.dirname(__file__), "..", "build", "icon.ico")
img.save(out, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
img.resize((256, 256), Image.LANCZOS).save(os.path.join(os.path.dirname(out), "icon.png"))
print("wrote", os.path.abspath(out))
