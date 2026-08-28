[简体中文](README.md) | English

# @dsh-external/dsh-ocr1-memory

A DSH optical-memory plugin inspired by **DeepSeek-OCR: Contexts Optical Compression** (OCR1).

Text memories are split into paragraphs and rendered as SoM-numbered images. Older memories move through lower-resolution tiers; retrieval can use an optical locator to select relevant segments and then return the original verbatim text deterministically.

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

## How it works

1. Text is split by paragraphs and length, then rendered into SoM images.
2. `vivid → normal → fuzzy` resolution tiers decay with age; a low-resolution hit triggers active recall.
3. With an optical locator configured, the model emits K-bit `0/1` labels and the plugin selects segments using threshold and Top-K rules.
4. Fetch reads the selected segments from persisted source text and returns them verbatim.
5. Visual embeddings, hit-frequency decay, and per-turn context injection are optional.

## Configuration

Override the needed options in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-ocr1-memory
  config:
    storeDir: ''
    ocrBaseUrl: ''
    ocrApiKey: ''
    ocrModel: 'deepseek-ai/DeepSeek-OCR'
    requireOcr: false
    opticalLocatorEnabled: false
    opticalLocatorBaseUrl: ''
    opticalLocatorModel: 'deepseek-ocr-memory'
    opticalLocatorThreshold: 0.4
    opticalLocatorTopK: 5
    dynamicDecayEnabled: false
    autoInjectContext: false
    contextMaxEntries: 5
    contextMaxChars: 4000
    sharedStore: false
    embeddingRetrieval: false
```

Advanced options are documented in [docs_en/IMPLEMENTATION.md](docs_en/IMPLEMENTATION.md).

## Installation

```bash
dsh plugin --profile web add github:DDDFXYqiming/dsh-ocr1-memory
```

## OCR backend

The plugin uses OpenAI-compatible endpoints:

- `/v1/chat/completions` for OCR read-back and optical locating;
- `/v1/embeddings` for optional multimodal visual embeddings.

Set `ocrBaseUrl` to enable OCR. Backend startup, model formats, and platform notes are in [docs_en/DEPLOYMENT.md](docs_en/DEPLOYMENT.md).

## Documentation

- [WORKFLOW](docs_en/OPTICAL_MEMORY_WORKFLOW.md): workflow diagrams;
- [IMPLEMENTATION](docs_en/IMPLEMENTATION.md): architecture and implementation notes;
- [DEPLOYMENT](docs_en/DEPLOYMENT.md): backend deployment and validation;
- [STATUS](docs_en/STATUS.md): current implementation status;
- [BENCHMARK](docs_en/BENCHMARK.md): isolated comparison with `dsh-memory`;
- [EXPLORATION](docs_en/EXPLORATION.md): research and experiment notes;
- [TEST_SPEC](docs_en/TEST_SPEC.md) / [TEST_REPORT](docs_en/TEST_REPORT.md): testing documentation.

## References

- [DeepSeek-OCR](https://github.com/deepseek-ai/DeepSeek-OCR) · [paper](https://arxiv.org/abs/2510.18234)
- [OCR-Memory](https://arxiv.org/abs/2604.26622)
- [AgentOCR](https://github.com/langfengQ/AgentOCR)
