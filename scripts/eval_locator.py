#!/usr/bin/env python3
"""Evaluate a trained OCR-Memory locator adapter on HotpotQA listwise labels.

Loads base DeepSeek-OCR + LoRA adapter, runs the same prompt used in
locator HTTP client training, and measures exact-match / macro-F1 over the
standalone 0/1 vector vs. the ground-truth labels. Running with
--use-llama-cpp instead tests the runtime path (must be CPU llama-server).

Usage:
  python scripts/eval_locator.py --manifest data/hotpotqa-30/train.jsonl \
      --adapter data/hotpotqa-30/out/adapter --limit 10
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import torch
from PIL import Image

from transformers import LogitsProcessor


class ForceBinaryTokensProcessor(LogitsProcessor):
    """Enforce the exact training grammar: `digit space digit ... digit EOS`.

    DeepSeek-OCR tokenizes standalone 0/1 as ids 18/19 and a separator space as
    id 223. Disallowing spaces causes autoregressive context drift even when the
    teacher-forced classifier is correct, so digit and separator steps are
    constrained separately.
    """

    def __init__(self, prompt_length, zero_id=18, one_id=19, space_id=223,
                 max_labels=10, eos_id=1):
        self.prompt_length = int(prompt_length)
        self.zero_id = zero_id
        self.one_id = one_id
        self.space_id = space_id
        self.max_labels = int(max_labels)
        self.eos_id = eos_id
        self.target_token_count = max(1, self.max_labels * 2 - 1)

    def __call__(self, input_ids, scores):
        mask = torch.full_like(scores, float("-inf"))
        generated = input_ids.shape[1] - self.prompt_length
        if generated >= self.target_token_count:
            mask[:, self.eos_id] = 0.0
        elif generated % 2 == 0:
            mask[:, self.zero_id] = scores[:, self.zero_id]
            mask[:, self.one_id] = scores[:, self.one_id]
        else:
            mask[:, self.space_id] = scores[:, self.space_id]
        return mask

PROCESSOR_DIR = Path(__file__).resolve().parent / "vllm_processors"
sys.path.insert(0, str(PROCESSOR_DIR))


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--manifest", type=Path, required=True)
    p.add_argument("--adapter", type=Path)
    p.add_argument("--limit", type=int, default=10)
    p.add_argument("--base-model", default="unsloth/DeepSeek-OCR")
    p.add_argument("--output-dir", default="/tmp/dsocr-eval")
    p.add_argument("--max-new-tokens", type=int, default=64, help="fixed generation budget")
    p.add_argument("--force-binary", action="store_true",
                   help="mask logits to only 0/1 tokens each step (vLLM-style constraining)")
    p.add_argument("--no-lora", action="store_true", help="eval base model only (ablation)")
    return p.parse_args()


def parse_output(text: str, n: int):
    """Best-effort parse: look for exactly n standalone 0/1 labels."""
    import re
    toks = re.findall(r"[01]", text)
    if len(toks) >= n:
        return list(map(int, toks[:n]))
    return None


def main():
    args = parse_args()
    import torch
    from transformers import AutoModel, AutoTokenizer
    from peft import PeftModel
    from deepseek_ocr import DeepseekOCRProcessor

    tokenizer = AutoTokenizer.from_pretrained(args.base_model, trust_remote_code=True)
    processor = DeepseekOCRProcessor(tokenizer)
    model = AutoModel.from_pretrained(
        args.base_model, trust_remote_code=True,
        dtype=torch.bfloat16, device_map="cuda",
    )
    if args.adapter and not args.no_lora:
        model = PeftModel.from_pretrained(model, str(args.adapter))
    model.eval()

    rows = [json.loads(l) for l in args.manifest.read_text(encoding="utf-8").splitlines() if l.strip()][:args.limit]
    exact_hits = total = 0
    f1_sum = 0.0
    with torch.inference_mode():
        for row in rows:
            n = len(row["labels"])
            prompt = (
                f"Query: {row['question']}\n"
                f"The image contains {n} red numbered text boxes. Output exactly {n} "
                "binary labels separated by spaces, in box-number order. 1 means "
                "relevant evidence and 0 means irrelevant. Output labels only."
            )
            convo = f"<image>\n{prompt}"
            img = Image.open(row["image"]).convert("RGB")
            input_ids, pixel_values, images_crop, seq_mask, spatial, _nt, _sh = processor.tokenize_with_images(
                conversation=convo, images=[img], bos=True, eos=True, cropping=False,
            )
            input_ids = input_ids.to(model.device)
            images = [(
                images_crop.to(model.device, dtype=torch.bfloat16),
                pixel_values.to(model.device, dtype=torch.bfloat16),
            )]
            seq_mask = seq_mask.unsqueeze(0).to(model.device)
            spatial = spatial.to(model.device)

            out_ids = model.generate(
                input_ids=input_ids,
                images=images,
                images_seq_mask=seq_mask,
                images_spatial_crop=spatial,
                max_new_tokens=args.max_new_tokens,
                temperature=0.0,
                do_sample=False,
                eos_token_id=tokenizer.eos_token_id,
                pad_token_id=tokenizer.pad_token_id,
                logits_processor=(
                    [ForceBinaryTokensProcessor(
                        prompt_length=input_ids.shape[1],
                        max_labels=n,
                        eos_id=tokenizer.eos_token_id,
                    )] if args.force_binary else None
                ),
            )
            gen_ids = out_ids[0, input_ids.shape[1]:]
            text = tokenizer.decode(gen_ids, skip_special_tokens=False)
            got = parse_output(text, n)
            gold = row["labels"]
            total += 1
            if got is None:
                print(f"[{row['id'][:8]}] NO LABELS in '{text[:60]}'")
                continue
            if got == gold:
                exact_hits += 1
            tp = sum(1 for g, p in zip(gold, got) if g == 1 and p == 1)
            fp = sum(1 for g, p in zip(gold, got) if g == 0 and p == 1)
            fn = sum(1 for g, p in zip(gold, got) if g == 1 and p == 0)
            prec = tp / (tp + fp) if tp + fp else 0.0
            rec = tp / (tp + fn) if tp + fn else 0.0
            f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
            f1_sum += f1
            status = "EXACT" if got == gold else f"got={got}"
            print(f"[{row['id'][:8]}] f1={f1:.2f} {status}")
    if total == 0:
        print("no rows evaluated")
        return
    print(f"\n== SUMMARY == exact={exact_hits}/{total} mean_f1={f1_sum/total:.3f}")


if __name__ == "__main__":
    main()