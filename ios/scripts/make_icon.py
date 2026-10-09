"""Draws the app icon (a screen with signal arcs on a blue gradient) as a 1024x1024 PNG.

Usage: python3 scripts/make_icon.py App/Assets.xcassets/AppIcon.appiconset/icon-1024.png
Needs Pillow. The result is checked in, so this only has to run if the artwork changes.
"""
import sys

from PIL import Image, ImageDraw

SIZE = 1024
out = sys.argv[1] if len(sys.argv) > 1 else "icon-1024.png"

top, bottom = (37, 99, 235), (23, 37, 120)
img = Image.new("RGB", (SIZE, SIZE))
px = img.load()
for y in range(SIZE):
    t = y / (SIZE - 1)
    row = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    for x in range(SIZE):
        px[x, y] = row

d = ImageDraw.Draw(img)
white = (255, 255, 255)

# the monitor
d.rounded_rectangle((172, 230, 852, 640), radius=52, fill=white)
d.rounded_rectangle((212, 270, 812, 600), radius=24, fill=(30, 58, 138))
d.rounded_rectangle((452, 640, 572, 740), radius=10, fill=white)
d.rounded_rectangle((342, 730, 682, 786), radius=28, fill=white)

# signal arcs coming out of the screen's corner
cx, cy = 380, 520
for i, r in enumerate((70, 140, 210)):
    box = (cx - r, cy - r, cx + r, cy + r)
    d.arc(box, start=270, end=360, fill=white, width=26 - i * 3)
d.ellipse((cx - 22, cy - 22, cx + 22, cy + 22), fill=white)

img.save(out, "PNG")
print("wrote", out)
