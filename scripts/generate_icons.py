#!/usr/bin/env python3
"""
Generate Chrome extension icons using the Yarndings 12 font glyph 'f'.
Downloads the font directly from Google Fonts if not locally available.
"""

import os
import sys
import urllib.request
from PIL import Image, ImageFont, ImageDraw

FONT_URL = "https://fonts.gstatic.com/s/yarndings12/v4/55xreyp2N8T5P2LJbZAlkY9c8Q.ttf"
FONT_CACHE = os.path.join(os.path.dirname(__file__), "Yarndings12.ttf")
ICONS_DIR = os.path.join(os.path.dirname(__file__), "..", "icons")

def ensure_font():
    if not os.path.exists(FONT_CACHE):
        print("Downloading Yarndings 12 font from Google Fonts...")
        urllib.request.urlretrieve(FONT_URL, FONT_CACHE)
    return FONT_CACHE

def render_icon(font_path, size, bg_color=(24, 24, 27, 255), fg_color=(255, 255, 255, 255)):
    # Render at 4x scale for crisp anti-aliasing
    scale = 4
    s = size * scale
    radius = int(s * 0.22) if bg_color else 0

    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)

    if bg_color:
        draw.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=bg_color)

    # Scale glyph to occupy ~65% of the canvas
    target_dim = int(s * 0.65)
    test_font = ImageFont.truetype(font_path, target_dim)
    bbox = test_font.getbbox("f")
    gw = bbox[2] - bbox[0]
    gh = bbox[3] - bbox[1]

    optimal_font_size = int(target_dim * (target_dim / max(gw, gh)))
    font = ImageFont.truetype(font_path, optimal_font_size)
    bbox = font.getbbox("f")
    gw = bbox[2] - bbox[0]
    gh = bbox[3] - bbox[1]

    gx = (s - gw) // 2 - bbox[0]
    gy = (s - gh) // 2 - bbox[1]

    draw.text((gx, gy), "f", font=font, fill=fg_color)
    return canvas.resize((size, size), Image.Resampling.LANCZOS)

def main():
    os.makedirs(ICONS_DIR, exist_ok=True)
    font_path = ensure_font()

    sizes = [16, 32, 48, 128]
    for sz in sizes:
        icon = render_icon(font_path, sz)
        output_path = os.path.join(ICONS_DIR, f"icon{sz}.png")
        icon.save(output_path, "PNG")
        print(f"Generated {output_path} ({sz}x{sz})")

if __name__ == "__main__":
    main()
