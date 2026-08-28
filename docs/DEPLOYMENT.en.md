[简体中文](DEPLOYMENT.md) | English

# Deployment Notes

This document contains platform-specific backend, model-conversion, and validation guidance. It is not a compatibility guarantee for every machine.

## Backend contract

The plugin is backend-agnostic and expects OpenAI-compatible endpoints:

- `/v1/chat/completions` for OCR read-back or K-bit locating;
- `/v1/embeddings` for optional multimodal visual embeddings.

vLLM, llama.cpp, or another compatible multimodal server can provide them. Strict locating additionally needs output constraints compatible with the locator grammar.

## Starting a server

The repository includes:

```text
node scripts/ensure-ocr-server.mjs <port>
powershell -File scripts/start-ocr-server.ps1
```

Provide the model directory and executable through `ocrModelDir`, `ocrServerPath`, `OCR_MODEL_DIR`, `OCR_SERVER_PATH`, or PATH. The repository contains no machine-specific absolute paths. If the server is down and no model directory is available, startup fails with an explicit error.

A combined llama.cpp server may expose chat and embeddings from one process. When using a separate embedding process, configure its endpoint and lifecycle independently. The physical batch limit must be large enough for one rendered image's visual-token count.

## Locator model chain

1. Build SoM images and binary labels with `prepare_hotpotqa_locator.py`.
2. Train a decoder LoRA with `train_locator_unsloth.py`.
3. Evaluate base and adapter models with `eval_locator.py`.
4. Validate image/prompt/label alignment with `verify_collator_alignment.py`.
5. Merge and convert the adapter for the target runtime.
6. Enable `opticalLocatorEnabled` and verify Locate → verbatim Fetch end to end.

Image layout, the pre-image newline, spaced `0/1` grammar, stopping rules, and GBNF constraints are part of the protocol and must remain consistent between training and inference.

Local validation completed the LoRA and merged-model path, but small-scale results are not paper-scale reproduction. Aggressive low-bit quantization can erase small locator improvements; re-run the complete locator evaluation before release.

## Visual embeddings

llama.cpp multimodal embedding requests use the server's current media marker and raw base64 image data. The plugin records dimensions, image identity, and endpoint-level visual-token usage. A re-render invalidates the old embedding.

`embeddingRetrieval` remains off by default. Enable it only after measuring cross-modal discrimination on the target model and data.

## Known boundaries

- Native Windows and Linux/WSL llama.cpp services can both provide compatible endpoints, but builds, drivers, model formats, and supervisors differ.
- Some host sandboxes clean up child processes after a command returns. Use DSH detached lifecycle management or an approved service supervisor rather than diagnosing every process exit as model corruption.
- AMD/ROCm can support parts of the transformers and LoRA workflow; access to DeepEncoder internals depends on model code and hooks, not only GPU vendor.
- The llama.cpp public HTTP API does not expose DeepEncoder internal tensors or layer-wise visual tokens.
- Paper-scale datasets and Mind2Web/AppWorld/RULER evaluations require additional compute, time, and data.

## Validation checklist

1. backend health and multimodal requests;
2. SoM rendering and missing-image recovery;
3. OCR read-back and token usage;
4. embedding dimensions and failure fallback;
5. strict K-bit locator output;
6. deterministic verbatim Fetch;
7. shared stores, active recall, dynamic decay, and context snapshots;
8. the complete `npm test` suite.
