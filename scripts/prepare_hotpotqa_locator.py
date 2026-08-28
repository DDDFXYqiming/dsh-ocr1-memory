#!/usr/bin/env python3
"""Prepare OCR-Memory listwise SoM training data from HotpotQA distractor.

The OCR-Memory paper uses the question plus ten rendered context paragraphs and
supervises one 0/1 label per paragraph. This script preserves every paragraph
verbatim, renders a 1024x1024 SoM image, and writes deterministic JSONL records.
The training collator performs the paper's 0.3/0.7 1024/512 curriculum.

Example (smoke subset):
  python scripts/prepare_hotpotqa_locator.py --output data/hotpotqa-locator --limit 32
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from itertools import islice
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))
from render_memory import render_payload  # noqa: E402


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--split", default="train")
    p.add_argument("--limit", type=int, default=0, help="0 means the full split")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--shuffle-buffer", type=int, default=10_000)
    return p.parse_args()


def paragraphs_from(example):
    context = example["context"]
    titles = list(context["title"])
    sentence_groups = list(context["sentences"])
    if len(titles) != len(sentence_groups):
        raise ValueError(f"context title/sentences mismatch for {example.get('id')}")
    paragraphs = []
    for title, sentences in zip(titles, sentence_groups):
        text = " ".join(str(s).strip() for s in sentences if str(s).strip())
        paragraphs.append(f"{title}\n{text}".strip())
    return titles, paragraphs


def main():
    args = parse_args()
    try:
        from datasets import load_dataset
    except ImportError as exc:
        raise SystemExit("Install training dependencies first: pip install datasets pillow") from exc

    random.seed(args.seed)
    output = args.output.resolve()
    image_dir = output / "images"
    image_dir.mkdir(parents=True, exist_ok=True)
    stream = load_dataset("hotpotqa/hotpot_qa", "distractor", split=args.split, streaming=True)
    if args.shuffle_buffer > 0:
        stream = stream.shuffle(seed=args.seed, buffer_size=args.shuffle_buffer)
    iterator = islice(stream, args.limit) if args.limit > 0 else iter(stream)

    manifest = output / f"{args.split}.jsonl"
    count = 0
    positives = 0
    with manifest.open("w", encoding="utf-8", newline="\n") as fh:
        for example in iterator:
            titles, paragraphs = paragraphs_from(example)
            support_titles = set(example["supporting_facts"]["title"])
            labels = [1 if title in support_titles else 0 for title in titles]
            if not any(labels):
                continue
            sample_id = str(example["id"])
            image_path = image_dir / f"{sample_id}.png"
            segments = [{"id": i + 1, "content": text} for i, text in enumerate(paragraphs)]
            render_payload({
                "segments": segments,
                "outputPath": str(image_path),
                "width": 1024,
                "som": True,
                "square": True,
                "quiet": True,
            })
            record = {
                "id": sample_id,
                "question": str(example["question"]),
                "image": str(image_path),
                "labels": labels,
                "target": " ".join(map(str, labels)),
                "titles": titles,
                "positive_indices": [i + 1 for i, label in enumerate(labels) if label],
                "source": "hotpotqa/hotpot_qa:distractor",
            }
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
            count += 1
            positives += sum(labels)
            if count % 100 == 0:
                print(f"prepared {count} samples", flush=True)

    metadata = {
        "dataset": "hotpotqa/hotpot_qa",
        "config": "distractor",
        "split": args.split,
        "samples": count,
        "positive_labels": positives,
        "seed": args.seed,
        "render": {"high": [1024, 1024], "low": [512, 512], "som_label_pt": 36, "resize": "bicubic"},
        "target_format": "space-separated binary vector",
        "paper_disclosure_note": "The paper does not disclose its exact prompt or separator serialization; this repository uses one standalone 0/1 token per segment separated by spaces.",
    }
    (output / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(metadata, ensure_ascii=False))


if __name__ == "__main__":
    main()
