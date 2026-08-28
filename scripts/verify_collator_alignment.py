#!/usr/bin/env python3
"""Verify the locator training collator supervises exactly the target 0/1 labels.

Run after any change to train_locator_unsloth.py's collator to catch alignment
regressions (the classic failure: prompt digits leaking into the supervised
positions, or a +/-1 offset from the "\n" before the prompt).

Usage:
  python scripts/verify_collator_alignment.py [--manifest data/hotpotqa-30/train.jsonl] [--samples 6]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PROCESSOR_DIR = Path(__file__).resolve().parent / "vllm_processors"
sys.path.insert(0, str(PROCESSOR_DIR))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from transformers import AutoTokenizer  # noqa: E402

from deepseek_ocr import DeepseekOCRProcessor  # noqa: E402
from train_locator_unsloth import LocatorCollator, LocatorDataset  # noqa: E402


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--manifest", type=Path, default=Path("data/hotpotqa-30/train.jsonl"))
    p.add_argument("--samples", type=int, default=6)
    p.add_argument("--base-model", default="unsloth/DeepSeek-OCR")
    return p.parse_args()


def main():
    args = parse_args()
    tok = AutoTokenizer.from_pretrained(args.base_model, trust_remote_code=True)
    proc = DeepseekOCRProcessor(tok)
    rows = [json.loads(l) for l in args.manifest.read_text(encoding="utf-8").splitlines() if l.strip()]
    ds = LocatorDataset(rows, seed=1)
    collator = LocatorCollator(tok, proc)

    ok = True
    for idx in range(min(args.samples, len(ds))):
        item = ds[idx]
        batch = collator([item])
        ids = batch["input_ids"][0].tolist()
        labs = batch["labels"][0].tolist()
        pos = [i for i, v in enumerate(labs) if v in (18, 19)]
        dec = tok.decode([ids[i] for i in pos])
        exp = item["target"].replace(" ", "")
        status = "OK" if (dec == exp and len(pos) == len(item["labels"])) else "MISMATCH"
        if status == "MISMATCH":
            ok = False
        print(f"{status} target={item['target']} -> dec={dec} ({len(pos)}/{len(item['labels'])})")
    print("ALL_OK" if ok else "STILL_BROKEN")
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()