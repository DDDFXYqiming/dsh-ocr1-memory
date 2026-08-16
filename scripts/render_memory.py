#!/usr/bin/env python3
"""Render memory segments into a (raster) image with optional Set-of-Mark boxes.

Usage: python render_memory.py <json payload>
Payload: {"segments":[{"id":1,"content":"..."}],"outputPath":"...","width":1024,"som":true}
Requires Pillow. No network access.
"""
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFont

CJK_FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
    r"C:\Windows\Fonts\simsun.ttc",
    r"/System/Library/Fonts/PingFang.ttc",
    r"/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
]

def load_font(size):
    for p in CJK_FONT_CANDIDATES:
        try:
            return ImageFont.truetype(p, size=size)
        except Exception:
            continue
    return ImageFont.load_default(size=size)

def wrap_text(draw, text, font, max_width):
    words = text.split()
    lines = []
    cur = ""
    for w in words:
        test = (cur + " " + w).strip()
        if draw.textbbox((0, 0), test, font=font)[2] <= max_width or not cur:
            cur = test
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines or [""]

def main():
    payload = json.loads(sys.argv[1])
    segments = payload["segments"]
    out = payload["outputPath"]
    width = int(payload.get("width", 1024))
    som = bool(payload.get("som", True))
    height = int(payload.get("height", 0))

    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)

    pad = 24
    font = load_font(max(18, int(width / 48)))
    small = load_font(max(14, int(width / 64)))

    # Estimate total height.
    probe = Image.new("RGB", (width, 10), "white")
    pd = ImageDraw.Draw(probe)
    line_h = 0
    for seg in segments:
        lines = wrap_text(pd, seg["content"], font, width - pad * 2)
        line_h += len(lines) * (font.size + 8)
        if som:
            line_h += 6  # box margin
        line_h += 14  # segment gap
    if not height:
        height = max(200, line_h + pad * 2)

    img = Image.new("RGB", (width, height), "white")
    d = ImageDraw.Draw(img)

    y = pad
    for seg in segments:
        lines = wrap_text(d, seg["content"], font, width - pad * 2)
        block_h = len(lines) * (font.size + 8)
        top = y
        bottom = y + block_h
        if som:
            # red box around the segment block + numeric label
            d.rectangle([pad - 6, top - 4, width - pad + 6, bottom + 4], outline="red", width=3)
            label = str(seg["id"])
            label_w = d.textbbox((0, 0), label, font=small)[2] + 8
            d.rectangle([pad - 6, top - 4, pad - 6 + label_w, top - 4 + small.size + 6], fill="red", outline="red")
            d.text((pad - 6 + 4, top - 4 + 1), label, fill="white", font=small)
        for i, line in enumerate(lines):
            d.text((pad, top + i * (font.size + 8)), line, fill="black", font=font)
        y = bottom + 14

    img.save(out, format="PNG")
    # Simple image-derived visual embedding: 8x8 grayscale pixels, normalized.
    small = img.convert("L").resize((8, 8))
    embedding = [round(p / 255.0, 6) for p in small.getdata()]
    with open(out + ".embedding.json", "w", encoding="utf-8") as f:
        json.dump({"embedding": embedding}, f)
    print(f"rendered {os.path.basename(out)} width={width} segments={len(segments)}")

if __name__ == "__main__":
    main()
