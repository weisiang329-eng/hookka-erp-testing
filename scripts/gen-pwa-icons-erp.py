#!/usr/bin/env python
"""Generate the ERP-mobile PWA icons (BLACK bg + WHITE logo) from public/hookka-logo.png.
The office mobile app uses these to distinguish itself from the worker portal
(which keeps the white-bg + black-logo icons). Owner 2026-06-28: 黑底白字.
Outputs:
  public/pwa-icon-erp-192.png          (purpose: any)   raisin bg, white logo ~80% width
  public/pwa-icon-erp-512.png          (purpose: any)
  public/pwa-icon-erp-maskable-512.png (purpose: maskable) logo inside inner 62% safe zone
Run: python scripts/gen-pwa-icons-erp.py
"""
from PIL import Image
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "public", "hookka-logo.png")
BG = (31, 29, 27, 255)  # #1F1D1B raisin (brand near-black)


def white_logo():
    """Load the dark line-art logo, recolor it to pure white (keep its alpha)."""
    im = Image.open(SRC).convert("RGBA")
    im = im.crop(im.getbbox())  # trim transparent margins
    alpha = im.split()[3]
    white = Image.new("RGBA", im.size, (255, 255, 255, 255))
    white.putalpha(alpha)
    return white


def make_icon(size, logo_frac):
    logo = white_logo()
    lw, lh = logo.size
    canvas = Image.new("RGBA", (size, size), BG)
    target_w = int(size * logo_frac)
    scale = target_w / lw
    new_w, new_h = target_w, int(lh * scale)
    max_h = int(size * logo_frac)
    if new_h > max_h:
        scale = max_h / lh
        new_h, new_w = max_h, int(lw * scale)
    resized = logo.resize((new_w, new_h), Image.LANCZOS)
    canvas.alpha_composite(resized, ((size - new_w) // 2, (size - new_h) // 2))
    return canvas.convert("RGB")


def main():
    out = os.path.join(ROOT, "public")
    make_icon(192, 0.80).save(os.path.join(out, "pwa-icon-erp-192.png"), "PNG", optimize=True)
    make_icon(512, 0.80).save(os.path.join(out, "pwa-icon-erp-512.png"), "PNG", optimize=True)
    make_icon(512, 0.62).save(os.path.join(out, "pwa-icon-erp-maskable-512.png"), "PNG", optimize=True)
    print("done")


if __name__ == "__main__":
    main()
