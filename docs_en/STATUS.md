[Chinese](../docs/STATUS.md) | English

# dsh-ocr1-memory Status Overview

Quick links: [README](../README.en.md) · [Implementation Notes](IMPLEMENTATION.md) · [Deployment Record](DEPLOYMENT.md) · [Benchmark](BENCHMARK.md) · [Test Report](TEST_REPORT.md)

## Current Status

| Item | Status |
|---|---|
| DSH plugin | ✅ Installable; registers OCR1 optical tools and governance tools |
| Basic memory pipeline | ✅ SoM rendering, age tiers, caching, OCR readback, verbatim Fetch |
| Locate-and-Transcribe | ✅ Strict K-bit locator pipeline; requires a compatible trained model |
| Active recall | ✅ Restores a fuzzy hit to vivid |
| Dynamic hit-heat decay | ✅ Implemented; `dynamicDecayEnabled` is disabled by default |
| Per-turn context | ✅ Enabled by default — injects L1/optical metadata; `contextMode: snapshot` keeps full-body snapshots |
| Visual embedding | ✅ Saves real vectors when `embeddingRetrieval` is enabled; primary retrieval is off by default |
| Shared store | ✅ Optional reload + atomic save |
| OCR server lifecycle | ✅ Endpoint deduplication, cancellable startup, and cleanup of plugin-owned processes only |
| Maintenance and cancellation | ✅ Maximum 8 entries per batch, namespace single-flight, disposal cancellation and drain |
| Governance integration | ✅ Runtime skill, L1 index, pending distillation, turn/end maintenance, threshold reminders, synced with the same OCR1 store instance |
| Tests | ✅ `npm test` 88/88 with the live backend available |

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
- `memory_read` / `memory_list` / `memory_write` / `memory_retrieve`
- `memory_search` / `memory_index` / `memory_pending` / `memory_accept`
- `memory_update` / `memory_archive` / `memory_rollback` / `memory_promote`
- `memory_stats` / `memory_maintain` / `memory_expand` / `memory_activate`

## Implemented Features

- Splits text by paragraph and length, then renders it as square images with SoM indices;
- Applies `vivid → normal → fuzzy` age decay, forcing regeneration and invalidating old OCR evidence when the resolution changes;
- Provides OCR readback and optional text/visual embedding recall; with `requireOcr=false` no-backend operation degrades safely, while strict mode reports failure;
- Provides request parsing, probabilistic selection, threshold/Top-K rules, and GBNF strict mode for the LoRA optical locator;
- Returns original verbatim text by segment index after Locate;
- Provides active recall, hit counts, bounded access history, and optional dynamic decay;
- Injects L1 index and optical metadata synchronously through `systemPrompt.context()` by default, with entry-count and character-count limits, without invoking the model inside the provider; `snapshot` mode still provides full-body snapshots;
- Provides a rendering cache, concurrency locks, an atomic manifest, multi-Agent sharing, and recovery from corrupted artifacts;
- Integrates the governance layer: namespaces, evidence, provenance, pending, archive, rollback, full-text search, and cross-namespace promotion; governance writes share the same OCR1 store instance.

## Test Coverage

| Suite | Count |
|---|---:|
| Core store tests | 12 |
| Context tests | 7 |
| Complex isolation tests T1–T24 | 24 |
| OCR HTTP | 2 |
| OCR server lifecycle | 4 |
| Embedding tests E1–E5 | 5 |
| Locator tests L1–L8 | 8 |
| Governance layer and cancellation signal tests | 13 |
| Integration wiring and automation tests | 2 |
| Rendering geometry RG1–RG2 | 2 |
| Robustness M1–M9 | 9 |
| **Total** | **88** |

Real OCR, embedding, and rendering depend on backend services and the Python environment; with the current live backend all 88 cases pass, while eight live-backend cases skip when it is unavailable and the remaining tests still run.

## Paper Reproduction Boundaries

The implementation provides engineering counterparts to OCR1/OCR-Memory: SoM, resolution decay, active recall, Locate-and-Transcribe, strict binary localization, optional embedding, dynamic decay, and context snapshots.

The following have not yet been fully reproduced:

1. DeepEncoder internal compression, per-layer visual-token counts, and internal tensor export;
2. Fully equivalent output from the official internal multimodal embedding;
3. Paper-scale training and complete main-table evaluations such as Mind2Web, AppWorld, and RULER;
4. Universal performance guarantees across arbitrary combinations of hardware, drivers, quantization, or service hosting.

These items require different levels of model-internal access, data/evaluation resources, or platform conditions; the current small-scale end-to-end validation should not be described as a reproduction of the paper's main tables. The current local evidence covers an end-to-end Windows CPU-only `llama-server` path; without a live backend, eight live-backend cases are skipped rather than treated as passing. For platform details and the validated model-conversion path, see [DEPLOYMENT.md](DEPLOYMENT.md).