[简体中文](README.md) | English

# @dsh-external/dsh-ocr1-memory

A DSH optical-memory plugin inspired by **DeepSeek-OCR: Contexts Optical Compression** (OCR1).

Text memories are split into paragraphs and rendered as SoM-numbered images. Older memories move through lower-resolution tiers; retrieval defaults to text/OCR evidence, can optionally use an optical locator to select relevant segments, and then returns the original verbatim text deterministically.

## Capabilities

| Tool | Purpose |
|---|---|
| `ocr1_mem_status` | Inspect storage, renderer, and OCR status |
| `ocr1_mem_store` | Segment, render, and store a memory |
| `ocr1_mem_update` | Replace a memory and reset its freshness |
| `ocr1_mem_retrieve` | Retrieve, OCR read back, and active-recall memories |
| `ocr1_mem_list` | List entries and hit counts |
| `ocr1_mem_metrics` | Inspect text/visual tokens and compression ratios |
| `ocr1_mem_calibrate` | Calibrate the text-token baseline |
| `ocr1_mem_forget` | Delete a memory and its optical artifacts |
| `ocr1_mem_render_test` | Test the rendering pipeline |
| `ocr1_mem_embed_test` | Test visual embeddings |
| `memory_read` / `memory_retrieve` | Read governed memory and use OCR1-backed retrieval |
| `memory_write` / `memory_update` | Evidence-backed writes and updates |
| `memory_search` / `memory_promote` | Full-text search and cross-namespace promotion |
| `memory_pending` / `memory_accept` | Review and accept distilled candidates |
| `memory_maintain` / `memory_stats` | Deduplicate, compact L1, and inspect state |
| `memory_index` / `memory_archive` / `memory_rollback` | Rebuild the index, archive, and restore history |
| `memory_expand` / `memory_activate` | Expand DSH provenance events and activate governance |

## How it works

1. Text is split by paragraphs and length, then rendered into SoM images.
2. `vivid → normal → fuzzy` resolution tiers decay with age; a low-resolution hit triggers active recall.
3. Retrieval uses text overlap and optional OCR evidence by default. With an optical locator configured, the model emits K-bit `0/1` labels and the plugin selects segments using threshold and Top-K rules.
4. Fetch reads the selected segments from persisted source text and returns them verbatim.
5. Visual embeddings and hit-frequency decay are optional; per-turn context injection is enabled by default, with `index` mode for L1/optical metadata and `snapshot` mode for body snapshots.
6. Governance tools share the same plugin instance; maintenance is bounded by `maintenanceBatchSize`, cancellable, single-flight per namespace, and drained on disposal.

## Configuration

Override the needed options in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-ocr1-memory
  config:
    storeDir: ''
    memoryDir: '~/.dsh/memory'
    maxIndexLines: 30
    autoNamespace: true
    autoPending: true
    maintainEveryTurns: 20
    maintenanceBatchSize: 8 # maximum optical entries processed per maintenance call

    # OCR / llama-server
    ocrBaseUrl: ''
    ocrApiKey: ''
    ocrModel: 'deepseek-ai/DeepSeek-OCR'
    requireOcr: false # true = fail when OCR is unavailable; no silent text fallback
    autoStartOcrServer: false
    ocrServerPath: '' # or OCR_SERVER_PATH / llama-server on PATH
    ocrModelDir: ''
    ocrServerPort: 18080

    # Optical locator
    opticalLocatorEnabled: false
    opticalLocatorBaseUrl: ''
    opticalLocatorModel: 'deepseek-ocr-memory'
    opticalLocatorThreshold: 0.4
    opticalLocatorTopK: 5
    opticalLocatorStrict: true

    # Context / retrieval
    dynamicDecayEnabled: false
    autoInjectContext: true
    contextMode: 'index' # 'snapshot' keeps full-body memory snapshots
    contextMaxEntries: 5
    contextMaxChars: 4000
    sharedStore: false
    embeddingRetrieval: false
    ocrMaxEntriesPerRetrieve: 5
```

For a locally managed CPU `llama-server`, set `autoStartOcrServer: true` and provide both `ocrServerPath` and `ocrModelDir`. An explicit port in `ocrBaseUrl` is authoritative for health checks and launch. Embedding retrieval is disabled by default; leave `ocrEmbeddingBaseUrl` empty to reuse the OCR endpoint.

Advanced options are documented in [docs_en/IMPLEMENTATION.md](docs_en/IMPLEMENTATION.md).

## Installation

```bash
dsh plugin --profile web add github:DDDFXYqiming/dsh-ocr1-memory
```

## OCR backend

The plugin uses OpenAI-compatible endpoints (the official llama.cpp server documentation lists `/v1/chat/completions`, `/v1/embeddings`, and multimodal input):

- `/v1/chat/completions` for OCR read-back and optical locating;
- `/v1/embeddings` for optional multimodal visual embeddings.

Set `ocrBaseUrl` to use OCR. With `requireOcr: false`, an unavailable backend preserves the text path; with `requireOcr: true`, OCR errors are reported directly. With `autoStartOcrServer`, the plugin deduplicates startup by endpoint and only cleans up processes it started itself. Backend startup, CPU-only configuration, model formats, and platform notes are in [docs_en/DEPLOYMENT.md](docs_en/DEPLOYMENT.md).

## Documentation

- [WORKFLOW](docs_en/OPTICAL_MEMORY_WORKFLOW.md): workflow diagrams;
- [IMPLEMENTATION](docs_en/IMPLEMENTATION.md): architecture and implementation notes;
- [DEPLOYMENT](docs_en/DEPLOYMENT.md): backend deployment and validation;
- [STATUS](docs_en/STATUS.md): current implementation status;
- [BENCHMARK](docs_en/BENCHMARK.md): isolated comparison with `dsh-memory`;
- [EXPLORATION](docs_en/EXPLORATION.md): research and experiment notes;
- [TEST_SPEC](docs_en/TEST_SPEC.md) / [TEST_REPORT](docs_en/TEST_REPORT.md): testing documentation; the current `npm test` run is 88/88 when the live backend is available (real-backend cases skip otherwise).
- [PAPER_MAPPING](docs/2510.18234-paper-vs-plugin-verifiable-concepts.md): paper-native mechanisms versus engineering extensions.

## References

- [DeepSeek-OCR](https://github.com/deepseek-ai/DeepSeek-OCR) · [paper](https://arxiv.org/abs/2510.18234)
- [OCR-Memory](https://arxiv.org/abs/2604.26622)
- [AgentOCR](https://github.com/langfengQ/AgentOCR)
