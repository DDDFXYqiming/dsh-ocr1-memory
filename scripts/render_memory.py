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
    """Wrap words, with a character fallback for CJK/URLs/no-space text.

    Pillow does not wrap text automatically. The previous implementation kept
    an over-wide token as one line, clipping long Chinese passages because CJK
    normally has no spaces. This helper guarantees every emitted line fits.
    """
    def width(value):
        box = draw.textbbox((0, 0), value, font=font)
        return box[2] - box[0]

    def hard_wrap(value):
        chunks = []
        current = ""
        for char in value:
            candidate = current + char
            if current and width(candidate) > max_width:
                chunks.append(current)
                current = char
            else:
                current = candidate
        if current:
            chunks.append(current)
        return chunks or [""]

    words = str(text).split()
    if not words:
        return [""]
    lines = []
    cur = ""
    for word in words:
        if width(word) > max_width:
            if cur:
                lines.append(cur)
                cur = ""
            chunks = hard_wrap(word)
            lines.extend(chunks[:-1])
            cur = chunks[-1]
            continue
        test = (cur + " " + word).strip()
        if not cur or width(test) <= max_width:
            cur = test
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    return lines or [""]

def render_payload(payload):
    """Render one payload and return the output path (importable by trainers)."""
    segments = payload["segments"]
    out = payload["outputPath"]
    width = int(payload.get("width", 1024))
    som = bool(payload.get("som", True))
    height = int(payload.get("height", 0))
    square = bool(payload.get("square", False))
    quiet = bool(payload.get("quiet", False))

    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)

    # OCR-Memory uses red boxes with high-contrast 36pt numeric anchors.
    # Reserve a left gutter so the anchor never occludes the segment text.
    pad = 64 if som else 24
    font = load_font(max(18, int(width / 48)))
    label_font = load_font(36)

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
            label_box = d.textbbox((0, 0), label, font=label_font)
            label_w = (label_box[2] - label_box[0]) + 12
            label_h = (label_box[3] - label_box[1]) + 8
            label_left = max(4, pad - label_w - 10)
            d.rectangle([label_left, top - 4, label_left + label_w, top - 4 + label_h], fill="red", outline="red")
            d.text((label_left + 6, top - 4 + 2), label, fill="white", font=label_font)
        for i, line in enumerate(lines):
            d.text((pad, top + i * (font.size + 8)), line, fill="black", font=font)
        y = bottom + 14

    # OCR-Memory trains/evaluates on exact 1024² and 512² canvases. Render all
    # content first, then apply the paper's bicubic target resize so no text is
    # silently clipped while the DeepEncoder token budget remains controlled.
    if square and img.height != width:
        img = img.resize((width, width), Image.Resampling.BICUBIC)

    img.save(out, format="PNG")
    # Simple image-derived visual embedding: 8x8 grayscale pixels, normalized.
    small = img.convert("L").resize((8, 8))
    embedding = [round(p / 255.0, 6) for p in small.getdata()]
    with open(out + ".embedding.json", "w", encoding="utf-8") as f:
        json.dump({"embedding": embedding}, f)
    if not quiet:
        print(f"rendered {os.path.basename(out)} width={width} segments={len(segments)}")
    return out


def main():
    render_payload(json.loads(sys.argv[1]))


if __name__ == "__main__":
    main()
