[简体中文](README.md) | English

# @dsh-external/dsh-ocr1-memory

A DSH optical-memory plugin inspired by **DeepSeek-OCR: Contexts Optical Compression** (OCR1).

> This is a DSH plugin, not an agent skill; the repository does not need `SKILL.md`.

Text memories are split into paragraphs and rendered as SoM-numbered images. Older memories move through lower-resolution tiers; retrieval can use an optical locator to select relevant segments and then return the original verbatim text deterministically. This preserves the optical path without generative paraphrase.

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
4. Fetch reads the selected segments from persisted source text; it does not generate replacement text.
5. Visual embeddings, hit-frequency decay, and per-turn context injection are optional.

## Configuration

Override the needed options in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-ocr1-memory
  config:
    storeDir: ''
    ocrBaseUrl: ''                 # OpenAI-compatible /v1/chat/completions; empty keeps text-only paths available
    ocrApiKey: ''
    ocrModel: 'deepseek-ai/DeepSeek-OCR'
    requireOcr: false
    opticalLocatorEnabled: false   # requires a trained locator model
    opticalLocatorBaseUrl: ''
    opticalLocatorModel: 'deepseek-ocr-memory'
    opticalLocatorThreshold: 0.4
    opticalLocatorTopK: 5
    dynamicDecayEnabled: false     # slow tier decay from recent hit frequency; opt-in for compatibility
    autoInjectContext: false       # add a bounded memory snapshot on each prompt assembly; opt-in
    contextMaxEntries: 5
    contextMaxChars: 4000
    sharedStore: false
    embeddingRetrieval: false      # visual-embedding retrieval; off by default
```

Advanced renderer, server-lifecycle, embedding, and strict-locator options are documented in [docs/IMPLEMENTATION.en.md](docs/IMPLEMENTATION.en.md).

## Installation

```bash
dsh plugin --profile web add github:DDDFXYqiming/dsh-ocr1-memory
```

## OCR backend

The plugin uses OpenAI-compatible endpoints:

- `/v1/chat/completions` for OCR read-back and optical locating;
- `/v1/embeddings` for optional multimodal visual embeddings.

Set `ocrBaseUrl` to a compatible service to enable OCR. Without it, the text-based memory path remains available. Backend startup, model formats, and platform notes are in [docs/DEPLOYMENT.en.md](docs/DEPLOYMENT.en.md).

## Reproduction scope

This is an engineering implementation of OCR1 and OCR-Memory ideas, not a claim to reproduce their internal model mechanisms or paper-scale tables:

- ✅ SoM, age-aware resolution, active recall, Locate-and-Transcribe, and strict K-bit locating;
- ✅ optional real visual embeddings, hit-frequency decay, and DSH `systemPrompt.context()` snapshots;
- ⚠️ DeepEncoder internal tensors/layer-wise visual tokens, official internal embeddings, and paper-scale evaluation are not fully reproduced here.

See [docs/IMPLEMENTATION.en.md](docs/IMPLEMENTATION.en.md) for the architecture, training/deployment chain, and reproduction matrix.

## Documentation

- [IMPLEMENTATION](docs/IMPLEMENTATION.en.md): architecture and paper-reproduction matrix;
- [DEPLOYMENT](docs/DEPLOYMENT.en.md): backend deployment and validation notes;
- [STATUS](docs/STATUS.md): implementation status and boundaries;
- [BENCHMARK](docs/BENCHMARK.md): isolated comparison with `dsh-memory`;
- [EXPLORATION](docs/EXPLORATION.md): research and experiment notes;
- [TEST_SPEC](docs/TEST_SPEC.md) / [TEST_REPORT](docs/TEST_REPORT.md): testing documentation.

## References

- [DeepSeek-OCR](https://github.com/deepseek-ai/DeepSeek-OCR) · [paper](https://arxiv.org/abs/2510.18234)
- [OCR-Memory](https://arxiv.org/abs/2604.26622)
- [AgentOCR](https://github.com/langfengQ/AgentOCR)
