#!/usr/bin/env python3
"""Train the OCR-Memory listwise optical locator with DeepSeek-OCR LoRA.

Fidelity notes:
- The OCR-Memory paper trains a decoder LoRA on DeepSeek-OCR to output a
  0/1 relevance vector over Set-of-Mark segments. Its code is not released
  and the exact prompt/serialization are undisclosed, so this trainer:
    * reuses the official DeepSeek-OCR input pipeline by importing the vLLM
      DeepseekOCRProcessor (Apache-2.0, see scripts/vllm_processors/);
    * supervises only the standalone 0/1 label tokens (tokenizer ids 18/19)
      with a positive:negative weighted binary loss (paper uses positive=2);
    * applies the paper resolution curriculum (30% 1024x1024, 70% 512x512);
    * freezes the vision encoder and trains q/k/v/o LoRA r=16, alpha=32,
      dropout=0.05.
- --load-in-4bit (QLoRA) is an explicit hardware adaptation for 16GB Radeon
  and differs from the paper's unquantized LoRA training.

Verified on this host (2026-08-28):
  tokenizer: "0"=18, "1"=19 (single tokens), "<image>"=128815,
  bos=0, eos=1, pad=2.
  vLLM DeepseekOCRProcessor.tokenize_with_images(bos=True, eos=True,
  cropping=False) -> input_ids (1,N), pixel_values (1,3,1024,1024),
  images_crop (0,3,640,640), images_seq_mask (N,), spatial (1,2).
  eos is appended inside and then stripped before return.

Usage:
  python scripts/train_locator_unsloth.py \
      --manifest data/smoke/train.jsonl --output data/smoke/out \
      --load-in-4bit --max-steps 3 --batch-size 1
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

PROCESSOR_DIR = Path(__file__).resolve().parent / "vllm_processors"
sys.path.insert(0, str(PROCESSOR_DIR))

import torch
import torch.nn.functional as F  # noqa: F401
from PIL import Image


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--manifest", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    p.add_argument("--model", default="unsloth/DeepSeek-OCR")
    p.add_argument("--epochs", type=float, default=3.0)
    p.add_argument("--max-steps", type=int, default=-1)
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--batch-size", type=int, default=1)
    p.add_argument("--global-batch-size", type=int, default=128)
    p.add_argument("--learning-rate", type=float, default=1e-5)
    p.add_argument("--positive-weight", type=float, default=4.0,
                   help="BCE positive-class weight; HotpotQA 2+/8- balance => 4")
    p.add_argument("--max-seq-length", type=int, default=2048)
    p.add_argument("--load-in-4bit", action="store_true")
    p.add_argument("--probe-grad", action="store_true",
                   help="print supervised logits before/after first steps (debug)")
    p.add_argument("--resume-from-checkpoint", default=None)
    return p.parse_args()


class LocatorDataset(torch.utils.data.Dataset):
    def __init__(self, records, low_resolution_probability=0.7, seed=42):
        self.records = records
        self.low_probability = low_resolution_probability
        self.rng = random.Random(seed)

    def __len__(self):
        return len(self.records)

    def prompt_for(self, row):
        count = len(row["labels"])
        return (
            f"Query: {row['question']}\n"
            f"The image contains {count} red numbered text boxes. Output exactly "
            f"{count} binary labels separated by spaces, in box-number order. "
            "1 means relevant evidence and 0 means irrelevant. Output labels only."
        )

    def __getitem__(self, index):
        row = self.records[index]
        image = Image.open(row["image"]).convert("RGB")
        if self.rng.random() < self.low_probability:
            image = image.resize((512, 512), Image.Resampling.BICUBIC)
        else:
            image = image.resize((1024, 1024), Image.Resampling.BICUBIC)
        return {
            "image": image,
            "prompt": self.prompt_for(row),
            "target": row["target"],          # e.g. "1 0"
            "labels": row["labels"],          # e.g. [1, 0]
        }


class LocatorCollator:
    """Convert dataset items into DeepSeek-OCR training tensors.

    Supervised positions = standalone 0/1 tokenizer ids (18/19) strictly
    inside the target vector. Prompt digits, image tokens, spaces and EOS are
    masked with -100. Generation termination is enforced by the eval grammar.
    """

    def __init__(self, tokenizer, processor):
        self.tokenizer = tokenizer
        self.processor = processor  # DeepseekOCRProcessor
        self.zero_id = tokenizer.encode("0", add_special_tokens=False)[0]
        self.one_id = tokenizer.encode("1", add_special_tokens=False)[0]
        assert self.zero_id != self.one_id

    def __call__(self, batch):
        input_ids_all, labels_all, mask_all = [], [], []
        pixel_all, crop_all, spatial_all = [], [], []

        for item in batch:
            image = item["image"]
            conversation = f"<image>\n{item['prompt']}{item['target']}"
            out = self.processor.process_one(
                prompt=conversation,
                images=[image],
                crop_mode=False,
            )
            input_ids = out["input_ids"]          # (1, N) int64
            seq_mask = out["images_seq_mask"]     # (N,) bool (True=image)
            pixel_values = out["pixel_values"]    # (1,3,1024,1024)
            images_crop = out["images_crop"]      # (0,3,640,640)
            spatial = out["images_spatial_crop"]  # (1,2)
            num_img_tokens = int((seq_mask == True).sum().item())  # noqa: E712

            # Target start = after image token block + prompt text tokens.
            # The conversation is "<image>\n" + prompt + target: the "\n" is part
            # of the prompt text inside process_one, so encode it with the prompt.
            prompt_ids = self.tokenizer.encode("\n" + item["prompt"], add_special_tokens=False)
            image_block_len = num_img_tokens
            target_start = 1 + image_block_len + len(prompt_ids)
            target_ids = self.tokenizer.encode(item["target"], add_special_tokens=False)
            target_end = target_start + len(target_ids)

            labels = input_ids.clone()
            labels.fill_(-100)
            for i in range(target_start, target_end):
                tok_id = input_ids[0, i].item()
                if tok_id == self.zero_id or tok_id == self.one_id:
                    labels[0, i] = tok_id

            # EOS not supervised; append as stopping signal only.
            input_ids = torch.cat([input_ids, torch.tensor([[self.processor.eos_id]], dtype=torch.long)], dim=-1)
            labels = torch.cat([labels, torch.tensor([[-100]], dtype=torch.long)], dim=-1)
            seq_mask = torch.cat([seq_mask.unsqueeze(0), torch.tensor([[False]], dtype=torch.bool)], dim=-1)

            input_ids_all.append(input_ids)
            labels_all.append(labels)
            mask_all.append(seq_mask)
            pixel_all.append(pixel_values)
            crop_all.append(images_crop)
            spatial_all.append(spatial)

        # pad
        max_len = max(x.shape[1] for x in input_ids_all)
        pad_id = self.processor.pad_id if self.processor.pad_id is not None else 0
        B = len(batch)
        input_ids = torch.full((B, max_len), pad_id, dtype=torch.long)
        labels = torch.full((B, max_len), -100, dtype=torch.long)
        mask = torch.zeros((B, max_len), dtype=torch.bool)
        for i, (ids, lbs, ms) in enumerate(zip(input_ids_all, labels_all, mask_all)):
            l = ids.shape[1]
            input_ids[i, :l] = ids[0]
            labels[i, :l] = lbs[0]
            mask[i, :l] = ms[0]

        pixel_values = pixel_all[0] if len(pixel_all) == 1 else torch.cat(pixel_all, dim=0)
        images_crop = crop_all[0] if len(crop_all) == 1 else torch.cat(crop_all, dim=0)
        spatial = spatial_all[0] if len(spatial_all) == 1 else spatial_all[0].expand(len(batch), -1)

        attention_mask = input_ids.ne(pad_id).long()
        # Official HF modeling expects images=[(patches, global_view), ...].
        # With cropping=False, patches is empty -> a zero tensor of the crop
        # shape, global_view is the 1024x1024 normalized image.
        patches_per = crop_all[0] if len(crop_all) == 1 and crop_all[0].ndim == 4 else torch.zeros((0, 3, self.processor.image_size, self.processor.image_size))
        global_per = pixel_all[0] if len(pixel_all) == 1 else pixel_all[0]
        # Official HF modeling (line 430) evaluates images[0][1], so images must
        # be a list of (patches, global_view) PAIRS (same as model.generate in
        # the official infer/run code). With cropping=False patches is empty.
        images = [(patches_per, global_per)]
        return {
            "input_ids": input_ids,
            "labels": labels,
            "images": images,
            "images_crop": images_crop,
            "images_seq_mask": mask,
            "images_spatial_crop": torch.tensor([[1, 1]], dtype=torch.long),
            "attention_mask": attention_mask,
        }


class BinaryLocatorTrainer:
    """Weighted BCE only on the standalone 0/1 label positions."""

    def __init__(self, model, tokenizer, processor, batch_size=1, accumulate=128,
                 lr=1e-5, epochs=3.0, max_steps=-1, output=None, seed=42,
                 positive_weight=4.0):
        self.model = model
        self.tokenizer = tokenizer
        self.processor = processor
        self.batch_size = batch_size
        self.accumulate = max(1, accumulate)
        self.lr = lr
        self.epochs = epochs
        self.max_steps = max_steps if max_steps is not None and max_steps > 0 else None
        self.output = Path(output) if output else Path("data/out")
        self.zero_id = tokenizer.encode("0", add_special_tokens=False)[0]
        self.one_id = tokenizer.encode("1", add_special_tokens=False)[0]
        self.seed = seed
        self.positive_weight = float(positive_weight)

    def compute_loss(self, inputs):
        """Weighted binary CE over the 0/1 label token logits."""
        device = next(self.model.parameters()).device
        param_dtype = next(self.model.parameters()).dtype
        moved = {}
        for k, v in inputs.items():
            if k == "images":
                # list of (patches, global) pairs -> move each
                moved[k] = [
                    tuple(
                        (t.to(device=device, dtype=param_dtype) if t.is_floating_point() else t.to(device=device))
                        for t in pair
                    )
                    for pair in v
                ]
            elif not torch.is_tensor(v):
                moved[k] = v
            elif v.is_floating_point():
                moved[k] = v.to(device=device, dtype=param_dtype)
            else:
                moved[k] = v.to(device=device)
        inputs = moved
        labels = inputs.pop("labels")
        outputs = self.model(
            input_ids=inputs["input_ids"],
            attention_mask=inputs.get("attention_mask"),
            images=inputs["images"],
            images_seq_mask=inputs["images_seq_mask"],
            images_spatial_crop=inputs["images_spatial_crop"],
        )
        logits = outputs.logits[:, :-1, :]
        targets = labels[:, 1:]
        binary = (targets == self.zero_id) | (targets == self.one_id)
        if not torch.any(binary):
            raise RuntimeError("no supervised 0/1 label tokens in batch")
        pair_logits = torch.stack((logits[..., self.zero_id], logits[..., self.one_id]), dim=-1)
        binary_target = (targets == self.one_id).long()
        per_token = F.cross_entropy(
            pair_logits.reshape(-1, 2),
            binary_target.reshape(-1),
            reduction="none",
        ) .reshape_as(targets)
        weight = torch.where(binary_target == 1, self.positive_weight, 1.0).to(per_token.dtype)
        loss = (per_token * weight * binary).sum() / binary.sum().clamp_min(1)
        return loss

    def run(self, dataset):
        torch.manual_seed(self.seed)
        opt = torch.optim.AdamW(
            (p for p in self.model.parameters() if p.requires_grad),
            lr=self.lr, betas=(0.9, 0.95), weight_decay=0.1,
        )
        collator = LocatorCollator(self.tokenizer, self.processor)
        loader = torch.utils.data.DataLoader(
            dataset, batch_size=self.batch_size, shuffle=True,
            collate_fn=collator, num_workers=0,
        )
        total_steps = len(loader) if self.max_steps is None else self.max_steps
        self.model.train()
        step = 0
        micro = 0
        self.model.zero_grad()
        if getattr(self, "probe_grad", False):
            self._probe_supervised_logits(collator, counter="before")
        for epoch in range(int(self.epochs) + 1 if self.epochs % 1 else int(self.epochs)):
            if self.max_steps is not None and step >= self.max_steps:
                break
            for batch in loader:
                loss = self.compute_loss(batch)
                (loss / self.accumulate).backward()
                micro += 1
                if micro % self.accumulate == 0:
                    torch.nn.utils.clip_grad_norm_(self.model.parameters(), 1.0)
                    opt.step()
                    self.model.zero_grad()
                if step % 5 == 0:
                    print(f"[step {step}] loss={loss.item():.4f}", flush=True)
                if getattr(self, "probe_grad", False) and step == 1:
                    self._probe_supervised_logits(collator, counter="after-2-steps")
                step += 1
                if self.max_steps is not None and step >= self.max_steps:
                    break
        if micro % self.accumulate != 0:
            torch.nn.utils.clip_grad_norm_(self.model.parameters(), 1.0)
            opt.step()
        self.output.mkdir(parents=True, exist_ok=True)
        self.model.save_pretrained(str(self.output / "adapter"))
        self.tokenizer.save_pretrained(str(self.output / "adapter"))
        print(f"adapter saved to {self.output / 'adapter'}")

    def _probe_supervised_logits(self, collator, counter="?"):
        """Forward a fixed sample and report mean logits at supervised 0/1 pos."""
        import torch
        ds = self._probe_ds
        batch = collator([ds[0]])
        dev = next(self.model.parameters()).device
        pt = torch.bfloat16
        inputs = {}
        for k, v in batch.items():
            if k == "images":
                inputs[k] = [
                    tuple(a.to(dev, dtype=pt) if a.is_floating_point() else a.to(dev) for a in pair)
                    for pair in v
                ]
            elif isinstance(v, torch.Tensor):
                inputs[k] = v.to(dev, dtype=pt) if v.is_floating_point() else v.to(dev)
        labels = inputs.pop("labels")
        self.model.eval()
        with torch.inference_mode():
            out = self.model(input_ids=inputs["input_ids"], images=inputs["images"],
                             images_seq_mask=inputs["images_seq_mask"],
                             images_spatial_crop=inputs["images_spatial_crop"])
            logits = out.logits
        targets = labels[:, 1:]
        binary = (targets == 18) | (targets == 19)
        pair = torch.stack((logits[:, :-1, 18], logits[:, :-1, 19]), dim=-1)
        margin = pair[..., 1] - pair[..., 0]
        positive = targets == 19
        negative = targets == 18
        pos_margin = margin[positive].mean().item()
        neg_margin = (-margin[negative]).mean().item()
        print(
            f"[probe {counter}] labels={int(binary.sum())} "
            f"positive_margin(1>0)={pos_margin:+.4f} "
            f"negative_margin(0>1)={neg_margin:+.4f}",
            flush=True,
        )
        self.model.train()


def main():
    args = parse_args()
    # Unsloth must be imported before transformers to apply its memory patches.
    from unsloth import FastVisionModel
    from transformers import AutoModel, AutoTokenizer
    from deepseek_ocr import DeepseekOCRProcessor

    records = [json.loads(line) for line in args.manifest.read_text(encoding="utf-8").splitlines() if line.strip()]
    if args.limit > 0:
        records = records[:args.limit]
    if not records:
        raise SystemExit("manifest contains no training records")
    random.Random(args.seed).shuffle(records)
    dataset = LocatorDataset(records, low_resolution_probability=0.7, seed=args.seed)

    tokenizer = AutoTokenizer.from_pretrained(args.model, trust_remote_code=True)
    processor = DeepseekOCRProcessor(tokenizer)
    model, _ = FastVisionModel.from_pretrained(
        args.model,
        load_in_4bit=args.load_in_4bit,
        auto_model=AutoModel,
        trust_remote_code=True,
        use_gradient_checkpointing="unsloth",
    )
    model = FastVisionModel.get_peft_model(
        model,
        finetune_vision_layers=False,
        finetune_language_layers=True,
        finetune_attention_modules=True,
        finetune_mlp_modules=False,
        r=16, lora_alpha=32, lora_dropout=0.05,
        bias="none",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
        random_state=args.seed,
    )
    FastVisionModel.for_training(model)

    trainer = BinaryLocatorTrainer(
        model, tokenizer, processor,
        batch_size=args.batch_size,
        accumulate=max(1, args.global_batch_size // max(1, args.batch_size)),
        lr=args.learning_rate,
        epochs=args.epochs,
        max_steps=args.max_steps if args.max_steps > 0 else None,
        output=args.output,
        seed=args.seed,
        positive_weight=args.positive_weight,
    )
    trainer.probe_grad = args.probe_grad
    trainer._probe_ds = dataset
    trainer.run(dataset)

    (args.output).mkdir(parents=True, exist_ok=True)
    meta = {
        "paper": {
            "lora": {"r": 16, "alpha": 32, "dropout": 0.05,
                     "targets": ["q_proj", "k_proj", "v_proj", "o_proj"]},
            "positive_weight": args.positive_weight, "negative_weight": 1.0,
            "resolution_probability": {"1024": 0.3, "512": 0.7},
            "epochs": args.epochs, "learning_rate": args.learning_rate,
        },
        "hardware_adaptation": {"load_in_4bit": args.load_in_4bit},
        "records": len(records),
        "zero_token_id": trainer.zero_id, "one_token_id": trainer.one_id,
    }
    (args.output / "training-config.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()