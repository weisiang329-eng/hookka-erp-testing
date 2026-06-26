#!/usr/bin/env python
"""Generate Hookka PWA icons from public/hookka-logo.png.
Background: white (#FFFFFF) — the logo is black line-art, reads crispest on white.
Outputs:
  public/pwa-icon-192.png          (purpose: any)   white bg, logo ~80% width
  public/pwa-icon-512.png          (purpose: any)   white bg, logo ~80% width
  public/pwa-icon-maskable-512.png (purpose: maskable) logo inside inner 64% safe zone
Run: python scripts/gen-pwa-icons.py
"""
from PIL import Image
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "public", "hookka-logo.png")
BG = (255, 255, 255, 255)  # white

def trimmed_logo():
    im = Image.open(SRC).convert("RGBA")
    bbox = im.getbbox()  # crop transparent margins
    return im.crop(bbox)

def make_icon(size, logo_frac):
    """Square white canvas, logo scaled so its WIDTH = logo_frac*size (or height fits)."""
    logo = trimmed_logo()
    lw, lh = logo.size
    canvas = Image.new("RGBA", (size, size), BG)
    target_w = int(size * logo_frac)
    # scale to width, but cap height to the same safe fraction so wide logo never overflows vertically
    scale = target_w / lw
    new_w = target_w
    new_h = int(lh * scale)
    max_h = int(size * logo_frac)
    if new_h > max_h:
        scale = max_h / lh
        new_h = max_h
        new_w = int(lw * scale)
    resized = logo.resize((new_w, new_h), Image.LANCZOS)
    x = (size - new_w) // 2
    y = (size - new_h) // 2
    canvas.alpha_composite(resized, (x, y))
    return canvas.convert("RGB")  # flatten to white, no alpha (cleaner home-screen icon)

def main():
    out = os.path.join(ROOT, "public")
    # "any" icons: logo ~80% of the icon width, centered
    make_icon(192, 0.80).save(os.path.join(out, "pwa-icon-192.png"), "PNG", optimize=True)
    make_icon(512, 0.80).save(os.path.join(out, "pwa-icon-512.png"), "PNG", optimize=True)
    # maskable: logo within inner safe zone (Android masks ~10% each edge; keep content <=80% diameter -> use 0.62 width to leave room for the wide aspect)
    make_icon(512, 0.62).save(os.path.join(out, "pwa-icon-maskable-512.png"), "PNG", optimize=True)
    print("done")

if __name__ == "__main__":
    main()
