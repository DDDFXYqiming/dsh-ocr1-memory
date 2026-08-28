[Chinese](../docs/STATUS.md) | English

# dsh-ocr1-memory Status Overview

Quick links: [README](../README.en.md) · [Implementation Notes](IMPLEMENTATION.md) · [Deployment Record](DEPLOYMENT.md) · [Benchmark](BENCHMARK.md) · [Test Report](TEST_REPORT.md)

## Current Status

| Item | Status |
|---|---|
| DSH plugin | ✅ Installable and registers the `ocr1_mem_*` tools |
| Basic memory pipeline | ✅ SoM rendering, age tiers, caching, OCR readback, verbatim Fetch |
| Locate-and-Transcribe | ✅ Strict K-bit locator pipeline; requires a compatible trained model |
| Active recall | ✅ Restores a fuzzy hit to vivid |
| Dynamic hit-heat decay | ✅ Implemented; `dynamicDecayEnabled` is disabled by default |
| Per-turn context snapshots | ✅ Implemented; `autoInjectContext` is disabled by default |
| Visual embedding | ✅ Can save real vectors; disabled by default for primary retrieval |
| Shared store | ✅ Optional reload + atomic save |
| Tests | ✅ `npm test` passes 70/70 |

## Tools

- `ocr1_mem_status`
- `ocr1_mem_store`
- `ocr1_mem_update`
- `ocr1_mem_retrieve`
- `ocr1_mem_list`
- `ocr1_mem_metrics`
- `ocr1_mem_calibrate`
- `ocr1_mem_forget`
- `ocr1_mem_render_test`
- `ocr1_mem_embed_test`

## Implemented Features

- Splits text by paragraph and length, then renders it as square images with SoM indices;
- Applies `vivid → normal → fuzzy` age decay, forcing regeneration and invalidating old OCR evidence when the resolution changes;
- Provides OCR readback, text/visual embedding recall, and safe degradation when no backend is available;
- Provides request parsing, probabilistic selection, threshold/Top-K rules, and GBNF strict mode for the LoRA optical locator;
- Returns original verbatim text by segment index after Locate;
- Provides active recall, hit counts, bounded access history, and optional dynamic decay;
- Injects synchronous snapshots through `systemPrompt.context()` with entry-count and character-count limits, without invoking the model inside the provider;
- Provides a rendering cache, concurrency locks, an atomic manifest, multi-Agent sharing, and recovery from corrupted artifacts;
- Provides namespace, evidence, provenance, pending, archive, and rollback in the layered governance adapter.

## Test Coverage

| Suite | Count |
|---|---:|
| Core and context unit tests | 14 |
| Complex isolated tests T1–T24 | 24 |
| OCR HTTP / rendering cache / service lifecycle | 4 |
| Embedding tests E1–E5 | 5 |
| Locator tests L1–L8 | 8 |
| Governance layer and cancellation signal tests | 7 |
| Rendering geometry RG1–RG2 | 2 |
| Robustness M1–M6 | 6 |
| **Total** | **70** |

Real OCR, embedding, and rendering depend on backend services and the Python environment; without a backend, the relevant tests should explicitly use mocks or follow the deployment checklist.

## Paper Reproduction Boundaries

The implementation provides engineering counterparts to OCR1/OCR-Memory: SoM, resolution decay, active recall, Locate-and-Transcribe, strict binary localization, optional embedding, dynamic decay, and context snapshots.

The following have not yet been fully reproduced:

1. DeepEncoder internal compression, per-layer visual-token counts, and internal tensor export;
2. Fully equivalent output from the official internal multimodal embedding;
3. Paper-scale training and complete main-table evaluations such as Mind2Web, AppWorld, and RULER;
4. Universal performance guarantees across arbitrary combinations of hardware, drivers, quantization, or service hosting.

These items require different levels of model-internal access, data/evaluation resources, or platform conditions; the current small-scale end-to-end validation should not be described as a reproduction of the paper's main tables. For platform details and the validated model-conversion path, see [DEPLOYMENT.md](DEPLOYMENT.md).
