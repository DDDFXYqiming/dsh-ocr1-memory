[Chinese](../docs/DEPLOYMENT.md) | English

# Deployment Notes

This document contains platform-specific backend, model-conversion, and validation guidance. It is not a compatibility guarantee for every machine.

For quick configuration, see [README.en.md](../README.en.md); for the general architecture, see [IMPLEMENTATION.md](IMPLEMENTATION.md).

## 1. Backend contract

The plugin is backend-agnostic and expects OpenAI-compatible endpoints:

- `/v1/chat/completions` for OCR read-back or K-bit locating;
- `/v1/embeddings` for optional multimodal visual embeddings.

vLLM, llama.cpp, or another compatible multimodal server can provide them. Strict locating additionally needs output constraints compatible with the locator grammar.

A combined llama.cpp server may expose chat and embeddings from one process. When using a separate embedding process, configure its endpoint and lifecycle independently. The physical batch limit must be large enough for one rendered image's visual-token count.

## 2. Starting a server

The repository includes:

```text
node scripts/ensure-ocr-server.mjs <port>
powershell -File scripts/start-ocr-server.ps1
```

Provide the model directory and executable through `ocrModelDir`, `ocrServerPath`, `OCR_MODEL_DIR`, `OCR_SERVER_PATH`, or PATH. The repository contains no machine-specific absolute paths. If the server is down and no model directory is available, startup fails with an explicit error.

A typical CPU-only profile (replace paths) is:

```yaml
ocrBaseUrl: 'http://127.0.0.1:18080/v1'
ocrEmbeddingBaseUrl: 'http://127.0.0.1:18080/v1' # combined chat + embeddings
requireOcr: true
autoStartOcrServer: true
ocrServerPath: 'D:/models/llama.cpp-cpu/llama-server.exe'
ocrModelDir: 'D:/models/deepseek-ocr-gguf'
ocrServerPort: 18080
embeddingRetrieval: false
```

Check `/health` or `/props` independently before putting the server's `/v1` address into `ocrBaseUrl`. With combined mode, use the same address for `ocrEmbeddingBaseUrl`, or leave it empty so the plugin falls back to the OCR endpoint. An explicit port in the endpoint URL is authoritative for both launch and health checks. Concurrent starts for one endpoint share one startup task, and cancellation, failed startup, or plugin disposal drains plugin-owned processes without stopping an already-running external server. With `requireOcr: false`, an unavailable OCR backend preserves the text path; `true` reports OCR read-back failure.

## 3. Locator model chain

1. Build SoM images and binary labels with `prepare_hotpotqa_locator.py`.
2. Train a decoder LoRA with `train_locator_unsloth.py`.
3. Evaluate base and adapter models with `eval_locator.py`.
4. Validate image/prompt/label alignment with `verify_collator_alignment.py`.
5. Merge and convert the adapter for the target runtime.
6. Enable `opticalLocatorEnabled` and verify Locate → verbatim Fetch end to end.

Image layout, the pre-image newline, spaced `0/1` grammar, stopping rules, and GBNF constraints are part of the protocol and must remain consistent between training and inference.

Local validation completed the LoRA and merged-model path, but small-scale results are not paper-scale reproduction. Aggressive low-bit quantization can erase small locator improvements; re-run the complete locator evaluation before release.

## 4. Visual embeddings

llama.cpp multimodal embedding requests use the server's current media marker and raw base64 image data. The plugin records dimensions, image identity, and endpoint-level visual-token usage. A re-render invalidates the old embedding.

`embeddingRetrieval` remains off by default. Merely configuring `ocrEmbeddingBaseUrl` does not generate vectors for every stored memory; persistent vectors and embedding-based ranking are enabled only when `embeddingRetrieval: true`. The diagnostic `ocr1_mem_embed_test` can probe a configured embedding client independently. Enable retrieval only after measuring cross-modal discrimination on the target model and data.

When OCR and embeddings share an endpoint, the plugin reuses one server. A separate embedding endpoint can start on demand and stop after `ocrEmbeddingIdleTimeoutMs`; `ocrEmbeddingAutoStart` starts it at plugin load.

## 5. Known boundaries

- Native Windows and Linux/WSL llama.cpp services can both provide compatible endpoints, but builds, drivers, model formats, and supervisors differ.
- Some host sandboxes clean up child processes after a command returns. Use DSH detached lifecycle management or an approved service supervisor rather than diagnosing every process exit as model corruption.
- AMD/ROCm can support parts of the transformers and LoRA workflow; access to DeepEncoder internals depends on model code and hooks, not only GPU vendor.
- The llama.cpp public HTTP API does not expose DeepEncoder internal tensors or layer-wise visual tokens.
- Paper-scale datasets and Mind2Web/AppWorld/RULER evaluations require additional compute, time, and data.

## 6. Running without a discrete GPU

The memory system itself does not require a discrete GPU. The plugin logic, JSON persistence, tier management, synchronous context snapshots, and Python/Pillow rendering can run on the CPU. OCR, locating, and visual embeddings are supplied by an external llama.cpp or vLLM service.

The locally validated runtime uses a Windows CPU-only llama.cpp server for both OCR and embeddings, without using the RX 7800 XT. LoRA training is a separate development workflow: it can use a GPU, but normal deployment of a merged model and day-to-day memory operations do not require retraining.

With no OCR backend and `requireOcr=false`, the text-memory path remains available. OCR, locating, and visual embeddings require their corresponding service.

An integrated GPU is optional rather than required. A llama.cpp build with Vulkan may use an iGPU, but the complete plugin chain has been validated on CPU-only, not independently on the iGPU. To guarantee no discrete-GPU use, point `OCR_SERVER_PATH` or `ocrServerPath` to a CPU-only `llama-server`; PATH resolution alone does not select CPU, iGPU, or dGPU.

This describes the hardware dependency of the OCR1 memory service only. Other DSH agent models may have independent GPU requirements.

## 7. Validation checklist

1. backend health and multimodal requests;
2. SoM rendering and missing-image recovery;
3. OCR read-back and token usage;
4. `requireOcr` strict behavior and text fallback boundaries;
5. embedding dimensions, on-demand startup, and failure fallback;
6. strict K-bit locator output;
7. deterministic verbatim Fetch;
8. shared stores, active recall, dynamic decay, and context snapshots;
9. `memory_maintain` batching, remaining-work, cancellation, and duplicate-call behavior;
10. the complete `npm test` suite.

Detailed scenarios are documented in [TEST_SPEC.md](TEST_SPEC.md) and [TEST_REPORT.md](TEST_REPORT.md).
