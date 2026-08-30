#!/usr/bin/env python3
"""Merge a DeepSeek-OCR PEFT locator adapter into a conversion-ready HF directory."""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

import torch
from peft import PeftModel
from safetensors.torch import load_file, save_file
from transformers import AutoModel, AutoTokenizer

POSITION_IDS = "model.vision_model.embeddings.position_ids"
REMOTE_FILES = (
    "modeling_deepseekocr.py",
    "deepencoder.py",
    "conversation.py",
    "configuration_deepseek_v2.py",
    "modeling_deepseekv2.py",
    "processor_config.json",
    "preprocessor_config.json",
)


def parse_args():
    parser = argparse.ArgumentParser()
    parser.add_argument("--adapter", type=Path, required=True)
    parser.add_argument("--base", required=True, help="local HF snapshot or repository id")
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


def strip_position_ids(output: Path):
    index_path = output / "model.safetensors.index.json"
    index = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else None
    shard_name = index.get("weight_map", {}).get(POSITION_IDS) if index else None
    candidates = [output / shard_name] if shard_name else list(output.glob("*.safetensors"))
    removed_bytes = 0
    for shard in candidates:
        if not shard or not shard.exists():
            continue
        tensors = load_file(str(shard), device="cpu")
        tensor = tensors.pop(POSITION_IDS, None)
        if tensor is None:
            continue
        removed_bytes += tensor.numel() * tensor.element_size()
        temporary = shard.with_suffix(shard.suffix + ".tmp")
        save_file(tensors, str(temporary), metadata={"format": "pt"})
        temporary.replace(shard)
    if index and POSITION_IDS in index.get("weight_map", {}):
        del index["weight_map"][POSITION_IDS]
        if removed_bytes and isinstance(index.get("metadata", {}).get("total_size"), int):
            index["metadata"]["total_size"] -= removed_bytes
        index_path.write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
    return removed_bytes


def copy_conversion_files(base: str, output: Path):
    base_path = Path(base)
    if not base_path.is_dir():
        return
    for name in REMOTE_FILES:
        source = base_path / name
        if source.exists():
            shutil.copy2(source, output / name)
    processor = output / "processor_config.json"
    preprocessor = output / "preprocessor_config.json"
    if processor.exists() and not preprocessor.exists():
        shutil.copy2(processor, preprocessor)


def main():
    args = parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    model = AutoModel.from_pretrained(
        args.base,
        trust_remote_code=True,
        torch_dtype=torch.bfloat16,
        device_map="cpu",
        low_cpu_mem_usage=True,
    )
    merged = PeftModel.from_pretrained(model, str(args.adapter)).merge_and_unload()
    merged.save_pretrained(args.output, safe_serialization=True)
    AutoTokenizer.from_pretrained(args.base, trust_remote_code=True).save_pretrained(args.output)
    copy_conversion_files(args.base, args.output)
    removed = strip_position_ids(args.output)
    print(json.dumps({
        "output": str(args.output.resolve()),
        "removedPositionIdsBytes": removed,
    }))


if __name__ == "__main__":
    main()
