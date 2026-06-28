#!/usr/bin/env python
"""Generate the Google Play feature graphic (1024x500) — black bg, white Hookka
logo, gold tagline. Output: docs/play-assets/feature-graphic.png."""
from PIL import Image, ImageDraw, ImageFont
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "public", "hookka-logo.png")
OUTDIR = os.path.join(ROOT, "docs", "play-assets")
os.makedirs(OUTDIR, exist_ok=True)

W, H = 1024, 500
BG = (31, 29, 27)  # #1F1D1B raisin
GOLD = (201, 169, 97)  # #C9A961


def white_logo():
    im = Image.open(SRC).convert("RGBA")
    im = im.crop(im.getbbox())
    white = Image.new("RGBA", im.size, (255, 255, 255, 255))
    white.putalpha(im.split()[3])
    return white


def load_font(size):
    for p in (
        "C:/Windows/Fonts/segoeuib.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
        "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arial.ttf",
    ):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def main():
    canvas = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(canvas)
    # subtle grid (matches the login)
    for x in range(0, W, 64):
        d.line([(x, 0), (x, H)], fill=(40, 36, 28), width=1)
    for y in range(0, H, 64):
        d.line([(0, y), (W, y)], fill=(40, 36, 28), width=1)

    # logo, white, centered upper area (~width 420)
    logo = white_logo()
    target_w = 420
    scale = target_w / logo.width
    logo = logo.resize((target_w, int(logo.height * scale)), Image.LANCZOS)
    lx = (W - logo.width) // 2
    ly = int(H * 0.30) - logo.height // 2
    canvas.paste(logo, (lx, ly), logo)

    # tagline, gold, letter-spaced, centered below the logo
    tag = "M A N U F A C T U R I N G   I N T E L L I G E N C E"
    font = load_font(30)
    tw = d.textlength(tag, font=font)
    d.text(((W - tw) / 2, int(H * 0.60)), tag, font=font, fill=GOLD)

    canvas.save(os.path.join(OUTDIR, "feature-graphic.png"), "PNG", optimize=True)
    print("done:", os.path.join(OUTDIR, "feature-graphic.png"))


if __name__ == "__main__":
    main()
